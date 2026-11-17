import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GitRepositoryManager,
  GitService,
  MockGitAdapter,
  repositoryLabelPath,
  scanForRepositories,
} from "@/adapters/git";
import { isLucyError } from "@/core/errors";
import { registerCleanup, tempDir } from "./support";

registerCleanup();

/** A fake repository is any folder with a `.git` entry; scanning never runs Git. */
function fakeRepo(path: string, gitFile = false): void {
  mkdirSync(path, { recursive: true });
  if (gitFile) writeFileSync(join(path, ".git"), "gitdir: elsewhere\n");
  else mkdirSync(join(path, ".git"));
}

function tree(): string {
  const root = tempDir();
  fakeRepo(join(root, "alpha"));
  fakeRepo(join(root, "group", "beta"));
  fakeRepo(join(root, "group", "deep", "gamma"));
  fakeRepo(join(root, "a", "b", "c", "too-deep"));
  fakeRepo(join(root, "worktree"), true);
  fakeRepo(join(root, "alpha", "vendored"));
  fakeRepo(join(root, "node_modules", "lib"));
  fakeRepo(join(root, ".hidden", "repo"));
  fakeRepo(join(root, "dist", "repo"));
  mkdirSync(join(root, "plain"));
  return root;
}

describe("scanForRepositories", () => {
  test("finds repositories down to the depth, skipping heavy, hidden and nested ones", async () => {
    const root = tree();
    const result = await scanForRepositories(root, { depth: 3 });
    expect(result.roots.map((path) => repositoryLabelPath(root, path))).toEqual([
      "alpha",
      "group/beta",
      "group/deep/gamma",
      "worktree",
    ]);
    expect(result.truncated).toBe(false);
  });

  test("depth limits", async () => {
    const root = tree();
    expect((await scanForRepositories(root, { depth: 0 })).roots).toEqual([]);
    const one = await scanForRepositories(root, { depth: 1 });
    expect(one.roots.map((path) => repositoryLabelPath(root, path))).toEqual(["alpha", "worktree"]);
    const four = await scanForRepositories(root, { depth: 4 });
    expect(four.roots.map((path) => repositoryLabelPath(root, path))).toContain("a/b/c/too-deep");
  });

  test("symbolic links are not followed", async () => {
    const root = tempDir();
    const outside = tempDir();
    fakeRepo(join(outside, "elsewhere"));
    symlinkSync(outside, join(root, "link"));
    symlinkSync(join(outside, "elsewhere"), join(root, "repo-link"));
    expect((await scanForRepositories(root, { depth: 3 })).roots).toEqual([]);
  });

  test("the repository and directory caps stop the search and say so", async () => {
    const root = tempDir();
    for (let i = 0; i < 12; i++) fakeRepo(join(root, `repo-${String(i).padStart(2, "0")}`));
    const capped = await scanForRepositories(root, { depth: 2, maxRepositories: 5 });
    expect(capped.roots).toHaveLength(5);
    expect(capped).toMatchObject({ truncated: true, limitedBy: "repositories" });
    const dirs = await scanForRepositories(root, { depth: 2, maxDirectories: 3 });
    expect(dirs).toMatchObject({ truncated: true, limitedBy: "directories" });
  });

  test("cancellation", async () => {
    const abort = new AbortController();
    abort.abort();
    const error = await scanForRepositories(tree(), { depth: 3, signal: abort.signal }).catch(
      (e: unknown) => e,
    );
    expect(isLucyError(error, "CANCELLED")).toBe(true);
  });

  test("a wide tree is fast", async () => {
    const root = tempDir();
    for (let i = 0; i < 40; i++) {
      for (let j = 0; j < 25; j++) mkdirSync(join(root, `p${i}`, `d${j}`), { recursive: true });
      if (i % 4 === 0) fakeRepo(join(root, `p${i}`, "repo"));
    }
    const started = performance.now();
    const result = await scanForRepositories(root, { depth: 3 });
    const ms = performance.now() - started;
    console.log(
      `scan: ${result.directoriesVisited} folders, ${result.roots.length} repositories in ${ms.toFixed(1)} ms`,
    );
    expect(result.roots).toHaveLength(10);
    expect(ms).toBeLessThan(2000);
  });
});

describe("GitRepositoryManager", () => {
  function services() {
    const created: string[] = [];
    const refreshed: string[] = [];
    const make = (root: string) => {
      const mock = new MockGitAdapter({ repository: { root, workspaceRoot: root } });
      const service = new GitService(async () => mock);
      const original = service.scheduleRefresh.bind(service);
      service.scheduleRefresh = () => {
        refreshed.push(root);
        original(0);
      };
      return service;
    };
    return { created, refreshed, make };
  }

  test("scans, keeps the primary first, routes watcher paths, and staggers first refreshes", async () => {
    const root = tree();
    const { refreshed, make } = services();
    const primary = make(root);
    const manager = new GitRepositoryManager({
      workspaceRoot: root,
      primary,
      createService: (repoRoot) => make(repoRoot),
      depth: () => 3,
      staggerMs: 5,
    });
    try {
      await primary.refresh();
      await manager.scan();
      expect(manager.entries.map((entry) => repositoryLabelPath(root, entry.root))).toEqual([
        "",
        "alpha",
        "group/beta",
        "group/deep/gamma",
        "worktree",
      ]);
      await Bun.sleep(60);
      expect(manager.repositories.length).toBe(5);

      refreshed.length = 0;
      manager.routeBatch(["group/beta/src/x.ts", "group/beta/y.ts", "alpha/z.ts"]);
      expect(new Set(refreshed)).toEqual(new Set([join(root, "group", "beta"), join(root, "alpha")]));

      expect(manager.entryForPath(join(root, "group", "beta", "src", "x.ts"))?.root).toBe(
        join(root, "group", "beta"),
      );
      expect(manager.entryForPath(join(root, "plain", "notes.md"))?.primary).toBe(true);

      // A removed repository disappears on the next scan; its service is disposed.
      const gamma = manager.entries.find((entry) => entry.root.endsWith("gamma"));
      const { rmSync } = await import("node:fs");
      rmSync(join(root, "group", "deep", "gamma", ".git"), { recursive: true });
      await manager.scan();
      expect(manager.entries.some((entry) => entry.root.endsWith("gamma"))).toBe(false);
      expect(gamma).toBeDefined();
    } finally {
      manager.dispose();
      primary.dispose();
    }
  });
});
