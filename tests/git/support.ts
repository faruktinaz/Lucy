/**
 * Shared setup for the Git adapter tests: every fixture and adapter is registered for cleanup so
 * a failing assertion can never leak a temp directory or a running process.
 */
import { afterEach, setDefaultTimeout } from "bun:test";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type GitCliAdapter, type GitCliAdapterOptions, openGitRepository } from "@/adapters/git";
import {
  createFixtureRepo,
  createTempDir,
  type FixtureOptions,
  type FixtureRepo,
} from "../helpers/git-fixture";

const cleanups: (() => void)[] = [];

/**
 * Registers `afterEach` cleanup for the calling test file. Also raises the per-test timeout:
 * these tests spawn dozens of real Git processes and must not flake on a loaded machine.
 */
export function registerCleanup(): void {
  setDefaultTimeout(30_000);
  afterEach(() => {
    while (cleanups.length > 0) {
      try {
        cleanups.pop()?.();
      } catch {
        // Keep cleaning up the rest.
      }
    }
  });
}

export function deferCleanup(fn: () => void): void {
  cleanups.push(fn);
}

export interface Setup {
  fx: FixtureRepo;
  git: GitCliAdapter;
}

/** Fixture repository plus an adapter opened on it with the isolated environment. */
export async function setup(
  options: FixtureOptions = {},
  adapter: GitCliAdapterOptions = {},
): Promise<Setup> {
  const fx = await createFixtureRepo(options);
  cleanups.push(() => fx.dispose());
  const git = await openGitRepository(fx.root, { ...adapter, env: { ...fx.env, ...adapter.env } });
  cleanups.push(() => git.dispose());
  return { fx, git };
}

export async function fixture(options: FixtureOptions = {}): Promise<FixtureRepo> {
  const fx = await createFixtureRepo(options);
  cleanups.push(() => fx.dispose());
  return fx;
}

export function tempDir(): string {
  const dir = createTempDir("lucy-git-test-");
  cleanups.push(() => dir.dispose());
  return dir.path;
}

export async function openAt(
  fx: FixtureRepo,
  cwd: string,
  options: GitCliAdapterOptions = {},
): Promise<GitCliAdapter> {
  const git = await openGitRepository(cwd, { ...options, env: { ...fx.env, ...options.env } });
  cleanups.push(() => git.dispose());
  return git;
}

/** Writes an executable shell script. */
export async function writeScript(path: string, body: string): Promise<string> {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

/** Creates a conflicting merge on `f.txt` (both modified) and leaves the repo mid-merge. */
export async function createConflict(fx: FixtureRepo, path = "f.txt"): Promise<void> {
  await fx.write(path, "base\n");
  await fx.commitAll("base");
  await fx.git("switch", "-q", "-c", "other");
  await fx.write(path, "theirs\n");
  await fx.commitAll("theirs");
  await fx.git("switch", "-q", "main");
  await fx.write(path, "ours\n");
  await fx.commitAll("ours");
  const merge = await fx.gitRaw(["merge", "other"]);
  if (merge.code === 0) throw new Error("expected a merge conflict");
}

export function joinRoot(fx: FixtureRepo, ...parts: string[]): string {
  return join(fx.root, ...parts);
}
