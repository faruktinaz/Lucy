import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { GitChange } from "@/adapters/git";
import { createConflict, openAt, registerCleanup, setup } from "./support";

registerCleanup();

function byPath(changes: readonly GitChange[], path: string): GitChange | undefined {
  return changes.find((change) => change.path === path);
}

describe("status", () => {
  test("clean repository on main", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    const status = await git.status();
    expect(status.changes).toEqual([]);
    expect(status.branch.name).toBe("main");
    expect(status.branch.oid).toBe((await fx.git("rev-parse", "HEAD")).trim());
    expect(status.branch.detached).toBe(false);
    expect(status.branch.unborn).toBe(false);
    expect(status.operation).toBeNull();
    expect(status.truncated).toBe(false);
  });

  test("modified, added, deleted and renamed, staged and unstaged", async () => {
    const { fx, git } = await setup({
      files: {
        "a.txt": "a\n",
        "b.txt": "b\n",
        "c.txt": "c\n",
        "d.txt": "d\n",
        "old.txt": "rename me\n".repeat(20),
      },
      commit: "init",
    });
    await fx.write("a.txt", "a changed\n"); // unstaged M
    await fx.write("b.txt", "b changed\n");
    await fx.git("add", "b.txt"); // staged M
    await fx.remove("c.txt"); // unstaged D
    await fx.git("rm", "-q", "d.txt"); // staged D
    await fx.git("mv", "old.txt", "new.txt"); // staged R
    await fx.write("added.txt", "new\n");
    await fx.git("add", "added.txt"); // staged A
    await fx.write("untracked.txt", "?\n");

    const status = await git.status();
    expect(byPath(status.changes, "a.txt")).toMatchObject({ worktree: "modified", conflicted: false });
    expect(byPath(status.changes, "a.txt")?.index).toBeUndefined();
    expect(byPath(status.changes, "b.txt")).toMatchObject({ index: "modified" });
    expect(byPath(status.changes, "b.txt")?.worktree).toBeUndefined();
    expect(byPath(status.changes, "c.txt")).toMatchObject({ worktree: "deleted" });
    expect(byPath(status.changes, "d.txt")).toMatchObject({ index: "deleted" });
    expect(byPath(status.changes, "new.txt")).toMatchObject({
      index: "renamed",
      origPath: "old.txt",
      score: 100,
    });
    expect(byPath(status.changes, "added.txt")).toMatchObject({ index: "added" });
    expect(byPath(status.changes, "untracked.txt")).toMatchObject({ worktree: "untracked" });

    expect(status.staged.map((c) => c.path).sort()).toEqual(["added.txt", "b.txt", "d.txt", "new.txt"]);
    expect(status.unstaged.map((c) => c.path).sort()).toEqual(["a.txt", "c.txt"]);
    expect(status.untracked.map((c) => c.path)).toEqual(["untracked.txt"]);
    expect(status.conflicts).toEqual([]);
  });

  test("a file staged and then modified again is in both groups", async () => {
    const { fx, git } = await setup({ files: { "f.txt": "1\n" }, commit: "init" });
    await fx.write("f.txt", "2\n");
    await fx.git("add", "f.txt");
    await fx.write("f.txt", "3\n");
    const status = await git.status();
    expect(byPath(status.changes, "f.txt")).toMatchObject({ index: "modified", worktree: "modified" });
    expect(status.staged.map((c) => c.path)).toEqual(["f.txt"]);
    expect(status.unstaged.map((c) => c.path)).toEqual(["f.txt"]);
  });

  test("a real merge conflict", async () => {
    const { fx, git } = await setup({ files: { "seed.txt": "s\n" }, commit: "seed" });
    await createConflict(fx);
    const status = await git.status();
    expect(status.operation).toBe("merge");
    expect(status.conflicts).toHaveLength(1);
    expect(status.conflicts[0]).toMatchObject({
      path: "f.txt",
      conflicted: true,
      conflictKind: "both-modified",
      worktree: "unmerged",
    });
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual([]);
  });

  test("unborn repository (no commits yet)", async () => {
    const { fx, git } = await setup();
    await fx.write("first.txt", "hello\n");
    let status = await git.status();
    expect(status.branch).toMatchObject({ name: "main", oid: null, unborn: true, detached: false });
    expect(status.untracked.map((c) => c.path)).toEqual(["first.txt"]);
    await git.stage(["first.txt"]);
    status = await git.status();
    expect(status.staged[0]).toMatchObject({ path: "first.txt", index: "added" });
  });

  test("detached HEAD", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    const head = (await fx.git("rev-parse", "HEAD")).trim();
    await fx.git("switch", "-q", "--detach", "HEAD");
    const status = await git.status();
    expect(status.branch).toMatchObject({ name: null, detached: true, oid: head });
  });

  test("ahead and behind against a local bare remote", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    const remote = await fx.addBareRemote();
    await fx.git("push", "-q", "-u", "origin", "main");
    await fx.write("a.txt", "local\n");
    await fx.commitAll("local");

    const other = await fx.clone(remote, "other");
    await other.write("b.txt", "remote\n");
    await other.commitAll("remote");
    await other.git("push", "-q", "origin", "main");
    await fx.git("fetch", "-q", "origin");

    const status = await git.status();
    expect(status.branch).toMatchObject({ name: "main", upstream: "origin/main", ahead: 1, behind: 1 });
  });

  test("Turkish path keeps its exact UTF-8 bytes", async () => {
    const { fx, git } = await setup({ files: { "seed.txt": "s\n" }, commit: "seed" });
    const path = "çalışma/şırınga ığüşöç.ts";
    await fx.write(path, "export const ğ = 1;\n");
    let status = await git.status();
    expect(status.untracked.map((c) => c.path)).toEqual([path]);
    await git.stage([path]);
    status = await git.status();
    expect(status.staged.map((c) => c.path)).toEqual([path]);
    const diff = await git.diff({ path, staged: true });
    expect(diff.patch).toContain(`+++ b/${path}`);
    expect(diff.patch).toContain("+export const ğ = 1;");
  });

  test.skipIf(process.platform !== "darwin")("NFD input paths match Git's NFC paths on macOS", async () => {
    const { fx, git } = await setup({ files: { "seed.txt": "s\n" }, commit: "seed" });
    const nfd = "şırınga.ts".normalize("NFD");
    await fx.write(nfd, "x\n");
    expect(git.repository.precomposeUnicode).toBe(true);
    const status = await git.status();
    expect(status.untracked.map((c) => c.path)).toEqual(["şırınga.ts".normalize("NFC")]);
    // An NFD path straight from readdir must still stage the file (stdin pathspecs are not precomposed by Git).
    await git.stage([nfd]);
    expect((await git.status()).staged.map((c) => c.path)).toEqual(["şırınga.ts".normalize("NFC")]);
  });

  test("hostile file names are reported verbatim", async () => {
    const { fx, git } = await setup({ files: { "seed.txt": "s\n" }, commit: "seed" });
    const names = [
      "with space.txt",
      'double"quote.txt',
      "single'quote.txt",
      "new\nline.txt",
      "-leading-dash.txt",
      "glob*.txt",
      "glob?[ab].txt",
      ":(glob)magic.txt",
      "back\\slash.txt",
      "tab\there.txt",
    ];
    for (const name of names) await fx.write(name, `${name}\n`);
    let status = await git.status();
    expect(status.untracked.map((c) => c.path).sort()).toEqual([...names].sort());
    await git.stage(names);
    status = await git.status();
    expect(status.staged.map((c) => c.path).sort()).toEqual([...names].sort());
    expect(status.untracked).toEqual([]);
  });

  test("entry cap sets truncated", async () => {
    const { fx, git } = await setup(
      { files: { "seed.txt": "s\n" }, commit: "seed" },
      { limits: { statusEntries: 3 } },
    );
    for (let i = 0; i < 6; i++) await fx.write(`u${i}.txt`, `${i}\n`);
    const status = await git.status();
    expect(status.truncated).toBe(true);
    expect(status.truncatedReason).toBe("entry-limit");
    expect(status.changes).toHaveLength(3);
  });

  test("output cap sets truncated without inventing a partial path", async () => {
    const { fx, git } = await setup(
      { files: { "seed.txt": "s\n" }, commit: "seed" },
      { limits: { statusOutputBytes: 120 } },
    );
    for (let i = 0; i < 20; i++) await fx.write(`some-longer-untracked-name-${i}.txt`, `${i}\n`);
    const status = await git.status();
    expect(status.truncated).toBe(true);
    for (const change of status.changes) expect(change.path).toMatch(/^some-longer-untracked-name-\d+\.txt$/);
  });

  test("stash count", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    await fx.write("a.txt", "changed\n");
    await fx.git("stash", "-q");
    expect((await git.status()).stashCount).toBe(1);
  });

  test("submodule changes are flagged", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    const lib = await fx.clone(fx.root, "lib-source");
    await fx.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", lib.root, "lib");
    await fx.commitAll("add submodule");
    await fx.write("lib/a.txt", "changed inside\n");
    const status = await git.status();
    const change = status.changes.find((c) => c.path === "lib");
    expect(change?.isSubmodule).toBe(true);
    expect(change?.submodule).toEqual({
      commitChanged: false,
      trackedChanges: true,
      untrackedChanges: false,
    });
  });

  test("linked worktree", async () => {
    const { fx } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    const wtPath = join(fx.base, "wt");
    await fx.git("worktree", "add", "-q", "-b", "feature", wtPath);
    const wt = await openAt(fx, wtPath);
    expect(wt.repository.isLinkedWorktree).toBe(true);
    expect(wt.repository.root).toBe(wtPath);
    expect(wt.repository.gitDir).not.toBe(wt.repository.commonDir);
    await fx.write("../wt/new.txt", "x\n");
    const status = await wt.status();
    expect(status.branch.name).toBe("feature");
    expect(status.untracked.map((c) => c.path)).toEqual(["new.txt"]);
  });

  test("in-progress operations from marker files", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    const gitDir = git.repository.gitDir;
    await Bun.write(join(gitDir, "CHERRY_PICK_HEAD"), "x\n");
    expect((await git.status()).operation).toBe("cherry-pick");
    await fx.remove(".git/CHERRY_PICK_HEAD");
    await Bun.write(join(gitDir, "REVERT_HEAD"), "x\n");
    expect((await git.status()).operation).toBe("revert");
    await fx.remove(".git/REVERT_HEAD");
    await mkdir(join(gitDir, "rebase-merge"));
    expect((await git.status()).operation).toBe("rebase");
    await fx.remove(".git/rebase-merge");
    await mkdir(join(gitDir, "rebase-apply"));
    expect((await git.status()).operation).toBe("rebase");
    await Bun.write(join(gitDir, "rebase-apply", "applying"), "");
    expect((await git.status()).operation).toBe("am");
    await fx.remove(".git/rebase-apply");
    await Bun.write(join(gitDir, "BISECT_LOG"), "x\n");
    expect((await git.status()).operation).toBe("bisect");
    await fx.remove(".git/BISECT_LOG");
    expect((await git.status()).operation).toBeNull();
  });

  test("status does not take index.lock (works while another process holds it)", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    await fx.write("a.txt", "changed\n");
    await Bun.write(join(git.repository.gitDir, "index.lock"), "");
    const status = await git.status();
    expect(status.unstaged.map((c) => c.path)).toEqual(["a.txt"]);
    expect(await fx.exists(".git/index.lock")).toBe(true);
  });

  test("concurrent status calls are coalesced (one in flight plus one trailing)", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    await fx.write("a.txt", "changed\n");
    const results = await Promise.all(Array.from({ length: 10 }, () => git.status()));
    expect(new Set(results).size).toBe(2);
    for (const status of results) expect(status.unstaged).toHaveLength(1);
  });
});
