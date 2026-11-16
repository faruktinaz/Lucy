/**
 * Per-key validation of a parsed config table.
 *
 * One bad value never discards the file: each setting is validated on its own and falls back
 * to its default with a warning that names the key. Unknown keys are reported and kept (the
 * save path preserves them), so a typo or a setting from a newer Lucy is never lost.
 */
import type { TomlTable } from "smol-toml";
import { type Config, type KeybindingOverrides, keybindingOverrideSchema, settingsSchema } from "./schema";
import { cloneValue, defaultConfig, isPlainObject } from "./values";

export type ProblemSeverity = "error" | "warning" | "info";

export interface ConfigProblem {
  severity: ProblemSeverity;
  /** Dotted TOML path (`layout.sidebar_width`), or "" for the whole file. */
  path: string;
  message: string;
  /** 1-based position in config.toml, when known. */
  line?: number;
  column?: number;
}

export interface ValidationResult {
  config: Config;
  problems: ConfigProblem[];
}

/** Short, single-line rendering of a value for messages. */
export function describeValue(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function quoteKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

/**
 * Best-effort position of `[section] key = ...` in the source text, for editor-style
 * diagnostics. Handles `[section]` headers, quoted keys and `section.key = ...` dotted keys;
 * multi-line strings may confuse it, in which case the problem simply has no position.
 */
export function locateKey(
  source: string,
  sectionPath: string[],
  key: string,
): { line: number; column: number } | undefined {
  const lines = source.split(/\r?\n/);
  let current: string[] = [];
  const keyPattern = (k: string) => {
    const escaped = k.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
    return `(?:${escaped}|"${escaped}"|'${escaped}')`;
  };
  const wanted = sectionPath.join(".");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const header = /^(\s*)\[\s*([^\][]+?)\s*\]\s*(?:#.*)?$/.exec(line);
    if (header?.[2]) {
      current = header[2].split(".").map((part) => part.trim().replace(/^["']|["']$/g, ""));
      // An unknown top-level table is reported at its header.
      if (sectionPath.length === 0 && current[0] === key) {
        return { line: i + 1, column: (header[1]?.length ?? 0) + 1 };
      }
      continue;
    }
    const inSection = current.join(".") === wanted;
    const pattern = inSection
      ? new RegExp(`^(\\s*)${keyPattern(key)}\\s*=`)
      : current.length === 0
        ? new RegExp(
            `^(\\s*)${sectionPath.map(keyPattern).join("\\s*\\.\\s*")}\\s*\\.\\s*${keyPattern(key)}\\s*=`,
          )
        : null;
    const match = pattern?.exec(line);
    if (match) return { line: i + 1, column: (match[1]?.length ?? 0) + 1 };
  }
  return undefined;
}

function at(
  source: string | undefined,
  sectionPath: string[],
  key: string,
): { line?: number; column?: number } {
  if (!source) return {};
  return locateKey(source, sectionPath, key) ?? {};
}

const KNOWN_TOP_LEVEL = new Set(["version", ...settingsSchema.map((d) => d.section)]);

/**
 * Validates a parsed (and migrated) table. `source` is the original file text, used only to
 * attach line numbers to problems.
 */
export function validateConfigTable(table: TomlTable, source?: string): ValidationResult {
  const config = defaultConfig() as unknown as Record<string, Record<string, unknown>>;
  const problems: ConfigProblem[] = [];
  const reportedSections = new Set<string>();
  const knownKeys = new Map<string, Set<string>>();

  for (const descriptor of settingsSchema) {
    let keys = knownKeys.get(descriptor.section);
    if (!keys) {
      keys = new Set();
      knownKeys.set(descriptor.section, keys);
    }
    keys.add(descriptor.tomlKey);

    const sectionValue = table[descriptor.section];
    if (sectionValue === undefined) continue;
    if (!isPlainObject(sectionValue)) {
      if (!reportedSections.has(descriptor.section)) {
        reportedSections.add(descriptor.section);
        problems.push({
          severity: "warning",
          path: descriptor.section,
          message: `"${descriptor.section}" must be a table ([${descriptor.section}]); using defaults for its settings.`,
        });
      }
      continue;
    }
    const raw = sectionValue[descriptor.tomlKey];
    if (raw === undefined) continue;
    const target = config[descriptor.section] as Record<string, unknown>;

    if (descriptor.type === "keybinding-map") {
      target[descriptor.key] = validateBindings(raw, descriptor.tomlPath, source, problems);
      continue;
    }
    const parsed = descriptor.schema.safeParse(raw);
    if (parsed.success) {
      target[descriptor.key] = cloneValue(parsed.data);
    } else {
      problems.push({
        severity: "warning",
        path: descriptor.tomlPath,
        message: `Invalid value for ${descriptor.tomlPath}: expected ${descriptor.expected}, got ${describeValue(raw)}. Using the default, ${describeValue(descriptor.default)}.`,
        ...at(source, [descriptor.section], descriptor.tomlKey),
      });
    }
  }

  for (const [key, value] of Object.entries(table)) {
    if (!KNOWN_TOP_LEVEL.has(key)) {
      problems.push({
        severity: "warning",
        path: quoteKey(key),
        message: `Unknown setting "${key}". It is kept in the file but has no effect.`,
        ...at(source, [], key),
      });
      continue;
    }
    if (key === "version" || !isPlainObject(value)) continue;
    const keys = knownKeys.get(key) ?? new Set<string>();
    for (const inner of Object.keys(value)) {
      if (keys.has(inner)) continue;
      const path = `${key}.${quoteKey(inner)}`;
      problems.push({
        severity: "warning",
        path,
        message: `Unknown setting "${path}". It is kept in the file but has no effect.`,
        ...at(source, [key], inner),
      });
    }
  }

  return { config: config as unknown as Config, problems };
}

function validateBindings(
  raw: unknown,
  tomlPath: string,
  source: string | undefined,
  problems: ConfigProblem[],
): KeybindingOverrides {
  if (!isPlainObject(raw)) {
    problems.push({
      severity: "warning",
      path: tomlPath,
      message: `${tomlPath} must be a table of command ids to shortcuts; ignoring it.`,
    });
    return {};
  }
  const out: KeybindingOverrides = {};
  const [section = "", key = ""] = tomlPath.split(".");
  for (const [command, value] of Object.entries(raw)) {
    const parsed = keybindingOverrideSchema.safeParse(value);
    if (parsed.success) {
      out[command] = cloneValue(parsed.data);
    } else {
      problems.push({
        severity: "warning",
        path: `${tomlPath}.${quoteKey(command)}`,
        message: `Invalid shortcut for "${command}": expected a chord such as "ctrl+b", a list of chords, or false; got ${describeValue(value)}. Ignoring it.`,
        ...at(source, [section, key], command),
      });
    }
  }
  return out;
}
