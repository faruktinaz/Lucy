/**
 * Editing a command (an argv list such as `["code", "--wait"]`) as one line of text.
 *
 * This is only a text format for the settings editor: the result is an argv array that the
 * kernel runs directly, never through a shell, so quoting here exists to allow spaces in
 * arguments, not to provide shell features. `$VAR`, globs and pipes stay literal.
 */

export type CommandLineParse = { ok: true; argv: string[] } | { ok: false; error: string };

/** Splits on whitespace; '…' is literal, "…" allows \" and \\, a backslash escapes outside quotes. */
export function parseCommandLine(text: string): CommandLineParse {
  const argv: string[] = [];
  let current = "";
  let inToken = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? "";
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\")) current += text[++i] ?? "";
      else current += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (inToken) argv.push(current);
      current = "";
      inToken = false;
      continue;
    }
    inToken = true;
    if (char === "'" || char === '"') quote = char;
    else if (char === "\\" && i + 1 < text.length) current += text[++i] ?? "";
    else current += char;
  }
  if (quote) return { ok: false, error: `Missing closing ${quote === '"' ? "double" : "single"} quote` };
  if (inToken) argv.push(current);
  if (argv.length === 0) return { ok: false, error: "Enter a command, for example: code --wait" };
  return { ok: true, argv };
}

/** Inverse of `parseCommandLine`: quotes only the arguments that need it. */
export function formatCommandLine(argv: readonly string[]): string {
  return argv
    .map((arg) => (arg !== "" && /^[^\s'"\\]+$/.test(arg) ? arg : `"${arg.replace(/(["\\])/g, "\\$1")}"`))
    .join(" ");
}
