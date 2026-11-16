import { describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileIndex, type FileIndexOptions } from "@/adapters/search/file-index";
import { isLucyError } from "@/core/errors";
import { which } from "@/core/process";
import { commitAll, createTempDirs, GIT_TEST_ENV, git, initRepo, writeTree } from "../filesystem/helpers";

const tempDir = createTempDirs("lucy-index-");
const hasRipgrep = which("rg") !== null;

function makeIndex(root: string, options: Partial<FileIndexOptions> = {}): FileIndex {
  return new FileIndex({ root, env: GIT_TEST_ENV, ...options });
}

const LONG_SEGMENT = "d".repeat(200);

async function gitFixture(): Promise<string> {
  const root = await tempDir();
  await writeTree(root, {
    ".gitignore": "*.log\nbuild/\n",
    "src/a.ts": "",
    "src/deleted.ts": "",
    "docs/ığüşöç İstanbul.md": "",
    [`${LONG_SEGMENT}/${LONG_SEGMENT}/deep.txt`]: "",
  });
  await initRepo(root);
  await commitAll(root);
  // A submodule entry (gitlink) is a folder, not a file: it must not be listed.
  const head = (await git(root, "rev-parse", "HEAD")).trim();
  await git(root, "update-index", "--add", "--cacheinfo", `160000,${head},vendor/sub`);
  await writeTree(root, {
    "src/untracked.ts": "",
    "app.log": "",
    "build/out.js": "",
    ".hidden/config": "",
    "nested/inner.txt": "",
  });
  await initRepo(join(root, "nested")); // A nested repository is reported as "nested/".
  await rm(join(root, "src/deleted.ts"));
  return root;
}

describe("FileIndex strategies", () => {
  test("git: tracked plus untracked, without ignored, deleted, gitlinks or nested repositories", async () => {
    const root = await gitFixture();
    const result = await makeIndex(root).list();
    expect(result.strategy).toBe("git");
    expect(result.truncated).toBe(false);
    expect(result.files).toEqual([
      ".gitignore",
      ".hidden/config",
      `${LONG_SEGMENT}/${LONG_SEGMENT}/deep.txt`,
      "docs/ığüşöç İstanbul.md",
      "src/a.ts",
      "src/untracked.ts",
    ]);
  });

  test("falls back to the walk outside a repository; the walk skips excluded names and symlinked folders", async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await writeTree(outside, { "x.txt": "" });
    await writeTree(root, {
      "a.txt": "",
      ".env": "",
      "node_modules/pkg/index.js": "",
      ".git/HEAD": "",
      "sub/b.txt": "",
      "ığüş/ç.md": "",
    });
    await symlink("a.txt", join(root, "file-link"));
    await symlink(outside, join(root, "dir-link"));
    await symlink("missing", join(root, "broken-link"));
    const result = await makeIndex(root, { ripgrepPath: null }).list();
    expect(result.strategy).toBe("walk");
    expect(result.files).toEqual([".env", "a.txt", "file-link", "sub/b.txt", "ığüş/ç.md"]);
  });

  test("the walk reports truncation at the file and depth limits", async () => {
    const root = await tempDir();
    await writeTree(root, Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}.txt`, ""])));
    const capped = await makeIndex(root, { strategies: ["walk"], maxFiles: 10 }).list();
    expect(capped).toMatchObject({ truncated: true, strategy: "walk" });
    expect(capped.files.length).toBe(10);

    const deep = await tempDir();
    await writeTree(deep, { "a/b/c/d/e.txt": "", "top.txt": "" });
    const shallow = await makeIndex(deep, { strategies: ["walk"], maxDepth: 2 }).list();
    expect(shallow.truncated).toBe(true);
    expect(shallow.files).toEqual(["top.txt"]);
  });

  test.skipIf(!hasRipgrep)("ripgrep: lists hidden files, skips .git", async () => {
    const root = await tempDir();
    await writeTree(root, { "a.txt": "", ".env": "", ".git/HEAD": "", "sub/b.txt": "" });
    const result = await makeIndex(root, { strategies: ["ripgrep"] }).list();
    expect(result.strategy).toBe("ripgrep");
    expect(result.files).toEqual([".env", "a.txt", "sub/b.txt"]);
  });

  test("ripgrep is skipped when unavailable", async () => {
    const root = await tempDir();
    await writeTree(root, { "a.txt": "" });
    const result = await makeIndex(root, { strategies: ["ripgrep", "walk"], ripgrepPath: null }).list();
    expect(result.strategy).toBe("walk");
  });

  test("a broken Git falls through to the next strategy", async () => {
    const root = await gitFixture();
    const result = await makeIndex(root, {
      env: { ...GIT_TEST_ENV, PATH: "/nonexistent-lucy-bin" },
      ripgrepPath: null,
    }).list();
    expect(result.strategy).toBe("walk");
    expect(result.files).toContain("app.log"); // The walk does not know about ignore rules.
  });
});

describe("FileIndex caching and cancellation", () => {
  test("caches, shares concurrent calls, and recomputes after invalidate", async () => {
    const root = await tempDir();
    await writeTree(root, { "a.txt": "" });
    const index = makeIndex(root, { strategies: ["walk"] });
    const [first, second] = await Promise.all([index.list(), index.list()]);
    expect(first).toBe(second);
    expect(await index.list()).toBe(first);
    expect(index.peek()).toBe(first);
    await writeFile(join(root, "b.txt"), "");
    expect((await index.list()).files).toEqual(["a.txt"]);
    index.invalidate();
    expect(index.peek()).toBeNull();
    expect((await index.list()).files).toEqual(["a.txt", "b.txt"]);
  });

  test("an aborted caller is rejected; other callers still get the result", async () => {
    const root = await tempDir();
    await writeTree(
      root,
      Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`d${i % 50}/f${i}.txt`, ""])),
    );
    const index = makeIndex(root, { strategies: ["walk"] });
    const controller = new AbortController();
    const aborted = index.list(controller.signal);
    const survivor = index.list();
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "CANCELLED" });
    expect((await survivor).files.length).toBe(2000);

    const already = new AbortController();
    already.abort();
    try {
      await makeIndex(root).list(already.signal);
      throw new Error("expected cancellation");
    } catch (error) {
      expect(isLucyError(error, "CANCELLED")).toBe(true);
    }
  });

  test("20k files: walk and git listing times", async () => {
    const root = await tempDir();
    for (let d = 0; d < 20; d++) {
      await mkdir(join(root, `dir-${d}`));
      await Promise.all(
        Array.from({ length: 1000 }, (_, i) => writeFile(join(root, `dir-${d}`, `file-${i}.ts`), "")),
      );
    }
    const walk = await makeIndex(root, { strategies: ["walk"] }).list();
    await initRepo(root);
    const viaGit = await makeIndex(root, { strategies: ["git"] }).list();
    console.log(
      `[file-index] 20k files: walk ${walk.durationMs.toFixed(1)} ms, git ls-files (untracked) ${viaGit.durationMs.toFixed(1)} ms`,
    );
    expect(walk.files.length).toBe(20_000);
    expect(viaGit.files.length).toBe(20_000);
    expect(viaGit.files).toEqual(walk.files);
  }, 60_000);
});
