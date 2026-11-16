import { describe, expect, test } from "bun:test";
import { createGitStatus, parsePorcelainV2, statusEquals } from "@/adapters/git";

const Z = "\0";
const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);
const OID_0 = "0".repeat(40);

/** Builds a `1` record: ordinary change. */
function one(xy: string, path: string, sub = "N..."): string {
  return `1 ${xy} ${sub} 100644 100644 100644 ${OID_A} ${OID_B} ${path}${Z}`;
}

describe("parsePorcelainV2", () => {
  test("branch headers", () => {
    const out = [
      `# branch.oid ${OID_A}`,
      "# branch.head feature/ğüş",
      "# branch.upstream origin/feature/ğüş",
      "# branch.ab +3 -12",
      "# stash 4",
    ]
      .map((line) => line + Z)
      .join("");
    const parsed = parsePorcelainV2(out);
    expect(parsed.branch).toEqual({
      name: "feature/ğüş",
      oid: OID_A,
      detached: false,
      unborn: false,
      upstream: "origin/feature/ğüş",
      ahead: 3,
      behind: 12,
    });
    expect(parsed.stashCount).toBe(4);
    expect(parsed.changes).toEqual([]);
  });

  test("unborn and detached heads", () => {
    expect(parsePorcelainV2(`# branch.oid (initial)${Z}# branch.head main${Z}`).branch).toEqual({
      name: "main",
      oid: null,
      detached: false,
      unborn: true,
    });
    expect(parsePorcelainV2(`# branch.oid ${OID_A}${Z}# branch.head (detached)${Z}`).branch).toMatchObject({
      name: null,
      detached: true,
      oid: OID_A,
    });
  });

  test("ordinary entries map X to the index and Y to the worktree", () => {
    const parsed = parsePorcelainV2(
      one(".M", "mod.txt") +
        one("M.", "staged.txt") +
        one("MM", "both.txt") +
        one("A.", "new.txt") +
        one("D.", "gone.txt") +
        one(".D", "deleted.txt") +
        one(".T", "type.txt") +
        one("AM", "added then edited.txt"),
    );
    expect(parsed.changes.map((c) => [c.path, c.index, c.worktree])).toEqual([
      ["mod.txt", undefined, "modified"],
      ["staged.txt", "modified", undefined],
      ["both.txt", "modified", "modified"],
      ["new.txt", "added", undefined],
      ["gone.txt", "deleted", undefined],
      ["deleted.txt", undefined, "deleted"],
      ["type.txt", undefined, "type-changed"],
      ["added then edited.txt", "added", "modified"],
    ]);
  });

  test("paths with spaces, newlines, quotes and Unicode are verbatim", () => {
    const names = [
      "with space.txt",
      "new\nline.txt",
      'q"uote.txt',
      "çalışma/şırınga ığüşöç.ts",
      "-dash",
      "glob*?[x]",
    ];
    const parsed = parsePorcelainV2(`${names.map((name) => one(".M", name)).join("")}? un tracked\nname${Z}`);
    expect(parsed.changes.map((c) => c.path)).toEqual([...names, "un tracked\nname"]);
  });

  test("renames: the original path is the next NUL-terminated token", () => {
    const parsed = parsePorcelainV2(
      `2 R. N... 100644 100644 100644 ${OID_A} ${OID_A} R100 new name.txt${Z}old name.txt${Z}` +
        `2 RM N... 100644 100644 100644 ${OID_A} ${OID_B} R87 b.txt${Z}a.txt${Z}` +
        `2 C. N... 100644 100644 100644 ${OID_A} ${OID_A} C75 copy.txt${Z}orig.txt${Z}` +
        one(".M", "after.txt"),
    );
    expect(parsed.changes).toEqual([
      {
        path: "new name.txt",
        origPath: "old name.txt",
        index: "renamed",
        worktree: undefined,
        conflicted: false,
        score: 100,
      },
      {
        path: "b.txt",
        origPath: "a.txt",
        index: "renamed",
        worktree: "modified",
        conflicted: false,
        score: 87,
      },
      {
        path: "copy.txt",
        origPath: "orig.txt",
        index: "copied",
        worktree: undefined,
        conflicted: false,
        score: 75,
      },
      { path: "after.txt", index: undefined, worktree: "modified", conflicted: false },
    ]);
  });

  test("unmerged entries carry the conflict kind", () => {
    const kinds: Record<string, string> = {
      DD: "both-deleted",
      AU: "added-by-us",
      UD: "deleted-by-them",
      UA: "added-by-them",
      DU: "deleted-by-us",
      AA: "both-added",
      UU: "both-modified",
    };
    const out = Object.keys(kinds)
      .map(
        (xy) => `u ${xy} N... 100644 100644 100644 100644 ${OID_A} ${OID_B} ${OID_0} conflict ${xy}.txt${Z}`,
      )
      .join("");
    const parsed = parsePorcelainV2(out);
    expect(parsed.changes.map((c) => [c.path, c.conflictKind, c.conflicted, c.worktree, c.index])).toEqual(
      Object.entries(kinds).map(([xy, kind]) => [`conflict ${xy}.txt`, kind, true, "unmerged", undefined]),
    );
  });

  test("submodule state", () => {
    const parsed = parsePorcelainV2(one(".M", "lib", "SCMU") + one(".M", "vendor", "S.M."));
    expect(parsed.changes[0]).toMatchObject({
      isSubmodule: true,
      submodule: { commitChanged: true, trackedChanges: true, untrackedChanges: true },
    });
    expect(parsed.changes[1]?.submodule).toEqual({
      commitChanged: false,
      trackedChanges: true,
      untrackedChanges: false,
    });
  });

  test("ignored and unknown records are skipped", () => {
    const parsed = parsePorcelainV2(`! ignored.log${Z}x future-record${Z}${one(".M", "a")}`);
    expect(parsed.changes.map((c) => c.path)).toEqual(["a"]);
  });

  test("entry cap", () => {
    const parsed = parsePorcelainV2(`${one(".M", "a")}${one(".M", "b")}? c${Z}? d${Z}`, { maxEntries: 3 });
    expect(parsed.changes.map((c) => c.path)).toEqual(["a", "b", "c"]);
    expect(parsed).toMatchObject({ truncated: true, truncatedReason: "entry-limit" });
  });

  test("a cut stream drops the partial record, including a rename missing its original path", () => {
    const full = `${one(".M", "complete.txt")}? partial-na`;
    expect(parsePorcelainV2(full, { outputTruncated: true })).toMatchObject({
      truncated: true,
      truncatedReason: "output-limit",
    });
    expect(parsePorcelainV2(full, { outputTruncated: true }).changes.map((c) => c.path)).toEqual([
      "complete.txt",
    ]);
    const cutRename = `2 R. N... 100644 100644 100644 ${OID_A} ${OID_A} R100 new.txt${Z}old.t`;
    expect(parsePorcelainV2(cutRename, { outputTruncated: true }).changes).toEqual([]);
  });

  test("empty output", () => {
    expect(parsePorcelainV2("")).toMatchObject({ changes: [], truncated: false, stashCount: 0 });
  });
});

describe("createGitStatus", () => {
  test("derives the four groups; staged+modified appears in both", () => {
    const status = createGitStatus({
      changes: [
        { path: "s", index: "modified", conflicted: false },
        { path: "u", worktree: "modified", conflicted: false },
        { path: "both", index: "added", worktree: "modified", conflicted: false },
        { path: "new", worktree: "untracked", conflicted: false },
        { path: "c", worktree: "unmerged", conflicted: true, conflictKind: "both-modified" },
      ],
    });
    expect(status.staged.map((c) => c.path)).toEqual(["s", "both"]);
    expect(status.unstaged.map((c) => c.path)).toEqual(["u", "both"]);
    expect(status.untracked.map((c) => c.path)).toEqual(["new"]);
    expect(status.conflicts.map((c) => c.path)).toEqual(["c"]);
    expect(status.operation).toBeNull();
    expect(status.branch).toEqual({ name: null, oid: null, detached: false, unborn: false });
  });

  test("statusEquals compares structure", () => {
    const make = (worktree: "modified" | "deleted") =>
      createGitStatus({
        branch: { name: "main", oid: OID_A },
        changes: [{ path: "a", worktree, conflicted: false }],
      });
    expect(statusEquals(make("modified"), make("modified"))).toBe(true);
    expect(statusEquals(make("modified"), make("deleted"))).toBe(false);
    const ahead = createGitStatus({ branch: { name: "main", oid: OID_A, ahead: 1 }, changes: [] });
    expect(statusEquals(ahead, createGitStatus({ branch: { name: "main", oid: OID_A }, changes: [] }))).toBe(
      false,
    );
  });
});
