import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { gitFailureKind, isRetryableGitFailure } from "@/adapters/git";
import { createConflict, registerCleanup, setup } from "./support";

registerCleanup();

describe("stage / unstage", () => {
  test("round trip of a modified file", async () => {
    const { fx, git } = await setup({ files: { "f.txt": "1\n" }, commit: "init" });
    await fx.write("f.txt", "2\n");
    await git.stage(["f.txt"]);
    expect((await git.status()).staged.map((c) => c.path)).toEqual(["f.txt"]);
    await git.unstage(["f.txt"]);
    const status = await git.status();
    expect(status.staged).toEqual([]);
    expect(status.unstaged.map((c) => c.path)).toEqual(["f.txt"]);
    expect(await fx.read("f.txt")).toBe("2\n");
  });

  test("unstage works in a repository with no commits", async () => {
    const { fx, git } = await setup();
    await fx.write("a.txt", "a\n");
    await fx.write("b.txt", "b\n");
    await git.stage(["a.txt", "b.txt"]);
    expect((await git.status()).staged).toHaveLength(2);
    await git.unstage(["a.txt"]);
    let status = await git.status();
    expect(status.staged.map((c) => c.path)).toEqual(["b.txt"]);
    expect(status.untracked.map((c) => c.path)).toEqual(["a.txt"]);
    await git.unstageAll();
    status = await git.status();
    expect(status.staged).toEqual([]);
    expect(status.untracked.map((c) => c.path).sort()).toEqual(["a.txt", "b.txt"]);
  });

  test("stage a deletion", async () => {
    const { fx, git } = await setup({ files: { "gone.txt": "x\n" }, commit: "init" });
    await fx.remove("gone.txt");
    await git.stage(["gone.txt"]);
    expect((await git.status()).staged[0]).toMatchObject({ path: "gone.txt", index: "deleted" });
  });

  test("unstaging both sides of a staged rename restores the original layout", async () => {
    const { fx, git } = await setup({ files: { "old.txt": "content\n".repeat(20) }, commit: "init" });
    await fx.git("mv", "old.txt", "new.txt");
    await git.unstage(["new.txt", "old.txt"]);
    const status = await git.status();
    expect(status.staged).toEqual([]);
    expect(status.unstaged[0]).toMatchObject({ path: "old.txt", worktree: "deleted" });
    expect(status.untracked.map((c) => c.path)).toEqual(["new.txt"]);
  });

  test("stageAll and unstageAll", async () => {
    const { fx, git } = await setup({ files: { "m.txt": "m\n", "d.txt": "d\n" }, commit: "init" });
    await fx.write("m.txt", "changed\n");
    await fx.remove("d.txt");
    await fx.write("u.txt", "new\n");
    await git.stageAll();
    let status = await git.status();
    expect(status.staged.map((c) => `${c.index}:${c.path}`).sort()).toEqual([
      "added:u.txt",
      "deleted:d.txt",
      "modified:m.txt",
    ]);
    expect(status.unstaged).toEqual([]);
    expect(status.untracked).toEqual([]);
    await git.unstageAll();
    status = await git.status();
    expect(status.staged).toEqual([]);
    expect(status.unstaged.map((c) => c.path).sort()).toEqual(["d.txt", "m.txt"]);
    expect(status.untracked.map((c) => c.path)).toEqual(["u.txt"]);
  });

  test("stageAll refuses to mark conflicts resolved unless asked", async () => {
    const { fx, git } = await setup({ files: { "seed.txt": "s\n" }, commit: "seed" });
    await createConflict(fx);
    await fx.write("other.txt", "x\n");
    const error = await git.stageAll().catch((e: unknown) => e);
    expect(gitFailureKind(error)).toBe("conflicts");
    expect((await git.status()).conflicts).toHaveLength(1);
    expect((await git.status()).untracked.map((c) => c.path)).toEqual(["other.txt"]);
    await git.stageAll({ includeConflicts: true });
    const status = await git.status();
    expect(status.conflicts).toEqual([]);
    expect(status.operation).toBe("merge");
  });

  test("unstageAll during a merge keeps the merge in progress and the conflicts intact", async () => {
    const { fx, git } = await setup({ files: { "seed.txt": "s\n" }, commit: "seed" });
    await createConflict(fx);
    await fx.write("extra.txt", "x\n");
    await git.stage(["extra.txt"]);
    await git.unstageAll();
    const status = await git.status();
    expect(status.operation).toBe("merge");
    expect(status.conflicts.map((c) => c.path)).toEqual(["f.txt"]);
    expect(status.untracked.map((c) => c.path)).toEqual(["extra.txt"]);
  });

  test("many concurrent stage calls are serialized without index.lock errors", async () => {
    const { fx, git } = await setup({ files: { "seed.txt": "s\n" }, commit: "init" });
    const names = Array.from({ length: 20 }, (_, i) => `f${i}.txt`);
    for (const name of names) await fx.write(name, `${name}\n`);
    await Promise.all(names.map((name) => git.stage([name])));
    expect((await git.status()).staged).toHaveLength(20);
  });

  test("index.lock held by another process gives a typed, retryable failure", async () => {
    const { fx, git } = await setup({ files: { "f.txt": "1\n" }, commit: "init" });
    await fx.write("f.txt", "2\n");
    const lock = join(git.repository.gitDir, "index.lock");
    await Bun.write(lock, "");
    const error = await git.stage(["f.txt"]).catch((e: unknown) => e);
    expect(gitFailureKind(error)).toBe("index-locked");
    expect(isRetryableGitFailure(error)).toBe(true);
    await fx.remove(".git/index.lock");
    await git.stage(["f.txt"]);
    expect((await git.status()).staged).toHaveLength(1);
  });

  test("a lock released during the retry window is absorbed", async () => {
    const { fx, git } = await setup({ files: { "f.txt": "1\n" }, commit: "init" });
    await fx.write("f.txt", "2\n");
    await Bun.write(join(git.repository.gitDir, "index.lock"), "");
    setTimeout(() => void fx.remove(".git/index.lock"), 40);
    await git.stage(["f.txt"]);
    expect((await git.status()).staged).toHaveLength(1);
  });
});

describe("discard", () => {
  test("preview describes exactly what would be lost", async () => {
    const { fx, git } = await setup({
      files: { "mod.txt": "a\nb\n", "staged.txt": "s\n", "del.txt": "d1\nd2\nd3\n" },
      commit: "init",
    });
    await fx.write("mod.txt", "a\nB\nc\n");
    await fx.write("staged.txt", "s2\n");
    await fx.git("add", "staged.txt");
    await fx.remove("del.txt");
    await fx.write("new.txt", "1\n2\n3\n4\n");
    await fx.write("bin.dat", new Uint8Array([0, 1, 2, 3]));

    const preview = await git.previewDiscard([
      "mod.txt",
      "staged.txt",
      "del.txt",
      "new.txt",
      "bin.dat",
      "clean-or-missing.txt",
    ]);
    const by = Object.fromEntries(preview.map((entry) => [entry.path, entry]));
    expect(by["mod.txt"]).toMatchObject({
      action: "restore",
      linesLost: 2,
      linesRestored: 1,
      isBinary: false,
    });
    expect(by["staged.txt"]).toMatchObject({ action: "none" });
    expect(by["del.txt"]).toMatchObject({ action: "restore", linesLost: 0, linesRestored: 3 });
    expect(by["new.txt"]).toMatchObject({ action: "delete", linesLost: 4, bytes: 8, isBinary: false });
    expect(by["bin.dat"]).toMatchObject({ action: "delete", isBinary: true, bytes: 4, linesLost: null });
    expect(by["clean-or-missing.txt"]).toMatchObject({ action: "none", change: null });
  });

  test("discard restores tracked files and deletes only the named untracked files", async () => {
    const { fx, git } = await setup({
      files: { "mod.txt": "orig\n", "del.txt": "keep me\n", ".gitignore": "*.log\n" },
      commit: "init",
    });
    await fx.write("mod.txt", "changed\n");
    await fx.remove("del.txt");
    await fx.write("new.txt", "x\n");
    await fx.write("other-untracked.txt", "stay\n");
    await fx.write("debug.log", "ignored\n");

    const result = await git.discard(["mod.txt", "del.txt", "new.txt"]);
    expect(result.restored.sort()).toEqual(["del.txt", "mod.txt"]);
    expect(result.deleted).toEqual(["new.txt"]);
    expect(await fx.read("mod.txt")).toBe("orig\n");
    expect(await fx.read("del.txt")).toBe("keep me\n");
    expect(await fx.exists("new.txt")).toBe(false);
    expect(await fx.exists("other-untracked.txt")).toBe(true);
    expect(await fx.exists("debug.log")).toBe(true);
  });

  test("discard keeps the staged version and only drops unstaged edits", async () => {
    const { fx, git } = await setup({ files: { "f.txt": "1\n" }, commit: "init" });
    await fx.write("f.txt", "2\n");
    await fx.git("add", "f.txt");
    await fx.write("f.txt", "3\n");
    await git.discard(["f.txt"]);
    expect(await fx.read("f.txt")).toBe("2\n");
    const status = await git.status();
    expect(status.staged.map((c) => c.path)).toEqual(["f.txt"]);
    expect(status.unstaged).toEqual([]);
  });

  test("conflicted files and directories are blocked, with no side effects", async () => {
    const { fx, git } = await setup({ files: { "seed.txt": "s\n" }, commit: "seed" });
    await createConflict(fx);
    await fx.write("dir/a.txt", "a\n");
    await fx.write("loose.txt", "l\n");
    const preview = await git.previewDiscard(["f.txt", "dir"]);
    expect(preview.map((entry) => [entry.path, entry.action, entry.reason])).toEqual([
      ["f.txt", "blocked", "conflicted"],
      ["dir", "blocked", "directory"],
    ]);
    const error = await git.discard(["loose.txt", "f.txt"]).catch((e: unknown) => e);
    expect(gitFailureKind(error)).toBe("discard-blocked");
    expect(await fx.exists("loose.txt")).toBe(true);
    expect(await fx.exists("dir/a.txt")).toBe(true);
  });
});
