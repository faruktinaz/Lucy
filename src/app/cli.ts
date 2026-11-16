/**
 * Command-line parsing for `lucy [path] [options]`. Pure: returns what to do, never exits.
 */

export interface CliOptions {
  /** The folder or file to open; `.` when omitted. */
  readonly path: string;
  readonly demo: boolean;
  /** With `--demo`: leave a merge conflict in the demo workspace. */
  readonly conflict: boolean;
  readonly debug: boolean;
  /** `--no-restore`: start without the saved layout and tabs. */
  readonly restore: boolean;
}

export type CliResult =
  | { readonly kind: "run"; readonly options: CliOptions }
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "error"; readonly message: string; readonly exitCode: 2 };

const FLAGS = ["--demo", "--conflict", "--debug", "--no-restore", "--help", "--version"] as const;

export function helpText(version: string): string {
  return `Lucy Workspace ${version}
A terminal-first developer workspace: files, search, source control and Claude Code.

Usage:
  lucy [path] [options]

Arguments:
  path            Folder (or file) to open. Default: the current folder.

Options:
  --demo          Open a throwaway demo project (isolated settings and Git).
  --conflict      With --demo: start in the middle of a merge conflict.
  --no-restore    Ignore the saved layout and open tabs for this folder.
  --debug         Verbose log and the debug console (toggle from the palette).
  -h, --help      Show this help.
  -v, --version   Show the version.

Keys: Ctrl+P go to file · F1 or Ctrl+Shift+P all commands · Ctrl+Q quit.
Inside a terminal panel, Ctrl+\\ is the leader: Ctrl+\\ P opens the palette.
`;
}

/** The closest known flag, for "did you mean" hints. */
function suggest(input: string): string | undefined {
  let best: { flag: string; distance: number } | undefined;
  for (const flag of FLAGS) {
    const distance = levenshtein(input, flag);
    if (distance <= 3 && (!best || distance < best.distance)) best = { flag, distance };
  }
  return best?.flag;
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j] ?? 0;
      row[j] = Math.min((row[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length] ?? 0;
}

function error(message: string): CliResult {
  return { kind: "error", message: `${message}\nRun "lucy --help" for usage.`, exitCode: 2 };
}

export function parseArgs(argv: readonly string[]): CliResult {
  let path: string | undefined;
  let demo = false;
  let conflict = false;
  let debug = false;
  let restore = true;
  let help = false;
  let version = false;
  let endOfOptions = false;

  for (const arg of argv) {
    if (!endOfOptions && arg === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith("-") && arg !== "-") {
      switch (arg) {
        case "--demo":
          demo = true;
          break;
        case "--conflict":
          conflict = true;
          break;
        case "--debug":
          debug = true;
          break;
        case "--no-restore":
          restore = false;
          break;
        case "-h":
        case "--help":
          help = true;
          break;
        case "-v":
        case "--version":
          version = true;
          break;
        default: {
          const hint = suggest(arg.split("=")[0] ?? arg);
          return error(`lucy: unknown option "${arg}".${hint ? ` Did you mean "${hint}"?` : ""}`);
        }
      }
      continue;
    }
    if (path !== undefined) return error(`lucy: expected one path, got "${path}" and "${arg}".`);
    path = arg;
  }

  if (help) return { kind: "help" };
  if (version) return { kind: "version" };
  if (conflict && !demo) return error('lucy: "--conflict" only works together with "--demo".');
  if (demo && path !== undefined) return error('lucy: "--demo" opens its own project; leave out the path.');
  return { kind: "run", options: { path: path ?? ".", demo, conflict, debug, restore } };
}
