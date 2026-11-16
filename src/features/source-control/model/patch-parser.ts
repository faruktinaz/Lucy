/**
 * Parser for the single-file unified diffs the Git adapter returns (`git diff`, `git diff
 * --cached`, `git diff --no-index`, `git diff --ours`).
 *
 * It never throws: repository content is untrusted and a diff view must show whatever it can.
 * Anything unexpected is recorded in `problems` and parsing continues or stops at that point.
 * Hunk line counts decide what is content and what is header, so a removed line whose text is
 * `-- x` (shown as `--- x`) is never mistaken for a file header.
 */

export type DiffLineKind = "context" | "added" | "removed";

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** Line text without the `+`/`-`/` ` marker and without a trailing `\r`. */
  readonly text: string;
  /** 1-based line number in the old file; `null` for added lines. */
  readonly oldLine: number | null;
  /** 1-based line number in the new file; `null` for removed lines. */
  readonly newLine: number | null;
  /** Followed by `\ No newline at end of file`: this is the last line and has no terminator. */
  readonly noNewlineAtEnd: boolean;
  /** The line ended in `\r` (CRLF content). The `\r` is not part of `text`. */
  readonly crlf: boolean;
}

export interface DiffHunk {
  readonly index: number;
  /** The full `@@ -a,b +c,d @@ section` line (without `\r`). */
  readonly header: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  /** Text after the second `@@` (usually the enclosing function), without the leading space. */
  readonly section: string;
  readonly lines: readonly DiffLine[];
}

export type DiffFileStatus = "modified" | "added" | "deleted" | "renamed" | "copied";

export interface ParsedDiff {
  /** Old path (repo-relative); `null` when the file is new. */
  readonly oldPath: string | null;
  /** New path (repo-relative); `null` when the file was deleted. */
  readonly newPath: string | null;
  readonly status: DiffFileStatus;
  readonly isBinary: boolean;
  /** File modes from `old mode`/`deleted file mode` and `new mode`/`new file mode`. */
  readonly oldMode: string | null;
  readonly newMode: string | null;
  /** `similarity index` of a rename or copy, in percent. */
  readonly similarity: number | null;
  readonly hunks: readonly DiffHunk[];
  readonly added: number;
  readonly removed: number;
  /** The input was empty (or whitespace only). */
  readonly isEmpty: boolean;
  /** Human-readable descriptions of anything that could not be parsed. Empty when all is well. */
  readonly problems: readonly string[];
}

interface MutableLine {
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
  noNewlineAtEnd: boolean;
  crlf: boolean;
}

interface MutableHunk {
  index: number;
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  section: string;
  lines: MutableLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?(.*))?$/;
const MAX_REPORTED_PROBLEMS = 20;

const C_ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/**
 * Decodes a C-style quoted path as Git writes it (`"a/tab\there.txt"`, octal `\303\247` bytes).
 * Returns `null` when the quoting is malformed.
 */
export function unquoteGitPath(quoted: string): string | null {
  if (quoted.length < 2 || !quoted.startsWith('"') || !quoted.endsWith('"')) return null;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const body = quoted.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const char = body[i] ?? "";
    if (char !== "\\") {
      // Copy whole code points so surrogate pairs encode correctly.
      const codePoint = body.codePointAt(i) ?? 0;
      const text = String.fromCodePoint(codePoint);
      for (const byte of encoder.encode(text)) bytes.push(byte);
      i += text.length - 1;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) return null;
    if (/[0-7]/.test(next)) {
      const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1))?.[0] ?? "";
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      i += octal.length;
      continue;
    }
    const escaped = C_ESCAPES[next];
    if (escaped === undefined) return null;
    bytes.push(escaped);
    i++;
  }
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

/** Path from a `---`/`+++` line: `/dev/null` → null, quoted names decoded, `a/`/`b/` prefix removed. */
function headerPath(raw: string, prefix: "a/" | "b/"): string | null {
  let value = raw;
  if (value.startsWith('"')) {
    // A quoted name may be followed by a tab and a timestamp (non-Git diffs).
    const end = value.indexOf('"', 1) === -1 ? -1 : findClosingQuote(value);
    const decoded = end === -1 ? null : unquoteGitPath(value.slice(0, end + 1));
    if (decoded === null) return value;
    value = decoded;
  } else {
    // Git appends a tab after names that contain a space; other tools append "\t<timestamp>".
    // An unquoted name never contains a raw tab (Git would have quoted it).
    const tab = value.indexOf("\t");
    if (tab !== -1) value = value.slice(0, tab);
  }
  if (value === "/dev/null") return null;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function findClosingQuote(value: string): number {
  for (let i = 1; i < value.length; i++) {
    if (value[i] === "\\") {
      i++;
      continue;
    }
    if (value[i] === '"') return i;
  }
  return -1;
}

/** Unprefixed path from `rename from`/`copy to` lines (possibly quoted). */
function plainPath(raw: string): string {
  return raw.startsWith('"') ? (unquoteGitPath(raw) ?? raw) : raw;
}

/**
 * Paths from `diff --git a/x b/y`, used only when no `---`/`+++` or rename lines exist (mode-only
 * changes, binary files). Unquoted names with spaces are ambiguous; the common case of equal
 * names is resolved exactly, otherwise the first ` b/` splits.
 */
function gitHeaderPaths(rest: string): { oldPath: string; newPath: string } | null {
  if (rest.startsWith('"')) {
    const end = findClosingQuote(rest);
    if (end === -1) return null;
    const first = unquoteGitPath(rest.slice(0, end + 1));
    const remainder = rest.slice(end + 2);
    const second = remainder.startsWith('"') ? unquoteGitPath(remainder) : remainder;
    if (first === null || second === null) return null;
    return { oldPath: first.replace(/^a\//, ""), newPath: second.replace(/^b\//, "") };
  }
  if (rest.startsWith("a/") && (rest.length - 5) % 2 === 0) {
    const half = (rest.length - 5) / 2;
    const left = rest.slice(2, 2 + half);
    if (rest.slice(2 + half, 5 + half) === " b/" && rest.slice(5 + half) === left) {
      return { oldPath: left, newPath: left };
    }
  }
  const split = rest.indexOf(" b/");
  if (!rest.startsWith("a/") || split === -1) return null;
  const last = rest.endsWith('"') ? unquoteGitPath(rest.slice(split + 1)) : rest.slice(split + 3);
  return { oldPath: rest.slice(2, split), newPath: last ?? rest.slice(split + 3) };
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

export function parseUnifiedDiff(patch: string): ParsedDiff {
  const problems: string[] = [];
  const problem = (message: string): void => {
    if (problems.length < MAX_REPORTED_PROBLEMS) problems.push(message);
    else if (problems.length === MAX_REPORTED_PROBLEMS) problems.push("Further problems were not reported.");
  };

  const hunks: MutableHunk[] = [];
  let oldPath: string | null | undefined;
  let newPath: string | null | undefined;
  let gitOld: string | undefined;
  let gitNew: string | undefined;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let copyFrom: string | undefined;
  let copyTo: string | undefined;
  let oldMode: string | null = null;
  let newMode: string | null = null;
  let isNewFile = false;
  let isDeletedFile = false;
  let similarity: number | null = null;
  let isBinary = false;
  let added = 0;
  let removed = 0;
  const isEmpty = patch.trim().length === 0;

  try {
    // Whitespace-only input is an empty diff, not a malformed one.
    const lines = isEmpty ? [] : patch.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();

    let hunk: MutableHunk | null = null;
    let oldRemaining = 0;
    let newRemaining = 0;
    let oldNumber = 0;
    let newNumber = 0;
    let lastLine: MutableLine | null = null;
    let sawGitHeader = false;
    let inBinaryData = false;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? "";

      // Content lines, decided by the hunk's remaining counts.
      if (hunk && (oldRemaining > 0 || newRemaining > 0)) {
        const marker = raw[0];
        if (marker === "\\") {
          if (lastLine) lastLine.noNewlineAtEnd = true;
          continue;
        }
        if (marker === " " || marker === "-" || marker === "+" || raw === "" || raw === "\r") {
          const body = raw.slice(1);
          const crlf = body.endsWith("\r");
          const text = crlf ? body.slice(0, -1) : body;
          let line: MutableLine;
          if (marker === "-") {
            line = {
              kind: "removed",
              text,
              oldLine: oldNumber++,
              newLine: null,
              noNewlineAtEnd: false,
              crlf,
            };
            oldRemaining--;
            removed++;
          } else if (marker === "+") {
            line = { kind: "added", text, oldLine: null, newLine: newNumber++, noNewlineAtEnd: false, crlf };
            newRemaining--;
            added++;
          } else {
            // An empty line is a blank context line written without its leading space
            // (`diff.suppressBlankEmpty`, or editors that strip trailing whitespace).
            line = {
              kind: "context",
              text: marker === " " ? text : "",
              oldLine: oldNumber++,
              newLine: newNumber++,
              noNewlineAtEnd: false,
              crlf: marker === " " ? crlf : raw === "\r",
            };
            oldRemaining--;
            newRemaining--;
          }
          if (oldRemaining < 0 || newRemaining < 0) {
            problem(`Hunk ${hunk.index + 1} has more lines than its header announces.`);
            oldRemaining = Math.max(0, oldRemaining);
            newRemaining = Math.max(0, newRemaining);
          }
          hunk.lines.push(line);
          lastLine = line;
          continue;
        }
        problem(`Hunk ${hunk.index + 1} ended early (line ${i + 1} is not part of a hunk).`);
        oldRemaining = 0;
        newRemaining = 0;
        // Fall through: the line may start a new hunk or header.
      }

      const line = stripCr(raw);

      if (line.startsWith("\\")) {
        // The marker follows the final line of a hunk, after its counts are exhausted.
        if (lastLine) lastLine.noNewlineAtEnd = true;
        else problem(`Line ${i + 1}: "No newline" marker without a preceding line.`);
        continue;
      }

      if (inBinaryData) {
        if (line.startsWith("diff --git ")) inBinaryData = false;
        else continue;
      }

      if (line.startsWith("@@@")) {
        problem("Combined (merge) diffs are not supported.");
        break;
      }

      if (line.startsWith("@@")) {
        const match = HUNK_HEADER.exec(line);
        if (!match) {
          problem(`Line ${i + 1}: malformed hunk header "${line.slice(0, 80)}".`);
          hunk = null;
          lastLine = null;
          continue;
        }
        const oldStart = Number(match[1]);
        const oldCount = match[2] === undefined ? 1 : Number(match[2]);
        const newStart = Number(match[3]);
        const newCount = match[4] === undefined ? 1 : Number(match[4]);
        hunk = {
          index: hunks.length,
          header: line,
          oldStart,
          oldCount,
          newStart,
          newCount,
          section: match[5] ?? "",
          lines: [],
        };
        hunks.push(hunk);
        oldRemaining = oldCount;
        newRemaining = newCount;
        // A zero count means the hunk is empty on that side; line numbers then start after it.
        oldNumber = oldCount === 0 ? oldStart + 1 : oldStart;
        newNumber = newCount === 0 ? newStart + 1 : newStart;
        lastLine = null;
        continue;
      }

      if (line.startsWith("diff --git ")) {
        if (sawGitHeader) {
          problem("The patch contains more than one file; only the first was parsed.");
          break;
        }
        sawGitHeader = true;
        const paths = gitHeaderPaths(line.slice("diff --git ".length));
        if (paths) {
          gitOld = paths.oldPath;
          gitNew = paths.newPath;
        }
        continue;
      }
      if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
        problem("Combined (merge) diffs are not supported.");
        break;
      }
      if (hunks.length > 0 && (line.startsWith("--- ") || line.startsWith("+++ "))) {
        problem(`Line ${i + 1}: file header after the first hunk.`);
        continue;
      }
      if (line.startsWith("--- ")) {
        oldPath = headerPath(line.slice(4), "a/");
        continue;
      }
      if (line.startsWith("+++ ")) {
        newPath = headerPath(line.slice(4), "b/");
        continue;
      }
      if (line.startsWith("old mode ")) {
        oldMode = line.slice("old mode ".length).trim();
        continue;
      }
      if (line.startsWith("new mode ")) {
        newMode = line.slice("new mode ".length).trim();
        continue;
      }
      if (line.startsWith("new file mode ")) {
        isNewFile = true;
        newMode = line.slice("new file mode ".length).trim();
        continue;
      }
      if (line.startsWith("deleted file mode ")) {
        isDeletedFile = true;
        oldMode = line.slice("deleted file mode ".length).trim();
        continue;
      }
      if (line.startsWith("similarity index ") || line.startsWith("dissimilarity index ")) {
        const value = Number.parseInt(line.slice(line.lastIndexOf(" ") + 1), 10);
        if (Number.isFinite(value)) similarity = line.startsWith("dis") ? 100 - value : value;
        continue;
      }
      if (line.startsWith("rename from ")) {
        renameFrom = plainPath(line.slice("rename from ".length));
        continue;
      }
      if (line.startsWith("rename to ")) {
        renameTo = plainPath(line.slice("rename to ".length));
        continue;
      }
      if (line.startsWith("copy from ")) {
        copyFrom = plainPath(line.slice("copy from ".length));
        continue;
      }
      if (line.startsWith("copy to ")) {
        copyTo = plainPath(line.slice("copy to ".length));
        continue;
      }
      if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
        isBinary = true;
        const inner = line.slice("Binary files ".length, -" differ".length);
        const and = inner.indexOf(" and ");
        if (and !== -1) {
          oldPath ??= headerPath(inner.slice(0, and), "a/");
          newPath ??= headerPath(inner.slice(and + 5), "b/");
        }
        continue;
      }
      if (line === "GIT binary patch") {
        isBinary = true;
        inBinaryData = true;
        continue;
      }
      if (line.startsWith("index ") || line === "" || line.startsWith("Submodule ")) continue;
      if (line.startsWith("* Unmerged path ")) continue;
      problem(`Line ${i + 1}: unrecognized line "${line.slice(0, 80)}".`);
    }

    if (hunk && (oldRemaining > 0 || newRemaining > 0)) {
      problem(`Hunk ${hunk.index + 1} is incomplete (the patch ends early).`);
    }
  } catch (error) {
    problem(`Internal parser error: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Resolve paths: explicit rename/copy lines win, then ---/+++, then the diff --git line.
  const isRename = renameFrom !== undefined || renameTo !== undefined;
  const isCopy = !isRename && (copyFrom !== undefined || copyTo !== undefined);
  let resolvedOld: string | null = oldPath === undefined ? (gitOld ?? null) : oldPath;
  let resolvedNew: string | null = newPath === undefined ? (gitNew ?? null) : newPath;
  if (isRename) {
    resolvedOld = renameFrom ?? resolvedOld;
    resolvedNew = renameTo ?? resolvedNew;
  } else if (isCopy) {
    resolvedOld = copyFrom ?? resolvedOld;
    resolvedNew = copyTo ?? resolvedNew;
  }
  if (isNewFile) resolvedOld = null;
  if (isDeletedFile) resolvedNew = null;

  let status: DiffFileStatus = "modified";
  if (isRename) status = "renamed";
  else if (isCopy) status = "copied";
  else if (isNewFile || (oldPath === null && resolvedNew !== null)) status = "added";
  else if (isDeletedFile || (newPath === null && resolvedOld !== null)) status = "deleted";

  return {
    oldPath: resolvedOld,
    newPath: resolvedNew,
    status,
    isBinary,
    oldMode,
    newMode,
    similarity,
    hunks,
    added,
    removed,
    isEmpty,
    problems,
  };
}
