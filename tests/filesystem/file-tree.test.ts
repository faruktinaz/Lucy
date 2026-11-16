import { describe, expect, test } from "bun:test";
import { chmod, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileTree, type FileTreeOptions } from "@/adapters/filesystem/file-tree";
import type { TreeRow } from "@/adapters/filesystem/file-tree-types";
import { createTempDirs, isRoot, writeTree } from "./helpers";

const tempDir = createTempDirs("lucy-tree-");

function makeTree(root: string, options: Partial<FileTreeOptions> = {}): FileTree {
  return new FileTree({ root, detectIgnored: false, locale: "en", ...options });
}

function paths(rows: readonly TreeRow[]): string[] {
  return rows.map((row) =>
    row.type === "entry" ? row.entry.path : `[more ${row.parentPath}:${row.hiddenCount}]`,
  );
}

describe("FileTree basics", () => {
  test("empty directory has no rows and no error", async () => {
    const root = await tempDir();
    const tree = makeTree(root);
    await tree.initialize();
    expect(tree.getVisibleRows()).toEqual([]);
    expect(tree.getEntry("")?.error).toBeNull();
    expect(tree.getEntry("")?.loaded).toBe(true);
    tree.dispose();
  });

  test("missing root reports an error on the root entry instead of throwing", async () => {
    const root = join(await tempDir(), "does-not-exist");
    const tree = makeTree(root);
    await tree.initialize();
    expect(tree.getEntry("")?.error?.code).toBe("NOT_FOUND");
    expect(tree.getVisibleRows()).toEqual([]);
    tree.dispose();
  });

  test("sorts folders first, then natural, case-insensitive, locale-aware", async () => {
    const root = await tempDir();
    await writeTree(root, {
      "file10.txt": "",
      "file2.txt": "",
      "File1.txt": "",
      "zeta.md": "",
      "ılık.md": "",
      "İz.md": "",
      "çay.md": "",
      "cay.md": "",
      "b-dir/": "",
      "A-dir/": "",
    });
    const tree = makeTree(root);
    await tree.initialize();
    const order = paths(tree.getVisibleRows());
    expect(order.slice(0, 2)).toEqual(["A-dir", "b-dir"]);
    const at = (name: string) => order.indexOf(name);
    expect(at("File1.txt")).toBeLessThan(at("file2.txt"));
    expect(at("file2.txt")).toBeLessThan(at("file10.txt"));
    expect(Math.abs(at("cay.md") - at("çay.md"))).toBe(1);
    expect(at("İz.md")).toBeLessThan(at("ılık.md"));
    expect(at("ılık.md")).toBeLessThan(at("zeta.md"));
    tree.dispose();
  });

  test("is lazy: only expanded folders are read", async () => {
    const root = await tempDir();
    await writeTree(root, { "a/b/c.txt": "", "a/d.txt": "" });
    const tree = makeTree(root);
    await tree.initialize();
    expect(tree.getEntry("a")?.loaded).toBe(false);
    expect(tree.getEntry("a/b")).toBeUndefined();
    await tree.expand("a");
    expect(tree.getEntry("a")?.loaded).toBe(true);
    expect(tree.getEntry("a/b")?.loaded).toBe(false);
    tree.dispose();
  });

  test("rows carry depth, guides and last-child flags", async () => {
    const root = await tempDir();
    await writeTree(root, { "a/b/x.txt": "", "a/y.txt": "", "c.txt": "" });
    const tree = makeTree(root);
    await tree.expand("a");
    await tree.expand("a/b");
    const rows = tree.getVisibleRows();
    expect(paths(rows)).toEqual(["a", "a/b", "a/b/x.txt", "a/y.txt", "c.txt"]);
    const shape = rows.map((row) => [row.depth, row.guides, row.isLast]);
    expect(shape).toEqual([
      [0, [], false],
      [1, [true], false],
      [2, [true, true], true],
      [1, [true], true],
      [0, [], true],
    ]);
    tree.collapse("a");
    expect(paths(tree.getVisibleRows())).toEqual(["a", "c.txt"]);
    expect(tree.getEntry("a/b")?.expanded).toBe(true); // Kept for re-expansion.
    await tree.toggle("a");
    expect(paths(tree.getVisibleRows())).toEqual(["a", "a/b", "a/b/x.txt", "a/y.txt", "c.txt"]);
    tree.dispose();
  });

  test("returns the same rows array until something changes and coalesces change events", async () => {
    const root = await tempDir();
    await writeTree(root, { "a/x.txt": "", "b/y.txt": "" });
    const tree = makeTree(root);
    await tree.initialize();
    const first = tree.getVisibleRows();
    expect(tree.getVisibleRows()).toBe(first);
    let events = 0;
    tree.onDidChange(() => events++);
    tree.collapse("a"); // No-op: not expanded.
    await Promise.resolve();
    expect(events).toBe(0);
    await tree.expand("a");
    await Bun.sleep(0);
    expect(events).toBeGreaterThanOrEqual(1);
    expect(events).toBeLessThanOrEqual(3);
    expect(tree.getVisibleRows()).not.toBe(first);
    // A synchronous burst of changes produces exactly one notification.
    await tree.expand("b");
    await Bun.sleep(0);
    const before = events;
    tree.collapse("a");
    tree.collapse("b");
    tree.setOptions({ showHidden: false });
    tree.setOptions({ showHidden: true });
    await Bun.sleep(0);
    expect(events - before).toBe(1);
    tree.dispose();
  });

  test("visibility: hidden files shown by default, exclude list always hidden", async () => {
    const root = await tempDir();
    await writeTree(root, { ".env": "", ".DS_Store": "", ".git/HEAD": "", "app.log": "", "main.ts": "" });
    const tree = makeTree(root);
    await tree.initialize();
    expect(paths(tree.getVisibleRows())).toEqual([".env", "app.log", "main.ts"]);
    expect(tree.getEntry(".env")?.isHidden).toBe(true);
    tree.setOptions({ showHidden: false });
    expect(paths(tree.getVisibleRows())).toEqual(["app.log", "main.ts"]);
    tree.setOptions({ showHidden: true, exclude: ["*.log", ".git"] });
    expect(paths(tree.getVisibleRows())).toEqual([".DS_Store", ".env", "main.ts"]);
    tree.dispose();
  });

  test("names with control characters, Turkish and NFD names are stored raw", async () => {
    const root = await tempDir();
    const nfd = "çağ.md".normalize("NFD");
    await writeTree(root, { "bad\nname.txt": "", "\u0007bell": "", "ığüşöç İstanbul.txt": "", [nfd]: "" });
    const tree = makeTree(root);
    await tree.initialize();
    const names = paths(tree.getVisibleRows());
    expect(names).toContain("bad\nname.txt");
    expect(names).toContain("\u0007bell");
    expect(names).toContain("ığüşöç İstanbul.txt");
    const stored = names.find((name) => name.normalize("NFC") === "çağ.md");
    expect(stored).toBeDefined();
    // Lookup tolerates the other normalization; the stored path keeps the on-disk bytes.
    expect(tree.getEntry("çağ.md".normalize("NFC"))?.path).toBe(stored as string);
    tree.dispose();
  });
});

describe("FileTree large folders", () => {
  test("a 20k-entry folder lists without blocking and renders a capped page plus a 'more' row", async () => {
    const root = await tempDir();
    await mkdir(join(root, "big"));
    await Promise.all(
      Array.from({ length: 20_000 }, (_, i) => writeFile(join(root, "big", `file-${i}.txt`), "")),
    );
    const tree = makeTree(root, { maxChildrenRendered: 500 });
    await tree.initialize();
    let maxGap = 0;
    let last = performance.now();
    const ticker = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 1);
    const started = performance.now();
    await tree.expand("big");
    const elapsed = performance.now() - started;
    clearInterval(ticker);
    console.log(
      `[file-tree] 20k-entry folder: ${elapsed.toFixed(1)} ms, longest event-loop stall ${maxGap.toFixed(1)} ms`,
    );
    const rows = tree.getVisibleRows();
    expect(rows.length).toBe(1 + 500 + 1);
    const more = rows[rows.length - 1];
    expect(more?.type).toBe("more");
    if (more?.type === "more") expect(more.hiddenCount).toBe(19_500);
    expect(paths(rows).slice(1, 4)).toEqual(["big/file-0.txt", "big/file-1.txt", "big/file-2.txt"]);
    tree.showMore("big", 1000);
    expect(tree.getVisibleRows().length).toBe(1 + 1500 + 1);
    // Revealing an entry beyond the cap raises it.
    const index = await tree.expandTo("big/file-19999.txt");
    expect(index).toBeGreaterThan(0);
    expect(maxGap).toBeLessThan(250);
    tree.dispose();
  });
});

describe("FileTree robustness", () => {
  test.skipIf(isRoot)("a folder without read permission becomes an error entry", async () => {
    const root = await tempDir();
    await writeTree(root, { "locked/secret.txt": "x", "open.txt": "" });
    await chmod(join(root, "locked"), 0o000);
    const tree = makeTree(root);
    await tree.expand("locked");
    const entry = tree.getEntry("locked");
    expect(entry?.error?.code).toBe("PERMISSION_DENIED");
    expect(entry?.loaded).toBe(false);
    expect(paths(tree.getVisibleRows())).toEqual(["locked", "open.txt"]);
    await chmod(join(root, "locked"), 0o755);
    await tree.expand("locked"); // An explicit expand retries.
    expect(tree.getEntry("locked")?.error).toBeNull();
    expect(paths(tree.getVisibleRows())).toContain("locked/secret.txt");
    tree.dispose();
  });

  test("symlinks: broken, escaping, loops; never entered automatically", async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await writeTree(outside, { "ext.txt": "outside" });
    await writeTree(root, { "a/inner.txt": "", "real/file.txt": "" });
    await symlink(join(root, "missing"), join(root, "broken"));
    await symlink(outside, join(root, "escape"));
    await symlink(root, join(root, "loop"));
    await symlink("../a", join(root, "a", "self"));
    await symlink("real", join(root, "alias"));
    const tree = makeTree(root);
    await tree.initialize();
    expect(tree.getEntry("broken")).toMatchObject({ isSymlink: true, symlinkTarget: "broken", kind: "file" });
    expect(tree.getEntry("escape")).toMatchObject({
      isSymlink: true,
      symlinkTarget: "outside",
      kind: "directory",
      loaded: false,
    });
    expect(tree.getEntry("alias")).toMatchObject({
      symlinkTarget: "inside",
      kind: "directory",
      loaded: false,
    });

    await tree.expand("escape");
    expect(tree.getEntry("escape/ext.txt")).toMatchObject({ isExternal: true });
    await tree.expand("alias");
    expect(tree.getEntry("alias/file.txt")).toMatchObject({ isExternal: false });

    await tree.expand("loop");
    expect(tree.getEntry("loop")?.error?.code).toBe("UNSUPPORTED");
    await tree.expand("a");
    await tree.expand("a/self");
    expect(tree.getEntry("a/self")?.error?.message).toContain("loop");
    tree.dispose();
  });

  test("expandTo reveals nested entries; unknown paths return -1", async () => {
    const root = await tempDir();
    await writeTree(root, { "src/deep/er/file.ts": "", "src/other.ts": "" });
    const tree = makeTree(root);
    const index = await tree.expandTo("src/deep/er/file.ts");
    expect(index).toBe(tree.indexOfPath("src/deep/er/file.ts"));
    expect(paths(tree.getVisibleRows())).toEqual([
      "src",
      "src/deep",
      "src/deep/er",
      "src/deep/er/file.ts",
      "src/other.ts",
    ]);
    expect(await tree.expandTo("src/nope.ts")).toBe(-1);
    expect(await tree.expandTo("src/other.ts/x")).toBe(-1);
    tree.dispose();
  });

  test("collapseAll, export and restore the expanded set (lazily under collapsed parents)", async () => {
    const root = await tempDir();
    await writeTree(root, { "a/b/c/x.txt": "", "d/y.txt": "", "e/z.txt": "" });
    const tree = makeTree(root);
    await tree.expandTo("a/b/c/x.txt");
    await tree.expand("d");
    tree.collapse("a"); // a/b and a/b/c stay expanded under a collapsed parent.
    const saved = tree.getExpandedPaths().sort();
    expect(saved).toEqual(["a/b", "a/b/c", "d"]);
    tree.collapseAll();
    expect(tree.getExpandedPaths()).toEqual([]);
    tree.dispose();

    const restored = makeTree(root);
    await restored.restoreExpanded(saved);
    expect(paths(restored.getVisibleRows())).toEqual(["a", "d", "d/y.txt", "e"]);
    expect(restored.getEntry("a/b")).toBeUndefined(); // Not read: its parent is collapsed.
    await restored.expand("a");
    expect(paths(restored.getVisibleRows())).toEqual([
      "a",
      "a/b",
      "a/b/c",
      "a/b/c/x.txt",
      "d",
      "d/y.txt",
      "e",
    ]);
    restored.dispose();
  });

  test("refresh re-reads loaded folders, keeping expansion and identity", async () => {
    const root = await tempDir();
    await writeTree(root, { "src/a.ts": "", "src/b.ts": "", "src/lib/c.ts": "", "top.txt": "" });
    const tree = makeTree(root);
    await tree.expand("src");
    await tree.expand("src/lib");
    const libBefore = tree.getEntry("src/lib");
    await writeFile(join(root, "src", "new.ts"), "");
    await rm(join(root, "src", "b.ts"));
    await writeFile(join(root, "src", "lib", "d.ts"), "");
    await tree.refresh();
    expect(paths(tree.getVisibleRows())).toEqual([
      "src",
      "src/lib",
      "src/lib/c.ts",
      "src/lib/d.ts",
      "src/a.ts",
      "src/new.ts",
      "top.txt",
    ]);
    expect(tree.getEntry("src/lib")).toEqual(libBefore as NonNullable<typeof libBefore>);
    expect(tree.indexOfPath("src/lib")).toBe(1);
    tree.dispose();
  });

  test("watch batches re-read parents; a rename reported only by its source still shows the destination", async () => {
    const root = await tempDir();
    await writeTree(root, { "a/x.txt": "", "b/keep.txt": "" });
    const tree = makeTree(root);
    await tree.expand("a");
    await tree.expand("b");
    await writeFile(join(root, "a", "created.txt"), "");
    await tree.handleWatchBatch({ paths: ["a/created.txt"], gitMetaChanged: false, overflow: false });
    expect(paths(tree.getVisibleRows())).toContain("a/created.txt");

    await rename(join(root, "a", "x.txt"), join(root, "b", "moved.txt"));
    // Bun on macOS reports only the source path of a rename.
    await tree.handleWatchBatch({ paths: ["a/x.txt"], gitMetaChanged: false, overflow: false });
    const after = paths(tree.getVisibleRows());
    expect(after).not.toContain("a/x.txt");
    expect(after).toContain("b/moved.txt");

    await writeFile(join(root, "b", "overflowed.txt"), "");
    await tree.handleWatchBatch({ paths: [], gitMetaChanged: false, overflow: true });
    expect(paths(tree.getVisibleRows())).toContain("b/overflowed.txt");
    tree.dispose();
  });
});

describe("FileTree filter", () => {
  test("finds files in never-expanded folders through listAllFiles and shows their ancestors", async () => {
    const root = await tempDir();
    const files = [
      "src/components/Button.tsx",
      "src/components/Card.tsx",
      "src/util/İstanbul.ts",
      "README.md",
    ];
    await writeTree(root, Object.fromEntries(files.map((file) => [file, ""])));
    const tree = makeTree(root, { listAllFiles: async () => files });
    await tree.expandTo("README.md");
    await tree.setFilter("button");
    expect(paths(tree.getVisibleRows())).toEqual(["src", "src/components", "src/components/Button.tsx"]);
    expect(tree.getFilterState()).toMatchObject({
      text: "button",
      pending: false,
      matchCount: 1,
      truncated: false,
    });

    await tree.setFilter("ISTANBUL"); // Case- and accent-insensitive.
    expect(paths(tree.getVisibleRows())).toEqual(["src", "src/util", "src/util/İstanbul.ts"]);

    await tree.setFilter("components/c"); // "/" matches against the path.
    expect(paths(tree.getVisibleRows())).toEqual(["src", "src/components", "src/components/Card.tsx"]);

    tree.collapse("src/components");
    expect(paths(tree.getVisibleRows())).toEqual(["src", "src/components"]);

    await tree.setFilter("");
    expect(paths(tree.getVisibleRows())).toEqual(["src", "README.md"]);
    expect(tree.getFilterState().text).toBe("");
    tree.dispose();
  });

  test("without listAllFiles only loaded folders are searched; hidden files obey showHidden", async () => {
    const root = await tempDir();
    await writeTree(root, { "a/match.txt": "", "b/match.txt": "", ".hidden/match.txt": "" });
    const tree = makeTree(root);
    await tree.expand("a");
    await tree.expand(".hidden");
    await tree.setFilter("match");
    expect(paths(tree.getVisibleRows())).toEqual([".hidden", ".hidden/match.txt", "a", "a/match.txt"]);
    tree.setOptions({ showHidden: false });
    await tree.setFilter("match");
    expect(paths(tree.getVisibleRows())).toEqual(["a", "a/match.txt"]);
    tree.dispose();
  });

  test("caps the number of matches", async () => {
    const root = await tempDir();
    const files = Array.from({ length: 50 }, (_, i) => `dir/f${i}.txt`);
    const tree = makeTree(root, { listAllFiles: async () => files, maxFilterMatches: 10 });
    await tree.setFilter("f");
    expect(tree.getFilterState()).toMatchObject({ matchCount: 10, truncated: true });
    tree.dispose();
  });

  test("a superseded filter never overwrites a newer one", async () => {
    const root = await tempDir();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const files = ["one.txt", "two.txt"];
    const tree = makeTree(root, {
      listAllFiles: async () => {
        await gate;
        return files;
      },
    });
    const slow = tree.setFilter("one");
    const fast = tree.setFilter("two");
    release();
    await Promise.all([slow, fast]);
    expect(tree.getFilterState().text).toBe("two");
    expect(paths(tree.getVisibleRows())).toEqual(["two.txt"]);
    tree.dispose();
  });
});
