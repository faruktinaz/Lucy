/**
 * The argv that opens a file at a line and column, per editor.
 *
 * Cursor syntax and how it was checked (columns are 1-based characters in every editor here):
 * - micro: `micro FILE +LINE:COL`. Verified with micro 2.0.15: `micro --help` documents
 *   "FILE +LINE[:COL]", and a pty run confirmed line, column and character (not byte) columns.
 *   The `FILE:LINE:COL` form is avoided: it only works with micro's `parsecursor` option.
 * - Helix: `hx FILE:LINE:COL`. From Helix's documentation (`hx --help`: "files... position can
 *   also be specified via file[:row[:col]]"); NOT verified locally (Helix not installed).
 *   Both numbers are always appended, so a file name that itself ends in ":12" stays intact
 *   (Helix strips at most two trailing numbers).
 * - Vim / Neovim: `vim +LINE "+normal! 0{COL-1}l" FILE`. `+{num}` and `+{command}` are in
 *   `vim --help` and `man vim`; verified with Vim 9.1 in a pty, including Turkish text (`l`
 *   moves by characters, while `cursor()` would count bytes) and columns past the line end
 *   (clamped by Vim). Neovim documents the same flags; NOT verified locally.
 * - vi: `vi +LINE FILE` only. POSIX vi (nvi, busybox) has no `:normal`.
 * - nano: `nano +LINE,COL FILE`. GNU nano documents `+LINE[,COLUMN]` (NOT verified: macOS has
 *   pico as `nano`). macOS pico was verified in a pty to accept `+LINE,COL` and go to LINE.
 * - Anything else: the file is appended (after `$EDITOR`'s own arguments).
 * - A custom template substitutes `{file}`, `{line}`, `{column}` inside arguments in one pass
 *   (a file name containing "{line}" is never re-substituted) and appends the file when there
 *   is no `{file}`. Missing line/column become 1.
 */
import { isAbsolute } from "node:path";
import { LucyError } from "@/core/errors";
import { knownEditorById } from "./known-editors";
import { EDITOR_PLACEHOLDER } from "./resolve-editor";
import type { OpenTarget, ResolvedEditor } from "./types";

function positive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

/**
 * A relative name starting with "-" or "+" would be read as an option or, in Vim, as an Ex
 * command ("+!cmd"): prefix "./" so it can only ever be a file.
 */
function fileArgument(file: string): string {
  return !isAbsolute(file) && (file.startsWith("-") || file.startsWith("+")) ? `./${file}` : file;
}

function fromTemplate(
  editor: ResolvedEditor,
  template: readonly string[],
  file: string,
  line: number,
  column: number,
) {
  const values: Record<string, string> = { file, line: String(line), column: String(column) };
  let usedFile = false;
  const args = template.map((arg) =>
    arg.replace(new RegExp(EDITOR_PLACEHOLDER.source, "g"), (_, name: string) => {
      if (name === "file") usedFile = true;
      return values[name] as string;
    }),
  );
  return usedFile ? [editor.program, ...args] : [editor.program, ...args, file];
}

export function buildOpenCommand(editor: ResolvedEditor, target: OpenTarget): string[] {
  if (target.file === "" || target.file.includes("\0")) {
    throw new LucyError("INVALID_ARGUMENT", "The file path to open is empty or contains a NUL character");
  }
  const file = fileArgument(target.file);
  const line = positive(target.line);
  const column = positive(target.column);
  if (editor.template) return fromTemplate(editor, editor.template, file, line ?? 1, column ?? 1);

  const base = [editor.program, ...editor.args];
  const syntax = editor.id ? knownEditorById(editor.id)?.cursorSyntax : undefined;
  if (line === undefined || syntax === undefined) return [...base, file];
  switch (syntax) {
    case "micro":
      return [...base, file, column === undefined ? `+${line}` : `+${line}:${column}`];
    case "helix":
      return [...base, `${file}:${line}:${column ?? 1}`];
    case "vim":
      return column === undefined || column === 1
        ? [...base, `+${line}`, file]
        : [...base, `+${line}`, `+normal! 0${column - 1}l`, file];
    case "nano":
      return [...base, column === undefined ? `+${line}` : `+${line},${column}`, file];
    case "vi":
      return [...base, `+${line}`, file];
  }
}
