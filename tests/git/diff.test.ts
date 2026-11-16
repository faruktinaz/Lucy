import { describe, expect, test } from "bun:test";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { createConflict, registerCleanup, setup } from "./support";

registerCleanup();

const BINARY = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00, 0xff]);

describe("diff", () => {
  test("unstaged modification", async () => {
    const { fx, git } = await setup({ files: { "f.txt": "one\ntwo\nthree\n" }, commit: "init" });
    await fx.write("f.txt", "one\nTWO\nthree\n");
    const diff = await git.diff({ path: "f.txt" });
    expect(diff).toMatchObject({ mode: "unstaged", isBinary: false, isTooLarge: false, isEmpty: false });
    expect(diff.patch).toContain("diff --git a/f.txt b/f.txt");
    expect(diff.patch).toContain("-two\n+TWO\n");
  });

  test("staged vs unstaged of the same file differ", async () => {
    const { fx, git } = await setup({ files: { "f.txt": "1\n" }, commit: "init" });
    await fx.write("f.txt", "2\n");
    await fx.git("add", "f.txt");
    await fx.write("f.txt", "3\n");
    const staged = await git.diff({ path: "f.txt", staged: true });
    const unstaged = await git.diff({ path: "f.txt" });
    expect(staged.mode).toBe("staged");
    expect(staged.patch).toContain("-1\n+2\n");
    expect(unstaged.patch).toContain("-2\n+3\n");
  });

  test("clean file gives an empty diff", async () => {
    const { git } = await setup({ files: { "f.txt": "1\n" }, commit: "init" });
    expect(await git.diff({ path: "f.txt" })).toMatchObject({ patch: "", isEmpty: true });
    expect(await git.diff({ path: "f.txt", staged: true })).toMatchObject({ patch: "", isEmpty: true });
  });

  test("context lines are configurable", async () => {
    const { fx, git } = await setup({ files: { "f.txt": "a\nb\nc\nd\ne\n" }, commit: "init" });
    await fx.write("f.txt", "a\nb\nC\nd\ne\n");
    const diff = await git.diff({ path: "f.txt" }, { context: 0 });
    expect(diff.patch).toContain("@@ -3 +3 @@");
    // No context lines (a context line starts with a space at the beginning of a line).
    expect(diff.patch.split("\n").filter((line) => line.startsWith(" "))).toEqual([]);
  });

  test("untracked file is synthesized as all-added", async () => {
    const { fx, git } = await setup({ files: { "seed.txt": "s\n" }, commit: "init" });
    await fx.write("dir/new file.txt", "hello\nworld\n");
    const diff = await git.diff({ path: "dir/new file.txt" });
    expect(diff.mode).toBe("untracked");
    expect(diff.patch).toContain("new file mode 100644");
    expect(diff.patch).toContain("--- /dev/null");
    expect(diff.patch).toContain("+hello\n+world\n");
  });

  test("untracked file over the size guard is too large", async () => {
    const { fx, git } = await setup({ files: { "seed.txt": "s\n" }, commit: "init" });
    await fx.write("big.txt", "x".repeat(10_000));
    const diff = await git.diff({ path: "big.txt" }, { maxBytes: 1_000 });
    expect(diff).toMatchObject({ patch: "", isTooLarge: true, isEmpty: false, mode: "untracked" });
  });

  test("huge tracked diff is reported too large", async () => {
    const { fx, git } = await setup({ files: { "f.txt": "a\n" }, commit: "init" });
    await fx.write("f.txt", "line\n".repeat(5_000));
    const diff = await git.diff({ path: "f.txt" }, { maxBytes: 2_000 });
    expect(diff).toMatchObject({ patch: "", isTooLarge: true, isEmpty: false });
  });

  test("binary files are flagged, tracked and untracked", async () => {
    const { fx, git } = await setup({ files: { "img.png": BINARY }, commit: "init" });
    await fx.write("img.png", new Uint8Array([...BINARY, 0x00, 0x42]));
    expect(await git.diff({ path: "img.png" })).toMatchObject({ isBinary: true, patch: "", isEmpty: false });
    await fx.write("new.bin", BINARY);
    expect(await git.diff({ path: "new.bin" })).toMatchObject({ isBinary: true, mode: "untracked" });
  });

  test("deleted file, unstaged and staged", async () => {
    const { fx, git } = await setup({
      files: { "gone.txt": "bye\n", "staged-gone.txt": "bye too\n" },
      commit: "init",
    });
    await fx.remove("gone.txt");
    await fx.git("rm", "-q", "staged-gone.txt");
    const unstaged = await git.diff({ path: "gone.txt" });
    expect(unstaged.patch).toContain("deleted file mode");
    expect(unstaged.patch).toContain("-bye\n");
    const staged = await git.diff({ path: "staged-gone.txt", staged: true });
    expect(staged.patch).toContain("deleted file mode");
    expect(staged.patch).toContain("-bye too\n");
  });

  test("staged rename with origPath renders as a rename", async () => {
    const content = "line\n".repeat(30);
    const { fx, git } = await setup({ files: { "old.txt": content }, commit: "init" });
    await fx.git("mv", "old.txt", "new.txt");
    const diff = await git.diff({ path: "new.txt", origPath: "old.txt", staged: true });
    expect(diff.patch).toContain("rename from old.txt");
    expect(diff.patch).toContain("rename to new.txt");
  });

  test("staged diff on an unborn branch compares with the empty tree", async () => {
    const { fx, git } = await setup();
    await fx.write("first.txt", "first\n");
    await git.stage(["first.txt"]);
    const diff = await git.diff({ path: "first.txt", staged: true });
    expect(diff.patch).toContain("new file mode");
    expect(diff.patch).toContain("+first\n");
  });

  test("conflicted file: working tree with markers against ours", async () => {
    const { fx, git } = await setup({ files: { "seed.txt": "s\n" }, commit: "seed" });
    await createConflict(fx);
    const diff = await git.diff({ path: "f.txt" });
    expect(diff.mode).toBe("conflict");
    expect(diff.patch).toContain("diff --git a/f.txt b/f.txt");
    expect(diff.patch).toContain("+<<<<<<< HEAD");
    expect(diff.patch).toContain("+theirs");
    expect(diff.patch).not.toContain("* Unmerged path");
    // The staged flag cannot show anything meaningful for an unmerged path; same representation.
    expect((await git.diff({ path: "f.txt", staged: true })).mode).toBe("conflict");
  });

  test("conflict without an 'ours' version shows the working tree as added", async () => {
    const { fx, git } = await setup({ files: { "f.txt": "base\n" }, commit: "base" });
    await fx.git("switch", "-q", "-c", "other");
    await fx.write("f.txt", "theirs\n");
    await fx.commitAll("theirs edit");
    await fx.git("switch", "-q", "main");
    await fx.git("rm", "-q", "f.txt");
    await fx.commitAll("we delete");
    await fx.gitRaw(["merge", "other"]);
    const status = await git.status();
    expect(status.conflicts[0]?.conflictKind).toBe("deleted-by-us");
    const diff = await git.diff({ path: "f.txt" });
    expect(diff.mode).toBe("conflict");
    expect(diff.patch).toContain("+theirs");
  });
});

describe("fileAtRevision", () => {
  test("HEAD, INDEX and WORKTREE sides", async () => {
    const { fx, git } = await setup({ files: { "f.txt": "head\n" }, commit: "init" });
    await fx.write("f.txt", "index\n");
    await fx.git("add", "f.txt");
    await fx.write("f.txt", "worktree\n");
    expect(await git.fileAtRevision("f.txt", "HEAD")).toMatchObject({
      exists: true,
      content: "head\n",
      isBinary: false,
    });
    expect((await git.fileAtRevision("f.txt", "INDEX")).content).toBe("index\n");
    expect((await git.fileAtRevision("f.txt", "WORKTREE")).content).toBe("worktree\n");
  });

  test("a new file does not exist at HEAD; unborn HEAD has nothing", async () => {
    const { fx, git } = await setup();
    await fx.write("n.txt", "n\n");
    expect(await git.fileAtRevision("n.txt", "HEAD")).toMatchObject({ exists: false, content: null });
    await git.stage(["n.txt"]);
    expect((await git.fileAtRevision("n.txt", "INDEX")).content).toBe("n\n");
  });

  test("arbitrary revisions", async () => {
    const { fx, git } = await setup({ files: { "f.txt": "v1\n" }, commit: "one" });
    await fx.write("f.txt", "v2\n");
    await fx.commitAll("two");
    expect((await git.fileAtRevision("f.txt", "HEAD~1")).content).toBe("v1\n");
    expect((await git.fileAtRevision("f.txt", "main")).content).toBe("v2\n");
    expect((await git.fileAtRevision("f.txt", "no-such-branch")).exists).toBe(false);
  });

  test("binary content is flagged and withheld", async () => {
    const { fx, git } = await setup({ files: { "b.bin": BINARY }, commit: "init" });
    await fx.write("b.bin", BINARY);
    expect(await git.fileAtRevision("b.bin", "HEAD")).toMatchObject({
      exists: true,
      isBinary: true,
      content: null,
    });
    expect(await git.fileAtRevision("b.bin", "WORKTREE")).toMatchObject({
      exists: true,
      isBinary: true,
      content: null,
    });
  });

  test("size cap", async () => {
    const { git } = await setup({ files: { "big.txt": "x".repeat(5_000) }, commit: "init" });
    expect(await git.fileAtRevision("big.txt", "HEAD", { maxBytes: 100 })).toMatchObject({
      isTooLarge: true,
      content: null,
    });
    expect(await git.fileAtRevision("big.txt", "WORKTREE", { maxBytes: 100 })).toMatchObject({
      isTooLarge: true,
      content: null,
    });
  });

  test("conflict stages BASE / OURS / THEIRS", async () => {
    const { fx, git } = await setup({ files: { "seed.txt": "s\n" }, commit: "seed" });
    await createConflict(fx);
    expect((await git.fileAtRevision("f.txt", "BASE")).content).toBe("base\n");
    expect((await git.fileAtRevision("f.txt", "OURS")).content).toBe("ours\n");
    expect((await git.fileAtRevision("f.txt", "THEIRS")).content).toBe("theirs\n");
  });

  test("a file named like a stage spec is read from stage 0", async () => {
    const { git } = await setup({ files: { "1:foo": "literal\n", foo: "other\n" }, commit: "init" });
    expect((await git.fileAtRevision("1:foo", "INDEX")).content).toBe("literal\n");
    expect((await git.fileAtRevision("1:foo", "HEAD")).content).toBe("literal\n");
  });

  test("worktree symlinks yield their target and are never followed", async () => {
    const { fx, git } = await setup({ files: { "seed.txt": "s\n" }, commit: "init" });
    await symlink("/etc/hosts", join(fx.root, "link"));
    expect(await git.fileAtRevision("link", "WORKTREE")).toMatchObject({
      exists: true,
      content: "/etc/hosts",
    });
  });

  test("a symlinked directory cannot leak files from outside the repository", async () => {
    const { fx, git } = await setup({ files: { "seed.txt": "s\n" }, commit: "init" });
    await Bun.write(join(fx.base, "secret.txt"), "secret\n");
    await symlink(fx.base, join(fx.root, "escape"));
    expect(await git.fileAtRevision("escape/secret.txt", "WORKTREE")).toMatchObject({
      exists: false,
      content: null,
    });
  });
});
