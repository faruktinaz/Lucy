/**
 * What is available: the known editors on PATH and what `$VISUAL` / `$EDITOR` point to.
 * Read-only and cheap (PATH lookups only); the settings UI calls it to show the choices.
 */
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { which } from "@/core/process";
import { KNOWN_EDITORS, type KnownEditorId, knownEditorForProgram } from "./known-editors";
import { splitCommandLine } from "./split-command";
import type { EditorEnv } from "./types";

export interface DetectedEditor {
  readonly id: KnownEditorId;
  readonly displayName: string;
  /** Absolute path found on PATH. */
  readonly program: string;
}

export interface EnvEditorInfo {
  readonly variable: "VISUAL" | "EDITOR";
  /** The raw value (may contain arguments). */
  readonly value: string;
  /** Split argv, or `null` when the value cannot be split without a shell. */
  readonly argv: readonly string[] | null;
  /** Why the value is unusable (cannot be split, or the program is not found), or `null`. */
  readonly problem: string | null;
  /** Absolute path of the program, or `null` when it was not found. */
  readonly program: string | null;
  readonly id: KnownEditorId | null;
}

export interface EditorDetection {
  /** Known editors on PATH, in "auto" preference order. */
  readonly installed: readonly DetectedEditor[];
  readonly visual: EnvEditorInfo | null;
  readonly editor: EnvEditorInfo | null;
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Absolute path of `program`: a bare name is looked up on the env's PATH; a path must be
 * absolute (a relative path in `$EDITOR` would depend on Lucy's working directory).
 */
export function findProgram(program: string, env: EditorEnv): string | null {
  if (program.includes("/")) return isAbsolute(program) && isExecutableFile(program) ? program : null;
  return which(program, env);
}

export function describeEnvEditor(variable: "VISUAL" | "EDITOR", env: EditorEnv): EnvEditorInfo | null {
  const value = env[variable];
  if (value === undefined || value.trim() === "") return null;
  const split = splitCommandLine(value, env.HOME);
  if (!split.ok) return { variable, value, argv: null, problem: split.message, program: null, id: null };
  const name = split.argv[0] as string;
  const program = findProgram(name, env);
  return {
    variable,
    value,
    argv: split.argv,
    problem: program ? null : `"${name}" was not found${name.includes("/") ? "" : " on PATH"}`,
    program,
    id: knownEditorForProgram(name)?.id ?? null,
  };
}

export function detectEditors(env: EditorEnv = process.env): EditorDetection {
  const installed: DetectedEditor[] = [];
  for (const editor of KNOWN_EDITORS) {
    for (const name of editor.programs) {
      const program = which(name, env);
      if (program) {
        installed.push({ id: editor.id, displayName: editor.displayName, program });
        break;
      }
    }
  }
  return { installed, visual: describeEnvEditor("VISUAL", env), editor: describeEnvEditor("EDITOR", env) };
}
