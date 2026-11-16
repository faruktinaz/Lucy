/**
 * Finds the repository that contains a workspace directory. Distinguishes the states the UI
 * explains differently: no Git installed, not a repository, an unsafe (foreign-owned) repository,
 * a bare repository and a usable working tree.
 */
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fromFsError, LucyError } from "@/core/errors";
import { classifyGitFailure, gitFailure, gitFailureKind, summarizeGitOutput } from "./errors";
import { GitRunner } from "./runner";
import type { GitDiscovery, GitRepositoryInfo } from "./types";

export const MINIMUM_GIT_VERSION = "2.25.0";

export interface GitDiscoveryOptions {
  /** Merged over `process.env` for every Git command (tests isolate configuration with it). */
  env?: Record<string, string | undefined>;
  /** Explicit Git executable; defaults to `git` on PATH. */
  gitPath?: string;
  timeoutMs?: number;
}

/** Parses `git version 2.50.1 (Apple Git-155)` into numbers; `null` when unrecognized. */
export function parseGitVersion(text: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function isGitVersionAtLeast(version: string, minimum: string): boolean {
  const have = parseGitVersion(version);
  const need = parseGitVersion(minimum);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++) {
    const a = have[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** Strips exactly the trailing newline Git adds, so values containing newlines stay intact. */
function value(stdout: string): string {
  return stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
}

async function realOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

export async function discoverRepository(
  cwd: string,
  options: GitDiscoveryOptions = {},
): Promise<GitDiscovery> {
  const workspaceRoot = resolve(cwd);
  // Spawning with a missing cwd fails exactly like a missing executable; check first so the
  // error names the real problem.
  try {
    const info = await stat(workspaceRoot);
    if (!info.isDirectory()) {
      throw new LucyError("INVALID_ARGUMENT", `Not a directory: ${workspaceRoot}`);
    }
  } catch (error) {
    if (error instanceof LucyError) throw error;
    throw fromFsError(error, workspaceRoot);
  }

  let runner: GitRunner;
  try {
    runner = new GitRunner({
      cwd: workspaceRoot,
      env: options.env,
      gitPath: options.gitPath,
      defaultTimeoutMs: options.timeoutMs ?? 15_000,
    });
  } catch (error) {
    if (gitFailureKind(error) === "git-missing") return { kind: "git-missing" };
    throw error;
  }

  try {
    let versionResult: Awaited<ReturnType<GitRunner["exec"]>>;
    try {
      versionResult = await runner.exec(["--version"]);
    } catch (error) {
      if (gitFailureKind(error) === "git-missing") return { kind: "git-missing" };
      throw error;
    }
    const gitVersion = value(versionResult.stdout).replace(/^git version\s*/, "");
    if (!isGitVersionAtLeast(gitVersion, MINIMUM_GIT_VERSION)) {
      return { kind: "git-too-old", gitVersion, minimumVersion: MINIMUM_GIT_VERSION };
    }

    const probeArgs = ["rev-parse", "--is-bare-repository", "--is-inside-work-tree", "--is-inside-git-dir"];
    const probe = await runner.exec(probeArgs);
    if (probe.code !== 0) {
      const kind = classifyGitFailure(probe.stderr);
      if (kind === "unsafe-repository") {
        return { kind: "unsafe-repository", cwd: workspaceRoot, message: summarizeGitOutput(probe.stderr) };
      }
      if (kind === "not-a-repository") return { kind: "not-a-repository", cwd: workspaceRoot };
      throw gitFailure({ args: probeArgs, exitCode: probe.code, stderr: probe.stderr, stdout: probe.stdout });
    }
    const [isBare, insideWorkTree] = probe.stdout.split("\n");

    const absoluteGitDir = await runner.git(["rev-parse", "--absolute-git-dir"]);
    const gitDir = await realOrSelf(value(absoluteGitDir.stdout));
    if (isBare === "true") return { kind: "bare-repository", gitDir, gitVersion };
    // Inside `.git` of a non-bare repository there is no working tree to show.
    if (insideWorkTree !== "true") return { kind: "not-a-repository", cwd: workspaceRoot };

    const commonDirArgs = isGitVersionAtLeast(gitVersion, "2.31.0")
      ? ["rev-parse", "--path-format=absolute", "--git-common-dir"]
      : ["rev-parse", "--git-common-dir"];
    const [toplevel, prefix, commonDirResult, precompose] = await Promise.all([
      runner.git(["rev-parse", "--show-toplevel"]),
      runner.git(["rev-parse", "--show-prefix"]),
      runner.git(commonDirArgs),
      runner.exec(["config", "--bool", "--get", "core.precomposeunicode"]),
    ]);
    const rawCommonDir = value(commonDirResult.stdout);
    const commonDir = await realOrSelf(
      isAbsolute(rawCommonDir) ? rawCommonDir : resolve(workspaceRoot, rawCommonDir),
    );

    const repository: GitRepositoryInfo = {
      root: await realOrSelf(value(toplevel.stdout)),
      gitDir,
      commonDir,
      isLinkedWorktree: gitDir !== commonDir,
      workspaceRoot,
      workspacePrefix: value(prefix.stdout).replace(/\/+$/, ""),
      gitVersion,
      precomposeUnicode: process.platform === "darwin" && value(precompose.stdout).trim() === "true",
    };
    return { kind: "repository", repository };
  } finally {
    runner.dispose();
  }
}
