import { describe, expect, test } from "bun:test";
import { lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileOps } from "@/adapters/filesystem/file-ops";
import { isLucyError, type LucyErrorCode } from "@/core/errors";
import { createTempDirs, writeTree } from "./helpers";

const tempDir = createTempDirs("lucy-ops-");

async function setup(options: { maxCrossDeviceBytes?: number; exdev?: boolean } = {}) {
  const root = await tempDir();
  const state = await tempDir();
  const trashDir = join(state, "trash");
  const ops = new FileOps({
    root,
    trashDir,
    maxCrossDeviceBytes: options.maxCrossDeviceBytes,
    trashRename: options.exdev
      ? async () => {
          throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
        }
      : undefined,
  });
  return { root, trashDir, ops };
}

async function expectCode(promise: Promise<unknown>, code: LucyErrorCode): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (!isLucyError(error)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but the operation succeeded`);
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

describe("FileOps create", () => {
  test("creates files and folders with missing parents; never overwrites", async () => {
    const { root, ops } = await setup();
    expect(await ops.createFile("a/b/c.ts", "export {};\n")).toBe("a/b/c.ts");
    expect(await readFile(join(root, "a/b/c.ts"), "utf8")).toBe("export {};\n");
    await expectCode(ops.createFile("a/b/c.ts"), "ALREADY_EXISTS");
    expect(await ops.createDirectory("x/y/z/")).toBe("x/y/z");
    expect((await lstat(join(root, "x/y/z"))).isDirectory()).toBe(true);
    await expectCode(ops.createDirectory("x/y"), "ALREADY_EXISTS");
    await expectCode(ops.createFile("a/b/c.ts/inner.ts"), "ALREADY_EXISTS"); // A file is in the way.
  });

  test("undo removes the created file and the parents it created", async () => {
    const { root, ops } = await setup();
    await mkdir(join(root, "existing"));
    await ops.createFile("existing/new/deeper/file.txt");
    expect(ops.canUndo).toBe(true);
    expect(ops.describeUndo()).toBe("Remove the file “existing/new/deeper/file.txt” created just now");
    const result = await ops.undo();
    expect(result.changedPaths).toContain("existing/new/deeper/file.txt");
    expect(await exists(join(root, "existing/new"))).toBe(false);
    expect(await exists(join(root, "existing"))).toBe(true);
    expect(ops.canUndo).toBe(false);
    await expectCode(ops.undo(), "NOT_FOUND");
  });

  test("undo keeps a created file that was modified since", async () => {
    const { root, ops } = await setup();
    await ops.createFile("notes.md");
    await Bun.sleep(5);
    await writeFile(join(root, "notes.md"), "important");
    await expectCode(ops.undo(), "UNSUPPORTED");
    expect(await readFile(join(root, "notes.md"), "utf8")).toBe("important");
    expect(ops.canUndo).toBe(false); // Dropped: it can never be undone.
  });

  test("undo of a created folder refuses when it is no longer empty", async () => {
    const { root, ops } = await setup();
    await ops.createDirectory("dir");
    await writeFile(join(root, "dir/file.txt"), "");
    await expectCode(ops.undo(), "UNSUPPORTED");
    expect(await exists(join(root, "dir/file.txt"))).toBe(true);
  });

  test("Turkish and long names", async () => {
    const { root, ops } = await setup();
    await ops.createFile("ığüşöç/İstanbul.txt", "merhaba");
    expect(await readFile(join(root, "ığüşöç/İstanbul.txt"), "utf8")).toBe("merhaba");
    const longName = "a".repeat(255);
    await ops.createFile(longName);
    await expectCode(ops.createFile("b".repeat(256)), "INVALID_ARGUMENT");
    // 128 two-byte characters = 256 bytes: over the limit even though it is 128 characters.
    await expectCode(ops.createFile("ş".repeat(128)), "INVALID_ARGUMENT");
  });
});

describe("FileOps validation and confinement", () => {
  test("rejects malformed names with INVALID_ARGUMENT", async () => {
    const { ops } = await setup();
    for (const bad of ["", "   ", "a\0b", "a/./b", "a//b", "./a", "a/../b", "bad\nname", "tab\tname"]) {
      await expectCode(ops.createFile(bad), "INVALID_ARGUMENT");
    }
  });

  test("rejects traversal and absolute paths with OUTSIDE_WORKSPACE", async () => {
    const { root, ops } = await setup();
    const outside = await tempDir();
    await expectCode(ops.createFile("../escape.txt"), "OUTSIDE_WORKSPACE");
    await expectCode(ops.createFile("a/../../escape.txt"), "OUTSIDE_WORKSPACE");
    await expectCode(ops.createFile(join(outside, "x.txt")), "OUTSIDE_WORKSPACE");
    await expectCode(ops.createFile(join(root, "inside.txt")), "INVALID_ARGUMENT");
    await expectCode(ops.delete("../"), "OUTSIDE_WORKSPACE");
    expect(await readdir(outside)).toEqual([]);
  });

  test("a symlinked parent pointing outside cannot smuggle mutations out", async () => {
    const { root, ops } = await setup();
    const outside = await tempDir();
    await writeTree(outside, { "victim.txt": "keep me" });
    await writeTree(root, { "local.txt": "" });
    await symlink(outside, join(root, "out"));
    await expectCode(ops.createFile("out/new.txt"), "OUTSIDE_WORKSPACE");
    await expectCode(ops.createDirectory("out/dir"), "OUTSIDE_WORKSPACE");
    await expectCode(ops.rename("local.txt", "out/moved.txt"), "OUTSIDE_WORKSPACE");
    await expectCode(ops.delete("out/victim.txt"), "OUTSIDE_WORKSPACE");
    await expectCode(ops.rename("out/victim.txt", "stolen.txt"), "OUTSIDE_WORKSPACE");
    expect(await readdir(outside)).toEqual(["victim.txt"]);
  });

  test("a symlink planted at the target is never followed", async () => {
    const { root, ops } = await setup();
    const outside = await tempDir();
    await symlink(join(outside, "planted.txt"), join(root, "trap.txt"));
    // The kernel treats a dangling symlink as pointing outside; even without that check the
    // exclusive create ("wx") would refuse it. Either way nothing is written through it.
    await expectCode(ops.createFile("trap.txt"), "OUTSIDE_WORKSPACE");
    await expectCode(ops.createDirectory("trap.txt"), "OUTSIDE_WORKSPACE");
    expect(await readdir(outside)).toEqual([]);
  });

  test("the trash must live outside the workspace", async () => {
    const root = await tempDir();
    expect(() => new FileOps({ root, trashDir: join(root, ".trash") })).toThrow();
  });
});

describe("FileOps rename", () => {
  test("never overwrites and can move into new folders; undo reverses", async () => {
    const { root, ops } = await setup();
    await writeTree(root, { "a.txt": "A", "b.txt": "B" });
    await expectCode(ops.rename("a.txt", "b.txt"), "ALREADY_EXISTS");
    await expectCode(ops.rename("missing.txt", "c.txt"), "NOT_FOUND");
    expect(await ops.rename("a.txt", "moved/deep/a2.txt")).toBe("moved/deep/a2.txt");
    expect(await readFile(join(root, "moved/deep/a2.txt"), "utf8")).toBe("A");
    expect(ops.describeUndo()).toBe("Rename “moved/deep/a2.txt” back to “a.txt”");
    await ops.undo();
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("A");
    expect(await exists(join(root, "moved"))).toBe(false);
  });

  test("a folder cannot be moved into itself", async () => {
    const { root, ops } = await setup();
    await writeTree(root, { "dir/x.txt": "" });
    await expectCode(ops.rename("dir", "dir/sub/dir"), "INVALID_ARGUMENT");
  });

  test("case-only rename works on a case-insensitive filesystem", async () => {
    const { root, ops } = await setup();
    await writeTree(root, { "readme.md": "hello" });
    const caseInsensitive = await exists(join(root, "README.MD"));
    if (!caseInsensitive) {
      // Case-sensitive filesystem: the names are distinct entries; a plain rename applies.
      await ops.rename("readme.md", "README.md");
      expect(await readdir(root)).toEqual(["README.md"]);
      return;
    }
    await ops.rename("readme.md", "README.md");
    expect(await readdir(root)).toEqual(["README.md"]);
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("hello");
    await ops.undo();
    expect(await readdir(root)).toEqual(["readme.md"]);
  });

  test("undo keeps the entry when the original name is taken, and succeeds once freed", async () => {
    const { root, ops } = await setup();
    await writeTree(root, { "old.txt": "content" });
    await ops.rename("old.txt", "new.txt");
    await writeFile(join(root, "old.txt"), "squatter");
    await expectCode(ops.undo(), "ALREADY_EXISTS");
    expect(ops.canUndo).toBe(true);
    await rename(join(root, "old.txt"), join(root, "elsewhere.txt"));
    await ops.undo();
    expect(await readFile(join(root, "old.txt"), "utf8")).toBe("content");
  });

  test("renaming a symlink renames the link, not its target", async () => {
    const { root, ops } = await setup();
    await writeTree(root, { "target.txt": "t" });
    await symlink("target.txt", join(root, "link"));
    await ops.rename("link", "link2");
    expect(await readlink(join(root, "link2"))).toBe("target.txt");
    expect(await exists(join(root, "target.txt"))).toBe(true);
  });

  test("an existing name with control characters can still be renamed and deleted", async () => {
    const { root, ops } = await setup();
    await writeFile(join(root, "bad\nname.txt"), "");
    await ops.rename("bad\nname.txt", "good.txt");
    await ops.delete("good.txt");
    expect(await readdir(root)).toEqual([]);
  });
});

describe("FileOps delete and trash", () => {
  test("delete moves into the trash; undo restores files and folders", async () => {
    const { root, trashDir, ops } = await setup();
    await writeTree(root, { "doc.txt": "keep", "dir/a/b.txt": "nested", "dir/c.txt": "c" });
    await ops.delete("doc.txt");
    await ops.delete("dir");
    expect(await readdir(root)).toEqual([]);
    expect((await readdir(trashDir)).length).toBe(2);
    expect(ops.describeUndo()).toBe("Restore the deleted folder “dir”");
    await ops.undo();
    expect(await readFile(join(root, "dir/a/b.txt"), "utf8")).toBe("nested");
    expect(ops.describeUndo()).toBe("Restore the deleted file “doc.txt”");
    await ops.undo();
    expect(await readFile(join(root, "doc.txt"), "utf8")).toBe("keep");
    expect(await readdir(trashDir)).toEqual([]);
  });

  test("deleting a symlink removes the link, never its target", async () => {
    const { root, ops } = await setup();
    const outside = await tempDir();
    await writeTree(outside, { "precious/data.txt": "data" });
    await symlink(join(outside, "precious"), join(root, "link-out"));
    await writeTree(root, { "inner.txt": "inner" });
    await symlink("inner.txt", join(root, "link-in"));
    await ops.delete("link-out");
    await ops.delete("link-in");
    expect(await readFile(join(outside, "precious/data.txt"), "utf8")).toBe("data");
    expect(await readFile(join(root, "inner.txt"), "utf8")).toBe("inner");
    await ops.undo();
    expect(await readlink(join(root, "link-in"))).toBe("inner.txt");
    await ops.undo();
    expect(await readlink(join(root, "link-out"))).toBe(join(outside, "precious"));
  });

  test("undo of a delete refuses while the path is occupied", async () => {
    const { root, ops } = await setup();
    await writeTree(root, { "x.txt": "original" });
    await ops.delete("x.txt");
    await writeFile(join(root, "x.txt"), "replacement");
    await expectCode(ops.undo(), "ALREADY_EXISTS");
    expect(await readFile(join(root, "x.txt"), "utf8")).toBe("replacement");
    expect(ops.canUndo).toBe(true);
  });

  test("restores into parent folders that were removed meanwhile", async () => {
    const { root, ops } = await setup();
    await writeTree(root, { "p/q/file.txt": "f" });
    await ops.delete("p/q/file.txt");
    await rm(join(root, "p"), { recursive: true });
    const result = await ops.undo();
    expect(await readFile(join(root, "p/q/file.txt"), "utf8")).toBe("f");
    expect(result.changedPaths).toEqual(["p/q/file.txt", "p", "p/q"]);
    ops.clearUndo();
    expect(ops.canUndo).toBe(false);
  });

  test("cross-device moves copy then remove, and restore the same way", async () => {
    const { root, trashDir, ops } = await setup({ exdev: true });
    await writeTree(root, { "dir/a.txt": "A", "dir/sub/b.txt": "B" });
    await symlink("a.txt", join(root, "dir/link"));
    await ops.delete("dir");
    expect(await exists(join(root, "dir"))).toBe(false);
    expect((await readdir(trashDir)).length).toBe(1);
    await ops.undo();
    expect(await readFile(join(root, "dir/sub/b.txt"), "utf8")).toBe("B");
    expect(await readlink(join(root, "dir/link"))).toBe("a.txt");
  });

  test("cross-device size guard refuses large entries and leaves them in place", async () => {
    const { root, ops } = await setup({ exdev: true, maxCrossDeviceBytes: 10 });
    await writeTree(root, { "big.bin": "x".repeat(100) });
    await expectCode(ops.delete("big.bin"), "TOO_LARGE");
    expect(await exists(join(root, "big.bin"))).toBe(true);
    expect(ops.canUndo).toBe(false);
  });

  test("permanent delete is not undoable", async () => {
    const { root, ops } = await setup();
    await writeTree(root, { "gone/x.txt": "" });
    await ops.delete("gone", { permanent: true });
    expect(await exists(join(root, "gone"))).toBe(false);
    expect(ops.canUndo).toBe(false);
  });

  test("pruneTrash removes old and excess items but never ones still undoable", async () => {
    const { root, trashDir, ops } = await setup();
    await writeTree(root, { "a.txt": "a".repeat(100), "b.txt": "b".repeat(100), "c.txt": "c".repeat(100) });
    await ops.delete("a.txt");
    await ops.delete("b.txt");
    expect(await ops.pruneTrash({ maxAgeDays: 0, maxBytes: 0 })).toEqual({ removed: 0, freedBytes: 0 });
    ops.clearUndo();
    // Age one item by rewriting its metadata.
    const [oldest] = (await readdir(trashDir)).sort();
    const metaPath = join(trashDir, oldest as string, "meta.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as { deletedAt: number };
    meta.deletedAt -= 10 * 86_400_000;
    await writeFile(metaPath, JSON.stringify(meta));
    const byAge = await ops.pruneTrash({ maxAgeDays: 7 });
    expect(byAge.removed).toBe(1);
    expect(byAge.freedBytes).toBeGreaterThanOrEqual(100);
    await ops.delete("c.txt");
    ops.clearUndo();
    const bySize = await ops.pruneTrash({ maxBytes: 0 });
    expect(bySize.removed).toBe(2);
    expect(await readdir(trashDir)).toEqual([]);
  });
});
