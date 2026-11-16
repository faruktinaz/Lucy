/**
 * Turns the `editor.external` setting into a runnable editor.
 *
 * - `"auto"`: `$VISUAL`, then `$EDITOR`, then the first known editor on PATH (micro, hx, nvim,
 *   vim, nano, vi). A variable that cannot be used (needs a shell, program missing) is skipped
 *   with a note instead of failing, so a stale `$EDITOR` never blocks editing.
 * - A known name (`"micro"`, `"hx"`, `"nvim"`, `"vim"`; also `"nano"`, `"vi"`): that editor,
 *   or a clear "not installed" failure. No silent fallback: the user chose it.
 * - Any other single name: looked up on PATH and run with the file appended.
 * - A custom argv array, e.g. `["code", "--wait", "--goto", "{file}:{line}:{column}"]`.
 *   Without placeholders and with a known program (`["nvim", "--clean"]`), the arguments are
 *   kept and the editor's own cursor syntax is added; otherwise the template is used as is
 *   and, when it has no `{file}`, the file path is appended.
 */
import { basename } from "node:path";
import { describeEnvEditor, type EnvEditorInfo, findProgram } from "./detect-editors";
import { KNOWN_EDITORS, knownEditorById, knownEditorForProgram } from "./known-editors";
import type { EditorEnv, ResolvedEditor } from "./types";

export type EditorResolution =
  | { readonly ok: true; readonly editor: ResolvedEditor; readonly notes: readonly string[] }
  | {
      readonly ok: false;
      readonly reason: "not-found" | "invalid" | "none-available";
      /** One calm sentence for a notification. */
      readonly message: string;
      readonly notes: readonly string[];
    };

/** `{file}`, `{line}`, `{column}`: the placeholders a custom command may use. */
export const EDITOR_PLACEHOLDER = /\{(file|line|column)\}/g;

function hasPlaceholder(arg: string): boolean {
  return new RegExp(EDITOR_PLACEHOLDER.source).test(arg);
}

function fromArgv(
  argv: readonly string[],
  program: string,
  source: ResolvedEditor["source"],
): ResolvedEditor {
  const args = argv.slice(1);
  const known = knownEditorForProgram(argv[0] as string);
  if (args.some(hasPlaceholder)) {
    return {
      id: null,
      displayName: known?.displayName ?? basename(program),
      program,
      args: [],
      template: args,
      source,
    };
  }
  return {
    id: known?.id ?? null,
    displayName: known?.displayName ?? basename(program),
    program,
    args,
    template: null,
    source,
  };
}

function fromEnv(info: EnvEditorInfo): ResolvedEditor | null {
  if (!info.argv || !info.program) return null;
  return fromArgv(info.argv, info.program, info.variable === "VISUAL" ? "visual" : "editor");
}

function validArgv(value: readonly unknown[]): value is readonly string[] {
  return (
    value.length > 0 &&
    value.every((arg) => typeof arg === "string" && !arg.includes("\0")) &&
    (value[0] as string).trim() !== ""
  );
}

export function resolveEditor(
  setting: string | readonly string[],
  env: EditorEnv = process.env,
): EditorResolution {
  const notes: string[] = [];

  if (typeof setting !== "string") {
    if (!validArgv(setting)) {
      return {
        ok: false,
        reason: "invalid",
        message: "The custom editor command must be a non-empty list of text arguments.",
        notes,
      };
    }
    const name = setting[0] as string;
    const program = findProgram(name, env);
    if (!program) {
      return {
        ok: false,
        reason: "not-found",
        message: `The editor command "${name}" was not found${name.includes("/") ? "" : " on PATH"}.`,
        notes,
      };
    }
    return { ok: true, editor: fromArgv(setting, program, "setting"), notes };
  }

  if (setting === "auto") {
    for (const variable of ["VISUAL", "EDITOR"] as const) {
      const info = describeEnvEditor(variable, env);
      if (!info) continue;
      const editor = fromEnv(info);
      if (editor) return { ok: true, editor, notes };
      notes.push(`$${variable} ("${info.value}") is not usable: ${info.problem ?? "unknown problem"}.`);
    }
    for (const known of KNOWN_EDITORS) {
      for (const name of known.programs) {
        const program = findProgram(name, env);
        if (program) {
          return {
            ok: true,
            editor: {
              id: known.id,
              displayName: known.displayName,
              program,
              args: [],
              template: null,
              source: "detected",
            },
            notes,
          };
        }
      }
    }
    return {
      ok: false,
      reason: "none-available",
      message: "No terminal editor was found. Install micro, Helix, Neovim or Vim, or set $EDITOR.",
      notes,
    };
  }

  const known = knownEditorById(setting);
  if (known) {
    for (const name of known.programs) {
      const program = findProgram(name, env);
      if (program) {
        return {
          ok: true,
          editor: {
            id: known.id,
            displayName: known.displayName,
            program,
            args: [],
            template: null,
            source: "setting",
          },
          notes,
        };
      }
    }
    return {
      ok: false,
      reason: "not-found",
      message: `${known.displayName} (${known.programs[0]}) is not installed or not on PATH.`,
      notes,
    };
  }

  // Any other name: a program the user named in the config file by hand.
  const trimmed = setting.trim();
  const program = trimmed === "" ? null : findProgram(trimmed, env);
  if (!program) {
    return {
      ok: false,
      reason: trimmed === "" ? "invalid" : "not-found",
      message:
        trimmed === ""
          ? "No external editor is configured."
          : `The editor "${trimmed}" was not found on PATH.`,
      notes,
    };
  }
  return { ok: true, editor: fromArgv([trimmed], program, "setting"), notes };
}
