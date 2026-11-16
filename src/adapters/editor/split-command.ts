/**
 * Splits `$VISUAL` / `$EDITOR` values such as `code --wait` or `nvim -u "~/my init.lua"` into
 * an argv array, without a shell.
 *
 * Tools like Git hand these variables to `sh -c`. Lucy never runs a shell, so it implements
 * the subset of POSIX word splitting that editor variables actually use, and refuses
 * everything that would need a real shell instead of guessing:
 *
 * - Unquoted blanks (space, tab, newline) separate words.
 * - `'...'` is literal; there are no escapes inside single quotes.
 * - `"..."` is literal except that a backslash escapes `"`, `\`, `$` and `` ` ``
 *   (other backslashes stay, as in POSIX).
 * - Outside quotes, a backslash makes the next character literal.
 * - Rejected when unquoted: `$` (variables, `$(...)`), `` ` ``, `|`, `&`, `;`, `<`, `>`, `(`, `)`.
 *   A value containing them is a shell program, not a command line.
 * - Not performed: variable, command and glob expansion. The one exception is a leading `~/`
 *   (or a lone `~`) in the program word, which becomes `$HOME`, because a shell would have
 *   expanded it in `export EDITOR=~/bin/micro` and some users quote it anyway.
 */

export type SplitCommandResult =
  | { readonly ok: true; readonly argv: readonly string[] }
  | { readonly ok: false; readonly message: string };

const BLANKS = new Set([" ", "\t", "\n"]);
const SHELL_ONLY = new Set(["$", "`", "|", "&", ";", "<", ">", "(", ")"]);
const DOUBLE_QUOTE_ESCAPES = new Set(['"', "\\", "$", "`"]);

export function splitCommandLine(value: string, home?: string): SplitCommandResult {
  if (value.includes("\0")) return { ok: false, message: "The command contains a NUL character" };
  const argv: string[] = [];
  let word = "";
  let inWord = false;
  let i = 0;
  while (i < value.length) {
    const char = value[i] as string;
    if (BLANKS.has(char)) {
      if (inWord) argv.push(word);
      word = "";
      inWord = false;
      i++;
      continue;
    }
    inWord = true;
    if (char === "'") {
      const end = value.indexOf("'", i + 1);
      if (end === -1) return { ok: false, message: "The command has an unterminated single quote" };
      word += value.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (char === '"') {
      i++;
      let closed = false;
      while (i < value.length) {
        const inner = value[i] as string;
        if (inner === '"') {
          closed = true;
          i++;
          break;
        }
        if (inner === "\\" && DOUBLE_QUOTE_ESCAPES.has(value[i + 1] ?? "")) {
          word += value[i + 1];
          i += 2;
          continue;
        }
        if (inner === "$" || inner === "`") {
          return {
            ok: false,
            message: `The command uses "${inner}" inside double quotes, which needs a shell`,
          };
        }
        word += inner;
        i++;
      }
      if (!closed) return { ok: false, message: "The command has an unterminated double quote" };
      continue;
    }
    if (char === "\\") {
      if (i + 1 >= value.length) return { ok: false, message: "The command ends with a lone backslash" };
      word += value[i + 1];
      i += 2;
      continue;
    }
    if (SHELL_ONLY.has(char)) {
      return { ok: false, message: `The command uses "${char}", which needs a shell` };
    }
    word += char;
    i++;
  }
  if (inWord) argv.push(word);
  if (argv.length === 0 || argv[0] === "") return { ok: false, message: "The command is empty" };
  const program = argv[0] as string;
  if (home && (program === "~" || program.startsWith("~/"))) argv[0] = home + program.slice(1);
  return { ok: true, argv };
}
