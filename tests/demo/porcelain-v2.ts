/**
 * A small, self-contained parser for `git status --porcelain=v2 -z --branch --show-stash`,
 * so the demo tests do not depend on the product's own Git adapter.
 */

export type ChangeKind = "modified" | "added" | "deleted" | "renamed" | "copied" | "type-changed";

export interface StatusChange {
  path: string;
  kind: ChangeKind;
  from?: string;
}

export interface ParsedStatus {
  oid: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  stashCount: number;
  staged: StatusChange[];
  unstaged: StatusChange[];
  untracked: string[];
  conflicted: string[];
}

const KINDS: Record<string, ChangeKind> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type-changed",
};

function kindOf(code: string): ChangeKind {
  const kind = KINDS[code];
  if (!kind) throw new Error(`Unexpected status code "${code}"`);
  return kind;
}

/** Splits off `count` space-separated fields; the remainder (which may contain spaces) is the path. */
function fields(record: string, count: number): { parts: string[]; rest: string } {
  const parts: string[] = [];
  let rest = record;
  for (let i = 0; i < count; i++) {
    const space = rest.indexOf(" ");
    if (space === -1) throw new Error(`Malformed status record: ${record}`);
    parts.push(rest.slice(0, space));
    rest = rest.slice(space + 1);
  }
  return { parts, rest };
}

export function parsePorcelainV2(output: string): ParsedStatus {
  const status: ParsedStatus = {
    oid: null,
    head: null,
    upstream: null,
    ahead: null,
    behind: null,
    stashCount: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };
  const records = output.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record === "") continue;
    if (record.startsWith("# ")) {
      const { parts, rest } = fields(record, 2);
      const key = parts[1];
      if (key === "branch.oid") status.oid = rest;
      else if (key === "branch.head") status.head = rest;
      else if (key === "branch.upstream") status.upstream = rest;
      else if (key === "branch.ab") {
        const [ahead, behind] = rest.split(" ");
        status.ahead = Number(ahead);
        status.behind = -Number(behind);
      } else if (key === "stash") status.stashCount = Number(rest);
      continue;
    }
    const type = record[0];
    if (type === "?") {
      status.untracked.push(record.slice(2));
    } else if (type === "1" || type === "2") {
      const { parts, rest } = fields(record, type === "1" ? 8 : 9);
      const xy = parts[1]!;
      // A rename record is followed by a separate NUL-terminated field with the original path.
      const from = type === "2" ? records[++i] : undefined;
      if (xy[0] !== ".") status.staged.push({ path: rest, kind: kindOf(xy[0]!), ...(from ? { from } : {}) });
      if (xy[1] !== ".") status.unstaged.push({ path: rest, kind: kindOf(xy[1]!) });
    } else if (type === "u") {
      status.conflicted.push(fields(record, 10).rest);
    } else if (type !== "!") {
      throw new Error(`Unknown status record: ${record}`);
    }
  }
  const byPath = (a: StatusChange, b: StatusChange) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  status.staged.sort(byPath);
  status.unstaged.sort(byPath);
  status.untracked.sort();
  status.conflicted.sort();
  return status;
}
