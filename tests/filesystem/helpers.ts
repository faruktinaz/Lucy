/**
 * Test helpers: temp directories (cleaned up after each file), file trees, and an isolated
 * Git environment that never reads the user's global or system configuration.
 */
import { afterAll } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "@/core/process";

/** No user/system config, no global excludes file, deterministic identity. */
export const GIT_TEST_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  // The default core.excludesFile lives under XDG_CONFIG_HOME even without a config file.
  XDG_CONFIG_HOME: "/dev/null/lucy-test-xdg",
  GIT_AUTHOR_NAME: "Lucy Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Lucy Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

/** Registers temp-dir cleanup for the calling test file and returns a factory. */
export function createTempDirs(prefix = "lucy-test-"): () => Promise<string> {
  const created: string[] = [];
  afterAll(async () => {
    for (const dir of created) {
      // Tests chmod some folders to 000; restore access so removal cannot fail.
      await run(["chmod", "-R", "u+rwx", dir]).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
  return async () => {
    // Under the per-run root (tests/setup.ts removes it after the last file): this helper's own
    // afterAll only runs for the first test file that imports it.
    const dir = await realpath(await mkdtemp(join(process.env.LUCY_TEST_ROOT ?? tmpdir(), prefix)));
    created.push(dir);
    return dir;
  };
}

/** Writes files (creating parents). A key ending in "/" creates an empty folder. */
export async function writeTree(root: string, files: Record<string, string | Uint8Array>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, ...path.split("/"));
    if (path.endsWith("/")) {
      await mkdir(abs, { recursive: true });
      continue;
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await run(["git", ...args], { cwd, env: GIT_TEST_ENV });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

export async function initRepo(root: string): Promise<void> {
  await git(root, "init", "-q", "-b", "main");
}

export async function commitAll(root: string, message = "commit"): Promise<void> {
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", message);
}

/** Polls `predicate` until it holds or the timeout expires. */
export async function waitFor(predicate: () => boolean, timeoutMs = 4000, intervalMs = 20): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Condition not met within ${timeoutMs} ms`);
    await Bun.sleep(intervalMs);
  }
}

export const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
