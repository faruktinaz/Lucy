/**
 * Pure parser for `git status --porcelain=v2 -z --branch [--show-stash]`.
 *
 * With `-z` every record ends in NUL and paths are emitted verbatim (no quoting), so names with
 * spaces, quotes, newlines or Unicode survive. The only multi-token record is a rename/copy
 * (`2 ...`), whose original path follows as the next NUL-terminated token.
 */
import type {
  GitBranchStatus,
  GitChange,
  GitConflictKind,
  GitFileStatus,
  GitOperation,
  GitStatus,
  GitStatusTruncation,
  GitSubmoduleState,
} from "./types";

export interface ParsedPorcelainStatus {
  branch: GitBranchStatus;
  changes: GitChange[];
  stashCount: number;
  /** More entries than `maxEntries`, or the output itself was cut. */
  truncated: boolean;
  truncatedReason?: GitStatusTruncation;
}

export interface PorcelainParseOptions {
  /** Stop after this many entries and report `truncated`. */
  maxEntries?: number;
  /** The output was cut by a byte cap: the final partial record is dropped. */
  outputTruncated?: boolean;
}

const STATUS_CODES: Readonly<Record<string, GitFileStatus>> = {
  M: "modified",
  T: "type-changed",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "unmerged",
};

const CONFLICT_KINDS: Readonly<Record<string, GitConflictKind>> = {
  DD: "both-deleted",
  AU: "added-by-us",
  UD: "deleted-by-them",
  UA: "added-by-them",
  DU: "deleted-by-us",
  AA: "both-added",
  UU: "both-modified",
};

function statusFor(code: string | undefined): GitFileStatus | undefined {
  return code === undefined ? undefined : STATUS_CODES[code];
}

/** Splits off `count` space-separated fields; the remainder (which may contain spaces) is the path. */
function splitFields(record: string, count: number): { fields: string[]; rest: string } | null {
  const fields: string[] = [];
  let start = 0;
  for (let i = 0; i < count; i++) {
    const space = record.indexOf(" ", start);
    if (space === -1) return null;
    fields.push(record.slice(start, space));
    start = space + 1;
  }
  return { fields, rest: record.slice(start) };
}

function submoduleFrom(field: string | undefined): GitSubmoduleState | undefined {
  if (field?.[0] !== "S") return undefined;
  return {
    commitChanged: field[1] === "C",
    trackedChanges: field[2] === "M",
    untrackedChanges: field[3] === "U",
  };
}

function withSubmodule(change: GitChange, field: string | undefined): GitChange {
  const submodule = submoduleFrom(field);
  if (submodule) {
    change.isSubmodule = true;
    change.submodule = submodule;
  }
  return change;
}

function emptyBranch(): GitBranchStatus {
  return { name: null, oid: null, detached: false, unborn: false };
}

function applyHeader(branch: GitBranchStatus, header: string): number | null {
  const space = header.indexOf(" ");
  const key = space === -1 ? header : header.slice(0, space);
  const value = space === -1 ? "" : header.slice(space + 1);
  switch (key) {
    case "branch.oid":
      if (value === "(initial)") {
        branch.oid = null;
        branch.unborn = true;
      } else {
        branch.oid = value;
      }
      return null;
    case "branch.head":
      if (value === "(detached)") {
        branch.name = null;
        branch.detached = true;
      } else {
        branch.name = value;
      }
      return null;
    case "branch.upstream":
      branch.upstream = value;
      return null;
    case "branch.ab": {
      const match = /^\+(\d+) -(\d+)$/.exec(value);
      if (match) {
        branch.ahead = Number(match[1]);
        branch.behind = Number(match[2]);
      }
      return null;
    }
    case "stash": {
      const count = Number(value);
      return Number.isInteger(count) && count >= 0 ? count : null;
    }
    default:
      return null;
  }
}

export function parsePorcelainV2(output: string, options: PorcelainParseOptions = {}): ParsedPorcelainStatus {
  const maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY;
  const tokens = output.split("\0");
  // A complete stream ends with NUL, leaving one empty trailing token. A cut stream ends in a
  // partial record, which must not be parsed as a (wrong) path.
  tokens.pop();

  const branch = emptyBranch();
  const changes: GitChange[] = [];
  let stashCount = 0;
  let truncated = false;
  let truncatedReason: GitStatusTruncation | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const record = tokens[i] ?? "";
    if (record.length < 2) continue;
    const type = record[0];

    if (type === "#") {
      const stash = applyHeader(branch, record.slice(2));
      if (stash !== null) stashCount = stash;
      continue;
    }
    if (type === "!") continue;
    if (changes.length >= maxEntries) {
      truncated = true;
      truncatedReason = "entry-limit";
      break;
    }

    if (type === "?") {
      changes.push({ path: record.slice(2), worktree: "untracked", conflicted: false });
      continue;
    }

    if (type === "1") {
      const parsed = splitFields(record, 8);
      if (!parsed) continue;
      const xy = parsed.fields[1] ?? "..";
      const change: GitChange = {
        path: parsed.rest,
        index: statusFor(xy[0]),
        worktree: statusFor(xy[1]),
        conflicted: false,
      };
      changes.push(withSubmodule(change, parsed.fields[2]));
      continue;
    }

    if (type === "2") {
      const parsed = splitFields(record, 9);
      // The original path is the next token; if the stream was cut right here, stop.
      if (i + 1 >= tokens.length) break;
      const origPath = tokens[++i] ?? "";
      if (!parsed) continue;
      const xy = parsed.fields[1] ?? "..";
      const scoreField = parsed.fields[8] ?? "";
      const score = Number(scoreField.slice(1));
      const change: GitChange = {
        path: parsed.rest,
        origPath,
        index: statusFor(xy[0]),
        worktree: statusFor(xy[1]),
        conflicted: false,
      };
      if (Number.isFinite(score) && scoreField.length > 1) change.score = score;
      changes.push(withSubmodule(change, parsed.fields[2]));
      continue;
    }

    if (type === "u") {
      const parsed = splitFields(record, 10);
      if (!parsed) continue;
      const xy = parsed.fields[1] ?? "UU";
      const change: GitChange = {
        path: parsed.rest,
        worktree: "unmerged",
        conflicted: true,
        conflictKind: CONFLICT_KINDS[xy] ?? "both-modified",
      };
      changes.push(withSubmodule(change, parsed.fields[2]));
    }
    // Unknown record types are skipped for forward compatibility.
  }

  if (options.outputTruncated && !truncated) {
    truncated = true;
    truncatedReason = "output-limit";
  }
  return { branch, changes, stashCount, truncated, truncatedReason };
}

export interface GitStatusInput {
  branch?: Partial<GitBranchStatus>;
  changes: readonly GitChange[];
  operation?: GitOperation | null;
  stashCount?: number;
  truncated?: boolean;
  truncatedReason?: GitStatusTruncation;
}

/** Builds a `GitStatus` with its derived groups. Shared by the CLI adapter and the mock. */
export function createGitStatus(input: GitStatusInput): GitStatus {
  const changes = [...input.changes];
  const staged: GitChange[] = [];
  const unstaged: GitChange[] = [];
  const untracked: GitChange[] = [];
  const conflicts: GitChange[] = [];
  for (const change of changes) {
    if (change.conflicted) {
      conflicts.push(change);
      continue;
    }
    if (change.worktree === "untracked") {
      untracked.push(change);
      continue;
    }
    if (change.index !== undefined) staged.push(change);
    if (change.worktree !== undefined) unstaged.push(change);
  }
  const status: GitStatus = {
    branch: { ...emptyBranch(), ...input.branch },
    changes,
    staged,
    unstaged,
    untracked,
    conflicts,
    operation: input.operation ?? null,
    stashCount: input.stashCount ?? 0,
    truncated: input.truncated ?? false,
  };
  if (input.truncatedReason) status.truncatedReason = input.truncatedReason;
  return status;
}

/** Structural equality, used to keep the previous object (and avoid re-renders) when nothing changed. */
export function statusEquals(a: GitStatus, b: GitStatus): boolean {
  if (a === b) return true;
  if (
    a.operation !== b.operation ||
    a.stashCount !== b.stashCount ||
    a.truncated !== b.truncated ||
    a.truncatedReason !== b.truncatedReason ||
    a.changes.length !== b.changes.length
  ) {
    return false;
  }
  const ba = a.branch;
  const bb = b.branch;
  if (
    ba.name !== bb.name ||
    ba.oid !== bb.oid ||
    ba.detached !== bb.detached ||
    ba.unborn !== bb.unborn ||
    ba.upstream !== bb.upstream ||
    ba.ahead !== bb.ahead ||
    ba.behind !== bb.behind
  ) {
    return false;
  }
  for (let i = 0; i < a.changes.length; i++) {
    const x = a.changes[i];
    const y = b.changes[i];
    if (!x || !y) return false;
    if (
      x.path !== y.path ||
      x.origPath !== y.origPath ||
      x.index !== y.index ||
      x.worktree !== y.worktree ||
      x.conflicted !== y.conflicted ||
      x.conflictKind !== y.conflictKind ||
      x.isSubmodule !== y.isSubmodule ||
      x.score !== y.score ||
      x.submodule?.commitChanged !== y.submodule?.commitChanged ||
      x.submodule?.trackedChanges !== y.submodule?.trackedChanges ||
      x.submodule?.untrackedChanges !== y.submodule?.untrackedChanges
    ) {
      return false;
    }
  }
  return true;
}
