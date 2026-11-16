/**
 * Asks Git which paths are ignored. Git is the only complete implementation of nested
 * `.gitignore` files, `.git/info/exclude` and `core.excludesFile`, so we never reimplement
 * the rules. One batched `git check-ignore --stdin -z` per directory load.
 *
 * Fails soft: when Git is missing, the directory is not in a repository, or Git refuses the
 * batch (for example a path inside a submodule), nothing is reported as ignored.
 * Tracked files are never reported as ignored (Git's default), matching VS Code.
 */
import { log } from "@/core/log";
import { type GitEnv, isInsideGitWorkTree, runGit, splitNul } from "./git-probe";

const logger = log.child("fs:ignore");

export class GitIgnoreOracle {
  private readonly workTreeCache = new Map<string, Promise<boolean>>();

  constructor(private readonly env?: GitEnv) {}

  /** Cached `rev-parse --is-inside-work-tree` for an absolute directory. */
  isInWorkTree(absDir: string): Promise<boolean> {
    let cached = this.workTreeCache.get(absDir);
    if (!cached) {
      cached = isInsideGitWorkTree(absDir, this.env);
      this.workTreeCache.set(absDir, cached);
    }
    return cached;
  }

  /** Forget cached repository detection (for example after `git init`). */
  reset(): void {
    this.workTreeCache.clear();
  }

  /**
   * Returns the subset of `relPaths` (relative to `cwd`, exactly as given) that Git ignores.
   * Directory paths should carry a trailing "/" so directory-only patterns match without
   * Git having to `lstat` them.
   */
  async checkIgnored(cwd: string, relPaths: readonly string[], signal?: AbortSignal): Promise<Set<string>> {
    const ignored = new Set<string>();
    if (relPaths.length === 0) return ignored;
    const result = await runGit(["check-ignore", "--stdin", "-z"], {
      cwd,
      env: this.env,
      stdin: `${relPaths.join("\0")}\0`,
      signal,
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024 * 1024,
    });
    if (result === null) return ignored;
    // 0: some ignored, 1: none ignored, anything else: Git refused the batch.
    if (result.code !== 0) {
      if (result.code !== 1 && !result.aborted) {
        logger.warn("git check-ignore failed", { code: result.code, stderr: result.stderr.slice(0, 500) });
      }
      return ignored;
    }
    for (const path of splitNul(result.stdout)) ignored.add(path);
    return ignored;
  }
}
