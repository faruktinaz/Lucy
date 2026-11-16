/**
 * Saving `config.toml`.
 *
 * - Only settings that differ from their defaults are written, under a header that explains
 *   the file, so the file stays short and future default changes reach the user.
 * - Unknown keys (typos, settings from a newer Lucy) are preserved by patching the raw
 *   table that was loaded instead of serializing the typed config alone.
 * - Comments are NOT preserved: smol-toml does not round-trip them. The header says so, and
 *   the previous file is always backed up first.
 * - The previous file is copied to `config.toml.bak` and to a timestamped file in
 *   `backups/` (the newest few are kept). A file that does not parse is additionally kept as
 *   `config.toml.broken-<timestamp>`, which is never pruned.
 * - The write itself is atomic (temp file + rename).
 * - Permissions: settings can hold paths and command-line arguments, so a new `config.toml` is
 *   created 0600 (an existing one keeps its mode: it may be a dotfile-managed link target the
 *   user set up), every backup is written 0600 whatever its previous mode, and directories Lucy
 *   creates are 0700.
 */
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { stringify, type TomlTable } from "smol-toml";
import { fromFsError } from "../errors";
import type { AppDirs } from "../paths";
import { writeFileAtomic } from "./atomic-write";
import { CONFIG_FILE_NAME, configFilePath, parseConfigText } from "./load";
import {
  CONFIG_SECTIONS,
  CONFIG_VERSION,
  type Config,
  keybindingOverrideSchema,
  settingsSchema,
} from "./schema";
import { cloneValue, deepEqual, getSetting, isPlainObject } from "./values";

export const CONFIG_HEADER = `# Lucy Workspace settings
#
# Only settings that differ from the defaults are listed here; delete a line to return to
# the default. The Settings screen lists every setting with its description and default.
#
# Lucy rewrites this file when you change a setting in the app. Comments are not kept by
# those saves; the previous file is always saved as config.toml.bak and in backups/.
`;

export const BACKUP_DIR_NAME = "backups";
/** Owner read/write only: settings may contain paths and command-line arguments. */
export const PRIVATE_FILE_MODE = 0o600;
const BACKUP_WRITE = { mode: PRIVATE_FILE_MODE, enforceMode: true } as const;
export const DEFAULT_MAX_BACKUPS = 5;

export interface SaveConfigOptions {
  /** The table that was loaded, so unknown keys survive. `null` or omitted: none. */
  raw?: TomlTable | null;
  /** Clock for backup names (tests). */
  now?: () => Date;
  /** Timestamped backups to keep. Default 5. */
  maxBackups?: number;
}

export interface SaveConfigResult {
  path: string;
  /** False when the file already had exactly this content. */
  written: boolean;
  text: string;
  /** The table that was written: pass it as `raw` to the next save. */
  table: TomlTable;
  backupPath?: string;
  timestampedBackupPath?: string;
  /** Set when the previous file did not parse and was kept aside permanently. */
  brokenBackupPath?: string;
}

/** Renders the file content for `config`, patching `raw` so unknown keys are kept. */
export function serializeConfig(config: Config, raw?: TomlTable | null): { text: string; table: TomlTable } {
  const base: TomlTable = raw ? cloneValue(raw) : {};
  delete base.version;
  const table: TomlTable = { version: CONFIG_VERSION };
  const known = new Set<string>(CONFIG_SECTIONS);

  for (const name of CONFIG_SECTIONS) {
    const existing = base[name];
    const section: TomlTable = isPlainObject(existing) ? cloneValue(existing as TomlTable) : {};
    for (const descriptor of settingsSchema) {
      if (descriptor.section !== name) continue;
      const rawValue = section[descriptor.tomlKey];
      delete section[descriptor.tomlKey];
      const value = getSetting(config, descriptor.path);
      if (descriptor.type === "keybinding-map") {
        // Entries that failed validation are kept as written so the user can fix them.
        const kept: TomlTable = {};
        if (isPlainObject(rawValue)) {
          for (const [command, entry] of Object.entries(rawValue as TomlTable)) {
            if (!keybindingOverrideSchema.safeParse(entry).success) kept[command] = entry;
          }
        }
        const merged = { ...kept, ...cloneValue(value as Record<string, TomlTable[string]>) };
        if (Object.keys(merged).length > 0) section[descriptor.tomlKey] = merged;
      } else if (!deepEqual(value, descriptor.default)) {
        section[descriptor.tomlKey] = cloneValue(value) as TomlTable[string];
      } else if (rawValue !== undefined && !descriptor.schema.safeParse(rawValue).success) {
        // An invalid value the user wrote is kept (it still triggers a warning on load)
        // rather than silently dropped because some other setting was saved.
        section[descriptor.tomlKey] = rawValue;
      }
    }
    if (Object.keys(section).length > 0) table[name] = section;
  }
  for (const [key, value] of Object.entries(base)) {
    if (!known.has(key)) table[key] = value;
  }

  // TOML requires bare keys to precede every [table] header at the same level; order the
  // top level so preserved unknown scalars never end up inside the last table.
  const ordered: TomlTable = {};
  for (const [key, value] of Object.entries(table)) if (!isPlainObject(value)) ordered[key] = value;
  for (const [key, value] of Object.entries(table)) if (isPlainObject(value)) ordered[key] = value;

  return { text: `${CONFIG_HEADER}\n${stringify(ordered).trimEnd()}\n`, table: ordered };
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function pruneBackups(directory: string, keep: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  const backups = names.filter((name) => /^config-.+\.toml$/.test(name)).sort();
  const excess = backups.slice(0, Math.max(0, backups.length - keep));
  await Promise.all(excess.map((name) => rm(join(directory, name), { force: true })));
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "ENOENT") return null;
    throw fromFsError(error, path);
  }
}

/**
 * Writes `config` to `<configDir>/config.toml`, creating the directory if needed. The
 * previous file is backed up before it is replaced; nothing is written when the content
 * is unchanged.
 */
export async function saveConfig(
  dirs: Pick<AppDirs, "config">,
  config: Config,
  options: SaveConfigOptions = {},
): Promise<SaveConfigResult> {
  const path = configFilePath(dirs);
  const { text, table } = serializeConfig(config, options.raw);
  const previous = await readIfExists(path);
  if (previous === text) return { path, written: false, text, table };

  const result: SaveConfigResult = { path, written: true, text, table };
  if (previous !== null) {
    const stamp = timestamp((options.now ?? (() => new Date()))());
    result.backupPath = `${path}.bak`;
    await writeFileAtomic(result.backupPath, previous, BACKUP_WRITE);
    const backupDir = join(dirs.config, BACKUP_DIR_NAME);
    result.timestampedBackupPath = join(backupDir, `config-${stamp}.toml`);
    await writeFileAtomic(result.timestampedBackupPath, previous, BACKUP_WRITE);
    await pruneBackups(backupDir, options.maxBackups ?? DEFAULT_MAX_BACKUPS);
    if (parseConfigText(previous, path).source === "fallback") {
      result.brokenBackupPath = join(dirs.config, `${CONFIG_FILE_NAME}.broken-${stamp}`);
      await writeFileAtomic(result.brokenBackupPath, previous, BACKUP_WRITE);
    }
  }
  await writeFileAtomic(path, text, { mode: PRIVATE_FILE_MODE });
  return result;
}
