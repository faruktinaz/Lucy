/**
 * Config migrations. Each migration upgrades the raw TOML table by exactly one version and
 * reports what it changed. Migrations run in memory on load; the file is rewritten in the
 * new format only when the user next saves a setting (after a backup).
 */
import type { TomlTable } from "smol-toml";
import { CONFIG_VERSION } from "./schema";
import { cloneValue, isPlainObject } from "./values";

export interface ConfigMigration {
  /** Version this migration reads. 0 means "no `version` key" (the pre-1 prototype format). */
  from: number;
  description: string;
  migrate(table: TomlTable): { table: TomlTable; notes: string[] };
}

function section(table: TomlTable, name: string): TomlTable {
  const existing = table[name];
  if (isPlainObject(existing)) return existing as TomlTable;
  const created: TomlTable = {};
  table[name] = created;
  return created;
}

/**
 * Moves a legacy value to its new home unless the new key is already set (the new spelling
 * wins, the legacy key is dropped either way so it is not reported as unknown).
 */
function move(table: TomlTable, legacyKey: string, target: [string, string], notes: string[]): void {
  if (!(legacyKey in table)) return;
  const value = table[legacyKey];
  delete table[legacyKey];
  if (value === undefined) return;
  const [sectionName, key] = target;
  const destination = section(table, sectionName);
  if (key in destination) {
    notes.push(`Dropped "${legacyKey}": "${sectionName}.${key}" is already set.`);
    return;
  }
  destination[key] = value;
  notes.push(`Moved "${legacyKey}" to "${sectionName}.${key}".`);
}

/**
 * The prototype format (before `version` existed) had flat top-level keys, a `[keys]` table and
 * a `[claude]` table:
 *
 *   theme = "tokyo-night"       -> [ui] theme
 *   icons = "nerd"              -> [ui] icons
 *   sidebar = "right"           -> [layout] sidebar_side
 *   line_numbers = false        -> [editor] line_numbers
 *   editor = "nvim"             -> [editor] external   (the key became a table in v1)
 *   [keys]                      -> [keybindings.bindings]
 *   [claude] path, args         -> [ai] executable, args
 *
 * A file without `version` that already uses the v1 layout passes through unchanged.
 */
const prototypeToV1: ConfigMigration = {
  from: 0,
  description: "Prototype format to version 1",
  migrate(input) {
    const table = cloneValue(input);
    const notes: string[] = [];
    if (typeof table.editor === "string" || Array.isArray(table.editor)) {
      const external = table.editor;
      delete table.editor;
      section(table, "editor").external = external;
      notes.push('Moved "editor" to "editor.external".');
    }
    move(table, "theme", ["ui", "theme"], notes);
    move(table, "icons", ["ui", "icons"], notes);
    move(table, "sidebar", ["layout", "sidebar_side"], notes);
    move(table, "line_numbers", ["editor", "line_numbers"], notes);
    if (isPlainObject(table.keys)) {
      const keys = table.keys as TomlTable;
      delete table.keys;
      const keybindings = section(table, "keybindings");
      const bindings = isPlainObject(keybindings.bindings) ? (keybindings.bindings as TomlTable) : {};
      keybindings.bindings = { ...keys, ...bindings };
      notes.push('Moved "[keys]" to "[keybindings.bindings]".');
    }
    if (isPlainObject(table.claude)) {
      const claude = { ...(table.claude as TomlTable) };
      delete table.claude;
      const aiTable = section(table, "ai");
      for (const [legacy, key] of [
        ["path", "executable"],
        ["args", "args"],
      ] as const) {
        if (!(legacy in claude)) continue;
        if (key in aiTable) {
          notes.push(`Dropped "claude.${legacy}": "ai.${key}" is already set.`);
        } else {
          aiTable[key] = claude[legacy] as TomlTable[string];
          notes.push(`Moved "claude.${legacy}" to "ai.${key}".`);
        }
        delete claude[legacy];
      }
      // Anything else under [claude] is kept so the unknown-key warning can point at it.
      if (Object.keys(claude).length > 0) table.claude = claude;
    }
    return { table, notes };
  },
};

export const CONFIG_MIGRATIONS: readonly ConfigMigration[] = [prototypeToV1];

export interface MigrationResult {
  table: TomlTable;
  /** Version reached (CONFIG_VERSION unless a step is missing). */
  version: number;
  notes: string[];
  applied: string[];
}

/** Runs every migration from `fromVersion` up to the current version. */
export function migrateConfig(
  table: TomlTable,
  fromVersion: number,
  migrations: readonly ConfigMigration[] = CONFIG_MIGRATIONS,
  targetVersion: number = CONFIG_VERSION,
): MigrationResult {
  let current = { ...table };
  let version = fromVersion;
  const notes: string[] = [];
  const applied: string[] = [];
  while (version < targetVersion) {
    const step = migrations.find((m) => m.from === version);
    if (!step) break;
    const result = step.migrate(current);
    current = result.table;
    notes.push(...result.notes);
    applied.push(step.description);
    version = step.from + 1;
  }
  current.version = version;
  return { table: current, version, notes, applied };
}
