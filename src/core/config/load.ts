/**
 * Loading `<configDir>/config.toml`.
 *
 * Loading never writes and never throws for user mistakes: a missing file means defaults
 * (no file is created), a syntax error means defaults plus an error problem with its
 * position, and invalid values fall back per key. The app always starts.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, TomlError, type TomlTable } from "smol-toml";
import { errorMessage } from "../errors";
import type { AppDirs } from "../paths";
import { migrateConfig } from "./migrations";
import { CONFIG_VERSION, type Config } from "./schema";
import { type ConfigProblem, validateConfigTable } from "./validate";
import { defaultConfig } from "./values";

export const CONFIG_FILE_NAME = "config.toml";

export type ConfigSource =
  /** No config file: built-in defaults. */
  | "defaults"
  /** Values come from the file (possibly with per-key fallbacks). */
  | "file"
  /** The file exists but could not be read or parsed: built-in defaults. */
  | "fallback";

export interface LoadedConfig {
  config: Config;
  source: ConfigSource;
  path: string;
  problems: ConfigProblem[];
  /**
   * The parsed and migrated table, kept so that saving can preserve unknown keys.
   * `null` when there is no usable file.
   */
  raw: TomlTable | null;
  /** The `version` the file declared (0 when absent), or `null` without a usable file. */
  fileVersion: number | null;
}

export function configFilePath(dirs: Pick<AppDirs, "config">): string {
  return join(dirs.config, CONFIG_FILE_NAME);
}

function firstLine(message: string): string {
  return message.split("\n")[0]?.replace(/^Invalid TOML document:\s*/, "") ?? message;
}

/** Parses and validates config text. Pure: used by `loadConfig` and by tests. */
export function parseConfigText(input: string, path = CONFIG_FILE_NAME): LoadedConfig {
  // Editors on some platforms add a byte-order mark, which TOML parsers reject.
  const text = input.replace(/^﻿/, "");
  if (text.trim() === "") {
    return { config: defaultConfig(), source: "file", path, problems: [], raw: {}, fileVersion: 0 };
  }
  let table: TomlTable;
  try {
    table = parse(text, { unsafeKeyBehaviour: "drop", maxDepth: 32 }) as TomlTable;
  } catch (error) {
    const position = error instanceof TomlError ? { line: error.line, column: error.column } : {};
    return {
      config: defaultConfig(),
      source: "fallback",
      path,
      problems: [
        {
          severity: "error",
          path: "",
          message: `${CONFIG_FILE_NAME} could not be parsed (${firstLine(errorMessage(error))}). Using the default settings until it is fixed.`,
          ...position,
        },
      ],
      raw: null,
      fileVersion: null,
    };
  }

  const problems: ConfigProblem[] = [];
  const declared = table.version;
  let fileVersion: number;
  if (declared === undefined) {
    fileVersion = 0;
  } else if (typeof declared === "number" && Number.isInteger(declared) && declared >= 0) {
    fileVersion = declared;
  } else {
    problems.push({
      severity: "warning",
      path: "version",
      message: `"version" must be a whole number; reading the file as version ${CONFIG_VERSION}.`,
    });
    fileVersion = CONFIG_VERSION;
  }

  let current = table;
  if (fileVersion > CONFIG_VERSION) {
    problems.push({
      severity: "warning",
      path: "version",
      message: `${CONFIG_FILE_NAME} is version ${fileVersion}, written by a newer Lucy. Settings this version understands are applied; the rest are kept untouched.`,
    });
  } else if (fileVersion < CONFIG_VERSION) {
    const migrated = migrateConfig(table, fileVersion);
    current = migrated.table;
    if (migrated.notes.length > 0) {
      problems.push({
        severity: "info",
        path: "",
        message: `Upgraded settings from version ${fileVersion} to ${migrated.version} in memory: ${migrated.notes.join(" ")} The file is rewritten in the new format the next time a setting is saved.`,
      });
    }
  }

  const { config, problems: valueProblems } = validateConfigTable(current, text);
  return {
    config,
    source: "file",
    path,
    problems: [...problems, ...valueProblems],
    raw: current,
    fileVersion,
  };
}

/** Loads and validates the config file. Never throws for file content problems. */
export async function loadConfig(dirs: Pick<AppDirs, "config">): Promise<LoadedConfig> {
  const path = configFilePath(dirs);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return {
        config: defaultConfig(),
        source: "defaults",
        path,
        problems: [],
        raw: null,
        fileVersion: null,
      };
    }
    return {
      config: defaultConfig(),
      source: "fallback",
      path,
      problems: [
        {
          severity: "error",
          path: "",
          message: `${CONFIG_FILE_NAME} could not be read (${errorMessage(error)}). Using the default settings.`,
        },
      ],
      raw: null,
      fileVersion: null,
    };
  }
  return { ...parseConfigText(text, path), path };
}
