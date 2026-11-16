/**
 * Minimal, read-only Git invocations used by the filesystem and search services
 * (ignore detection, file listing, grep).
 *
 * They run with exactly the Git adapter's hardening for read commands
 * (`readOnlyGitInvocation` in `src/adapters/git/environment.ts`): the same base flags (no pager,
 * no fsmonitor hook, no colors), the same environment (`GIT_OPTIONAL_LOCKS=0` so `index.lock` is
 * never taken, `GIT_NO_LAZY_FETCH=1`, no prompts, no editor, inherited `GIT_DIR` and friends
 * removed) and a detached session, so a hostile `.git/config` gets no more here than it gets
 * from the Source Control panel. Every call goes through the kernel `run()`/`runStreaming()`
 * with an argv array.
 */
import { readOnlyGitInvocation } from "@/adapters/git/environment";
import { log } from "@/core/log";
import { type RunOptions, type RunResult, run } from "@/core/process";

const logger = log.child("fs:git");

export type GitEnv = Record<string, string | undefined>;

export interface GitCallOptions extends Omit<RunOptions, "env"> {
  env?: GitEnv;
}

/**
 * Runs Git and returns its result, or `null` when Git could not be started at all (not
 * installed). A non-zero exit code is returned, not thrown: callers decide what it means.
 */
export async function runGit(
  args: readonly string[],
  options: GitCallOptions = {},
): Promise<RunResult | null> {
  // `options.env` are overrides merged over `process.env` (tests isolate the Git config with them).
  const call = readOnlyGitInvocation(args, options.env);
  try {
    return await run(call.argv, { ...options, env: call.env, detached: call.detached });
  } catch (error) {
    logger.warn("git could not be started", { error });
    return null;
  }
}

/**
 * Whether `dir` is inside a Git work tree. False when Git is missing, `dir` is not in a
 * repository, or `dir` is inside a `.git` directory.
 */
export async function isInsideGitWorkTree(dir: string, env?: GitEnv, signal?: AbortSignal): Promise<boolean> {
  const result = await runGit(["rev-parse", "--is-inside-work-tree"], {
    cwd: dir,
    env,
    signal,
    timeoutMs: 10_000,
  });
  return result !== null && result.code === 0 && result.stdout.trim() === "true";
}

/** Splits NUL-terminated Git output (`-z`), dropping the empty tail. */
export function splitNul(output: string): string[] {
  if (output.length === 0) return [];
  const parts = output.split("\0");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}
