import { describe, expect, test } from "bun:test";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileTree, type FileTreeOptions } from "@/adapters/filesystem/file-tree";
import type { TreeRow } from "@/adapters/filesystem/file-tree-types";
import { commitAll, createTempDirs, GIT_TEST_ENV, git, initRepo, writeTree } from "./helpers";

const tempDir = createTempDirs("lucy-tree-git-");

function makeTree(root: string, options: Partial<FileTreeOptions> = {}): FileTree {
  return new FileTree({ root, locale: "en", gitEnv: GIT_TEST_ENV, ...options });
}

function ignoredPaths(rows: readonly TreeRow[]): string[] {
  return rows.flatMap((row) => (row.type === "entry" && row.entry.isIgnored ? [row.entry.path] : []));
}

function allPaths(rows: readonly TreeRow[]): string[] {
  return rows.flatMap((row) => (row.type === "entry" ? [row.entry.path] : []));
}

async function fixtureRepo(): Promise<string> {
  const root = await tempDir();
  await writeTree(root, {
    ".gitignore": "build/\n*.log\nnode_modules\n",
    "src/main.ts": "",
    "src/.gitignore": "generated.ts\n",
    "src/generated.ts": "",
    "build/out/bundle.js": "",
    "node_modules/pkg/index.js": "",
    "app.log": "",
    "tracked.log": "",
  });
  await initRepo(root);
  await commitAll(root);
  // A tracked file matching an ignore rule is not ignored (Git's and VS Code's behavior).
  await git(root, "add", "-f", "tracked.log");
  await git(root, "commit", "-q", "-m", "force-add");
  return root;
}

describe("FileTree ignore detection", () => {
  test("flags ignored entries using Git, including nested .gitignore files", async () => {
    const root = await fixtureRepo();
    await writeFile(join(root, "late.log"), "");
    const tree = makeTree(root);
    await tree.expand("src");
    await tree.expand("build");
    await tree.expand("build/out");
    const ignored = ignoredPaths(tree.getVisibleRows());
    expect(ignored).toContain("build");
    expect(ignored).toContain("build/out"); // Inherited without asking Git.
    expect(ignored).toContain("build/out/bundle.js");
    expect(ignored).toContain("node_modules");
    expect(ignored).toContain("late.log");
    expect(ignored).toContain("src/generated.ts");
    expect(ignored).not.toContain("src/main.ts");
    expect(tree.getEntry("app.log")?.isIgnored).toBe(true);
    expect(tree.getEntry("tracked.log")?.isIgnored).toBe(false);
    tree.dispose();
  });

  test("showIgnored=false hides ignored entries", async () => {
    const root = await fixtureRepo();
    await writeFile(join(root, "late.log"), "");
    const tree = makeTree(root, { showIgnored: false });
    await tree.initialize();
    const visible = allPaths(tree.getVisibleRows());
    expect(visible).not.toContain("build");
    expect(visible).not.toContain("late.log");
    expect(visible).toContain("src");
    tree.dispose();
  });

  test("a .gitignore change picked up from a watch batch updates flags", async () => {
    const root = await fixtureRepo();
    await writeFile(join(root, "notes.txt"), "");
    const tree = makeTree(root);
    await tree.initialize();
    expect(tree.getEntry("notes.txt")?.isIgnored).toBe(false);
    await writeFile(join(root, ".gitignore"), "build/\n*.log\nnode_modules\nnotes.txt\n");
    await tree.handleWatchBatch({ paths: [".gitignore"], gitMetaChanged: false, overflow: false });
    expect(tree.getEntry("notes.txt")?.isIgnored).toBe(true);
    tree.dispose();
  });

  test("outside a repository nothing is ignored", async () => {
    const root = await tempDir();
    await writeTree(root, { ".gitignore": "*.log\n", "a.log": "" });
    const tree = makeTree(root);
    await tree.initialize();
    expect(ignoredPaths(tree.getVisibleRows())).toEqual([]);
    tree.dispose();
  });

  test("nested repositories answer for their own subtree", async () => {
    const root = await tempDir();
    await writeTree(root, {
      "proj/.gitignore": "dist/\n",
      "proj/dist/x.js": "",
      "proj/src/y.ts": "",
      "plain/z.txt": "",
    });
    await initRepo(join(root, "proj"));
    const tree = makeTree(root);
    await tree.expand("proj");
    expect(tree.getEntry("proj/dist")?.isIgnored).toBe(true);
    expect(tree.getEntry("proj/src")?.isIgnored).toBe(false);
    tree.dispose();
  });

  test("fails soft when Git cannot be started", async () => {
    const root = await fixtureRepo();
    const tree = makeTree(root, { gitEnv: { ...GIT_TEST_ENV, PATH: "/nonexistent-lucy-bin" } });
    await tree.initialize();
    expect(ignoredPaths(tree.getVisibleRows())).toEqual([]);
    expect(allPaths(tree.getVisibleRows())).toContain("build");
    tree.dispose();
  });

  test("children of a symlinked folder are listed without asking Git (Git refuses those paths)", async () => {
    const root = await fixtureRepo();
    await symlink("src", join(root, "link"));
    const tree = makeTree(root);
    await tree.expand("link");
    expect(tree.getEntry("link/main.ts")?.isIgnored).toBe(false);
    expect(tree.getEntry("link")?.error).toBeNull();
    tree.dispose();
  });
});
