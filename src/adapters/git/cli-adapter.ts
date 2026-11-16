/**
 * `GitAdapter` backed by the `git` executable.
 *
 * Every command goes through `this.git()` / `this.exec()` (see `runner.ts`), with paths after
 * `--` under `--literal-pathspecs`, path lists on stdin (`--pathspec-from-file`) where Git supports
 * it, and index-mutating commands serialized through one queue. See README.md for the threat model.
 */

import { discoverRepository, type GitDiscoveryOptions } from "./discovery";
import { gitFailure, gitFailureKind, gitPrecondition } from "./errors";
import { detectOperation } from "./operation";
import {
  LOG_FORMAT,
  parseLog,
  parseNumstat,
  parseRefs,
  parseRemotes,
  parseStashList,
  REF_FORMAT,
  STASH_FORMAT,
} from "./parsers";
import {
  chunkPaths,
  literalPathspec,
  literalPathspecs,
  normalizeRepoPath,
  normalizeRepoPaths,
  pathspecStdin,
} from "./paths";
import { createGitStatus, parsePorcelainV2 } from "./porcelain";
import { Coalescer, SerialQueue, withRetry } from "./queue";
import { type GitExecOptions, type GitExecResult, GitRunner } from "./runner";
import type {
  GitAdapter,
  GitBranchList,
  GitCallOptions,
  GitChange,
  GitCommit,
  GitCommitOptions,
  GitCommitResult,
  GitCreateBranchOptions,
  GitDiff,
  GitDiffMode,
  GitDiffOptions,
  GitDiffTarget,
  GitDiscardPreviewEntry,
  GitDiscardResult,
  GitFetchOptions,
  GitFileContent,
  GitLogOptions,
  GitPullOptions,
  GitPushOptions,
  GitPushResult,
  GitReadOptions,
  GitRemote,
  GitRepositoryInfo,
  GitRevision,
  GitStageAllOptions,
  GitStash,
  GitStashApplyOptions,
  GitStashPushOptions,
  GitStashPushResult,
  GitStatus,
} from "./types";
import { describeUntrackedFile, looksBinaryText, readWorktreeFile, statWorktreePath } from "./worktree-files";

export interface GitTimeouts {
  /** Read-only queries (diff, log, branches, ...). */
  read: number;
  /** One status attempt; a timed-out full untracked scan is retried once in collapsed mode. */
  status: number;
  /** Index/worktree mutations (stage, switch, stash, ...). */
  write: number;
  /** Commit, including hooks and signing. */
  commit: number;
  /** fetch / pull / push. */
  network: number;
}

export interface GitLimits {
  /** Status entries before `truncated` is set. */
  statusEntries: number;
  statusOutputBytes: number;
  /** Patch size cap (also the untracked file size cap for synthesized patches). */
  diffBytes: number;
  /** `fileAtRevision` content cap. */
  fileBytes: number;
}

export const DEFAULT_GIT_TIMEOUTS: Readonly<GitTimeouts> = {
  read: 30_000,
  status: 10_000,
  write: 120_000,
  commit: 600_000,
  network: 60_000,
};

export const DEFAULT_GIT_LIMITS: Readonly<GitLimits> = {
  statusEntries: 10_000,
  statusOutputBytes: 16 * 1024 * 1024,
  diffBytes: 4 * 1024 * 1024,
  fileBytes: 8 * 1024 * 1024,
};

export interface GitCliAdapterOptions extends GitDiscoveryOptions {
  timeouts?: Partial<GitTimeouts>;
  limits?: Partial<GitLimits>;
}

/**
 * Flags for every patch-producing command. External diff drivers and textconv filters are
 * commands taken from (possibly untrusted) repository config, so they never run; explicit
 * prefixes and blank-context settings keep the format stable for the renderer.
 */
const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"];
const DIFF_CONFIG = ["diff.noprefix=false", "diff.mnemonicPrefix=false", "diff.suppressBlankEmpty=false"];

const BINARY_PATCH = /^(?:Binary files .* differ|GIT binary patch)$/m;
const UNMERGED_NOTICE = /^\* Unmerged path .*\n/gm;
const UNBORN_LOG = /does not have any commits yet|bad (?:default )?revision 'HEAD'|unknown revision or path/i;

const STAGE_SPECS: Readonly<Record<string, string>> = { INDEX: "0", BASE: "1", OURS: "2", THEIRS: "3" };

/** Strips exactly the trailing newline Git adds. */
function value(stdout: string): string {
  return stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
}

/** A revision usable as `<rev>:<path>` and as an argument. No `:` (would change the path), no option look-alikes. */
function validateRevision(rev: string): string {
  if (
    typeof rev !== "string" ||
    rev.length === 0 ||
    rev.length > 256 ||
    rev.startsWith("-") ||
    rev.includes(":") ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
    /[\s\u0000-\u001f\u007f]/.test(rev)
  ) {
    throw gitPrecondition("invalid-argument", `Not a valid revision: "${rev}".`);
  }
  return rev;
}

function validateIndex(index: number): number {
  if (!Number.isInteger(index) || index < 0) {
    throw gitPrecondition("invalid-argument", `Not a valid stash index: ${index}.`);
  }
  return index;
}

function clampInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min) {
    throw gitPrecondition("invalid-argument", `${name} must be an integer >= ${min}.`);
  }
  return Math.min(value, max);
}

function emptyDiff(mode: GitDiffMode, overrides: Partial<GitDiff> = {}): GitDiff {
  return { patch: "", mode, isBinary: false, isTooLarge: false, isEmpty: true, ...overrides };
}

function toDiff(mode: GitDiffMode, result: GitExecResult, patchText = result.stdout): GitDiff {
  if (result.truncated) return emptyDiff(mode, { isTooLarge: true, isEmpty: false });
  if (BINARY_PATCH.test(patchText)) return emptyDiff(mode, { isBinary: true, isEmpty: false });
  const isEmpty = patchText.trim().length === 0;
  return { patch: isEmpty ? "" : patchText, mode, isBinary: false, isTooLarge: false, isEmpty };
}

/** Factory for `GitService`: re-runs discovery on each open attempt (e.g. after `git init`). */
export function createGitAdapterFactory(
  cwd: string,
  options: GitCliAdapterOptions = {},
): () => Promise<GitAdapter> {
  return () => openGitRepository(cwd, options);
}

/** Opens the repository containing `cwd`, or throws a typed error explaining why it cannot. */
export async function openGitRepository(
  cwd: string,
  options: GitCliAdapterOptions = {},
): Promise<GitCliAdapter> {
  const discovery = await discoverRepository(cwd, options);
  switch (discovery.kind) {
    case "repository":
      return new GitCliAdapter(discovery.repository, options);
    case "not-a-repository":
      throw gitPrecondition("not-a-repository", "This folder is not inside a Git repository.");
    case "bare-repository":
      throw gitPrecondition("bare-repository", "This is a bare repository; it has no working tree to show.");
    case "unsafe-repository":
      throw gitPrecondition(
        "unsafe-repository",
        `Git refuses this repository because it is owned by another user (${discovery.message}). Add it to safe.directory only if you trust it.`,
      );
    case "git-missing":
      throw gitPrecondition("git-missing", "Git is not installed or not on PATH.");
    case "git-too-old":
      throw gitPrecondition(
        "git-too-old",
        `Git ${discovery.gitVersion} is too old; Lucy needs ${discovery.minimumVersion} or newer.`,
      );
  }
}

export class GitCliAdapter implements GitAdapter {
  readonly repository: GitRepositoryInfo;
  private readonly runner: GitRunner;
  /** Index/worktree/ref mutations, in order. */
  private readonly writes = new SerialQueue();
  /** fetch/push do not touch the index; keep them from blocking staging for up to a minute. */
  private readonly network = new SerialQueue();
  private readonly statusRuns: Coalescer<GitStatus>;
  private readonly timeouts: GitTimeouts;
  private readonly limits: GitLimits;

  constructor(repository: GitRepositoryInfo, options: GitCliAdapterOptions = {}) {
    this.repository = repository;
    this.timeouts = { ...DEFAULT_GIT_TIMEOUTS, ...options.timeouts };
    this.limits = { ...DEFAULT_GIT_LIMITS, ...options.limits };
    this.runner = new GitRunner({
      cwd: repository.root,
      env: options.env,
      gitPath: options.gitPath,
      defaultTimeoutMs: this.timeouts.read,
    });
    this.statusRuns = new Coalescer(() => this.computeStatus());
  }

  dispose(): void {
    this.runner.dispose();
  }

  // ---------------------------------------------------------------- plumbing

  /** The one entry point for Git commands that must succeed (see `runner.ts`). */
  private git(args: readonly string[], options: GitExecOptions = {}): Promise<GitExecResult> {
    return this.runner.git(args, options);
  }

  /** Like `git()` but returns non-zero exits for the caller to interpret. */
  private exec(args: readonly string[], options: GitExecOptions = {}): Promise<GitExecResult> {
    return this.runner.exec(args, options);
  }

  private write(args: readonly string[], options: GitExecOptions = {}): Promise<GitExecResult> {
    return this.git(args, { kind: "write", timeoutMs: this.timeouts.write, ...options });
  }

  /** Serializes an index mutation; idempotent ones retry briefly on `index.lock` contention. */
  private mutate<T>(task: () => Promise<T>, retryOnLock = false): Promise<T> {
    return this.writes.run(() =>
      retryOnLock ? withRetry(task, (error) => gitFailureKind(error) === "index-locked") : task(),
    );
  }

  private path(path: string): string {
    return normalizeRepoPath(path, this.repository.precomposeUnicode);
  }

  private paths(paths: readonly string[]): string[] {
    return normalizeRepoPaths(paths, this.repository.precomposeUnicode);
  }

  private call(options: GitCallOptions | undefined, fallbackTimeout: number): GitExecOptions {
    return { signal: options?.signal, timeoutMs: options?.timeoutMs ?? fallbackTimeout };
  }

  // ---------------------------------------------------------------- status

  status(): Promise<GitStatus> {
    return this.statusRuns.run();
  }

  private async computeStatus(): Promise<GitStatus> {
    const operation = detectOperation(this.repository.gitDir);
    const base = ["status", "--porcelain=v2", "-z", "--branch", "--show-stash", "--find-renames"];
    const options: GitExecOptions = {
      timeoutMs: this.timeouts.status,
      maxOutputBytes: this.limits.statusOutputBytes,
    };
    let result: GitExecResult;
    let untrackedTimedOut = false;
    try {
      // Individual untracked files, VS Code style.
      result = await this.git([...base, "--untracked-files=all"], options);
    } catch (error) {
      if (gitFailureKind(error) !== "timeout") throw error;
      // A huge untracked tree (an unignored node_modules) must not freeze the panel: fall back to
      // collapsed untracked directories and tell the UI the list is incomplete.
      untrackedTimedOut = true;
      result = await this.git([...base, "--untracked-files=normal"], options);
    }
    const parsed = parsePorcelainV2(result.stdout, {
      maxEntries: this.limits.statusEntries,
      outputTruncated: result.truncated,
    });
    return createGitStatus({
      branch: parsed.branch,
      changes: parsed.changes,
      operation: await operation,
      stashCount: parsed.stashCount,
      truncated: parsed.truncated || untrackedTimedOut,
      truncatedReason: untrackedTimedOut ? "untracked-timeout" : parsed.truncatedReason,
    });
  }

  /** Status entries for specific paths (exact matches), for discard planning. */
  private async statusForPaths(paths: readonly string[]): Promise<GitChange[]> {
    const changes: GitChange[] = [];
    for (const chunk of chunkPaths(paths)) {
      const result = await this.git(
        [
          "status",
          "--porcelain=v2",
          "-z",
          "--untracked-files=all",
          "--no-renames",
          "--",
          ...literalPathspecs(chunk),
        ],
        { timeoutMs: this.timeouts.status },
      );
      changes.push(...parsePorcelainV2(result.stdout).changes);
    }
    return changes;
  }

  // ---------------------------------------------------------------- diff and content

  async diff(target: GitDiffTarget, options: GitDiffOptions = {}): Promise<GitDiff> {
    const path = this.path(target.path);
    const origPath = target.origPath ? this.path(target.origPath) : undefined;
    const context = clampInteger(options.context ?? 3, 0, 100_000, "context");
    const maxBytes = options.maxBytes ?? this.limits.diffBytes;
    const call = this.call(options, this.timeouts.read);

    const entry = await this.indexEntry(path, call);
    if (entry.conflicted) return this.conflictDiff(path, context, maxBytes, call);

    if (target.staged) {
      // Both paths, so a staged rename renders as a rename instead of an addition.
      const paths = origPath && origPath !== path ? [origPath, path] : [path];
      const result = await this.git(
        ["diff", ...DIFF_FLAGS, `-U${context}`, "--cached", "-M", "--", ...literalPathspecs(paths)],
        {
          ...call,
          config: DIFF_CONFIG,
          maxOutputBytes: maxBytes,
        },
      );
      return toDiff("staged", result);
    }
    if (!entry.tracked) return this.untrackedDiff(path, context, maxBytes, call, "untracked");
    const result = await this.git(["diff", ...DIFF_FLAGS, `-U${context}`, "--", literalPathspec(path)], {
      ...call,
      config: DIFF_CONFIG,
      maxOutputBytes: maxBytes,
    });
    return toDiff("unstaged", result);
  }

  private async indexEntry(
    path: string,
    call: GitExecOptions,
  ): Promise<{ tracked: boolean; conflicted: boolean }> {
    const result = await this.git(["ls-files", "--stage", "-z", "--", literalPathspec(path)], call);
    let tracked = false;
    let conflicted = false;
    for (const record of result.stdout.split("\0")) {
      const tab = record.indexOf("\t");
      if (tab === -1 || record.slice(tab + 1) !== path) continue;
      tracked = true;
      const stage = record.slice(0, tab).split(" ")[2];
      if (stage && stage !== "0") conflicted = true;
    }
    return { tracked, conflicted };
  }

  /**
   * Untracked files have no blob to diff against, so Git compares `/dev/null` with the file
   * (`--no-index`, which exits 1 when they differ: that is success here).
   */
  private async untrackedDiff(
    path: string,
    context: number,
    maxBytes: number,
    call: GitExecOptions,
    mode: GitDiffMode,
  ): Promise<GitDiff> {
    const info = await statWorktreePath(this.repository.root, path);
    if (info.kind === "missing" || info.kind === "directory" || info.kind === "other") return emptyDiff(mode);
    if (info.size > maxBytes) return emptyDiff(mode, { isTooLarge: true, isEmpty: false });
    const target = path.endsWith("/") ? path.slice(0, -1) : path;
    const result = await this.git(
      ["diff", "--no-index", ...DIFF_FLAGS, `-U${context}`, "--", "/dev/null", target],
      {
        ...call,
        config: DIFF_CONFIG,
        okExitCodes: [0, 1],
        // Every line gains a "+" and the header adds a little; anything beyond is pathological.
        maxOutputBytes: maxBytes * 2 + 4096,
      },
    );
    return toDiff(mode, result);
  }

  /**
   * Conflicted files are shown as the working tree (with conflict markers) against "ours"
   * (stage 2): a plain unified diff the renderer already understands, unlike Git's combined
   * `diff --cc` format. When there is no "ours" version (deleted by us, added by them) the
   * working-tree file is shown as all-added.
   */
  private async conflictDiff(
    path: string,
    context: number,
    maxBytes: number,
    call: GitExecOptions,
  ): Promise<GitDiff> {
    const result = await this.git(
      ["diff", ...DIFF_FLAGS, `-U${context}`, "--ours", "--", literalPathspec(path)],
      {
        ...call,
        config: DIFF_CONFIG,
        maxOutputBytes: maxBytes,
      },
    );
    const patch = result.stdout.replace(UNMERGED_NOTICE, "");
    const diff = toDiff("conflict", result, patch);
    if (!diff.isEmpty) return diff;
    const ours = await this.exec(["cat-file", "-e", `:2:${path}`], call);
    if (ours.code === 0) return diff;
    return this.untrackedDiff(path, context, maxBytes, call, "conflict");
  }

  async fileAtRevision(
    path: string,
    revision: GitRevision,
    options: GitReadOptions = {},
  ): Promise<GitFileContent> {
    const repoPath = this.path(path);
    const maxBytes = options.maxBytes ?? this.limits.fileBytes;
    if (revision === "WORKTREE") return readWorktreeFile(this.repository.root, repoPath, maxBytes);

    const stage = STAGE_SPECS[revision];
    // Always spell the stage out: `:<path>` would misread a file named like `1:foo` as stage 1.
    const spec = stage !== undefined ? `:${stage}:${repoPath}` : `${validateRevision(revision)}:${repoPath}`;
    // `cat-file blob` is plumbing: no textconv, no filters, no external programs.
    const result = await this.exec(["cat-file", "blob", spec], {
      ...this.call(options, this.timeouts.read),
      maxOutputBytes: maxBytes,
    });
    if (result.truncated)
      return { exists: true, content: null, isBinary: false, isTooLarge: true, size: null };
    if (result.code !== 0) {
      // Missing path, unborn HEAD, unknown revision or not a blob (a submodule): no content there.
      if (result.code === 128)
        return { exists: false, content: null, isBinary: false, isTooLarge: false, size: null };
      throw gitFailure({ args: result.args, exitCode: result.code, stderr: result.stderr, stdout: "" });
    }
    const size = Buffer.byteLength(result.stdout);
    if (looksBinaryText(result.stdout))
      return { exists: true, content: null, isBinary: true, isTooLarge: false, size };
    return { exists: true, content: result.stdout, isBinary: false, isTooLarge: false, size };
  }

  // ---------------------------------------------------------------- staging

  async stage(paths: readonly string[]): Promise<void> {
    const list = this.paths(paths);
    if (list.length === 0) return;
    await this.mutate(
      () =>
        this.write(["add", "--pathspec-from-file=-", "--pathspec-file-nul"], { stdin: pathspecStdin(list) }),
      true,
    );
  }

  async unstage(paths: readonly string[]): Promise<void> {
    const list = this.paths(paths);
    if (list.length === 0) return;
    // `reset` (unlike `restore --staged`) also works on an unborn branch, against the empty tree.
    await this.mutate(() => this.resetPaths(list), true);
  }

  private resetPaths(paths: readonly string[]): Promise<GitExecResult> {
    return this.write(["reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"], {
      stdin: pathspecStdin(paths),
    });
  }

  async stageAll(options: GitStageAllOptions = {}): Promise<void> {
    await this.mutate(async () => {
      if (!options.includeConflicts) {
        // `add -A` marks conflicts as resolved; that must be a deliberate choice.
        const unmerged = await this.git(["ls-files", "--unmerged", "-z"]);
        if (unmerged.stdout.length > 0) {
          throw gitPrecondition(
            "conflicts",
            "Some files have merge conflicts. Resolve them first, or stage them explicitly to mark them resolved.",
          );
        }
      }
      await this.write(["add", "-A"]);
    }, true);
  }

  async unstageAll(): Promise<void> {
    await this.mutate(async () => {
      // A path-less `git reset` would also drop MERGE_HEAD and friends, silently aborting a
      // merge. Unstaging the staged paths (excluding conflicts) keeps the operation intact.
      const staged = await this.git([
        "diff",
        "--cached",
        "--name-only",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "-z",
        "--diff-filter=ACDMRTXB",
      ]);
      const paths = staged.stdout.split("\0").filter(Boolean);
      if (paths.length > 0) await this.resetPaths(paths);
    }, true);
  }

  // ---------------------------------------------------------------- discard

  async previewDiscard(paths: readonly string[]): Promise<GitDiscardPreviewEntry[]> {
    const list = this.paths(paths);
    if (list.length === 0) return [];
    const changes = await this.statusForPaths(list);
    const byPath = new Map(changes.map((change) => [change.path, change]));
    const entries: GitDiscardPreviewEntry[] = [];
    const restore: string[] = [];

    for (const path of list) {
      const change = byPath.get(path) ?? null;
      const entry: GitDiscardPreviewEntry = {
        path,
        action: "none",
        change,
        isBinary: false,
        linesLost: null,
        linesRestored: null,
        bytes: null,
      };
      entries.push(entry);
      if (!change) {
        // A directory is never discarded wholesale: the caller must name the files.
        if (changes.some((other) => other.path.startsWith(`${path}/`))) {
          entry.action = "blocked";
          entry.reason = "directory";
        }
        continue;
      }
      if (change.conflicted) {
        entry.action = "blocked";
        entry.reason = "conflicted";
      } else if (change.isSubmodule) {
        entry.action = "blocked";
        entry.reason = "submodule";
      } else if (change.worktree === "untracked") {
        const info = await describeUntrackedFile(this.repository.root, path, this.limits.diffBytes);
        if (info.kind === "directory" || path.endsWith("/")) {
          entry.action = "blocked";
          entry.reason = "directory";
          continue;
        }
        entry.action = "delete";
        entry.isBinary = info.isBinary;
        entry.bytes = info.size;
        entry.linesLost = info.lines;
        entry.linesRestored = 0;
      } else if (change.worktree !== undefined) {
        entry.action = "restore";
        restore.push(path);
      }
    }

    if (restore.length > 0) {
      const stats = new Map<string, { added: number | null; removed: number | null }>();
      for (const chunk of chunkPaths(restore)) {
        const result = await this.git(
          [
            "diff",
            "--numstat",
            "-z",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            "--",
            ...literalPathspecs(chunk),
          ],
          { timeoutMs: this.timeouts.read },
        );
        for (const stat of parseNumstat(result.stdout)) stats.set(stat.path, stat);
      }
      for (const entry of entries) {
        if (entry.action !== "restore") continue;
        const stat = stats.get(entry.path);
        if (!stat) continue;
        entry.isBinary = stat.added === null;
        entry.linesLost = stat.added;
        entry.linesRestored = stat.removed;
      }
    }
    return entries;
  }

  async discard(paths: readonly string[]): Promise<GitDiscardResult> {
    const list = this.paths(paths);
    if (list.length === 0) return { restored: [], deleted: [], unchanged: [] };
    return this.mutate(async () => {
      // Re-plan inside the queue: the confirmation the user saw may be stale.
      const plan = await this.previewDiscard(list);
      const blocked = plan.filter((entry) => entry.action === "blocked");
      if (blocked.length > 0) {
        throw gitPrecondition(
          "discard-blocked",
          `Cannot discard ${blocked.map((entry) => `${entry.path} (${entry.reason})`).join(", ")}.`,
          { paths: blocked.map((entry) => entry.path) },
        );
      }
      const restored = plan.filter((entry) => entry.action === "restore").map((entry) => entry.path);
      const deleted = plan.filter((entry) => entry.action === "delete").map((entry) => entry.path);
      const unchanged = plan.filter((entry) => entry.action === "none").map((entry) => entry.path);
      if (restored.length > 0) {
        await this.write(["restore", "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"], {
          stdin: pathspecStdin(restored),
        });
      }
      // Exactly the named untracked files: no `-d` (directories), no `-x` (ignored files).
      for (const chunk of chunkPaths(deleted)) {
        await this.write(["clean", "-f", "-q", "--", ...literalPathspecs(chunk)]);
      }
      return { restored, deleted, unchanged };
    }, true);
  }

  // ---------------------------------------------------------------- commit

  async commit(options: GitCommitOptions): Promise<GitCommitResult> {
    const message = options.message ?? "";
    const hasMessage = message.trim().length > 0;
    if (!hasMessage && !options.amend) {
      throw gitPrecondition("empty-message", "The commit message cannot be empty.");
    }
    if (message.includes("\0")) {
      throw gitPrecondition("invalid-argument", "The commit message cannot contain NUL bytes.");
    }
    // The message goes through stdin, never argv. Hooks and signing run as configured; there is
    // deliberately no way to pass --no-verify. `-uno` keeps the "nothing to commit" status fast.
    const args = ["commit", "--quiet", "--untracked-files=no"];
    if (options.amend) args.push("--amend");
    if (options.signoff) args.push("--signoff");
    if (hasMessage) args.push("--file=-");
    else args.push("--no-edit");

    return this.mutate(async () => {
      await this.write(args, { stdin: hasMessage ? message : undefined, timeoutMs: this.timeouts.commit });
      const [info, branch] = await Promise.all([
        this.git(["log", "-1", "--format=%H%x00%h%x00%s", "HEAD", "--"]),
        this.currentBranch(),
      ]);
      const [oid = "", shortOid = "", summary = ""] = value(info.stdout).split("\0");
      return { oid, shortOid, summary, branch };
    });
  }

  async lastCommitMessage(): Promise<string | null> {
    const result = await this.exec(["log", "-1", "--format=%B", "HEAD", "--"]);
    if (result.code !== 0) {
      if (UNBORN_LOG.test(result.stderr)) return null;
      throw gitFailure({ args: result.args, exitCode: result.code, stderr: result.stderr, stdout: "" });
    }
    return result.stdout.replace(/\n+$/, "");
  }

  // ---------------------------------------------------------------- branches

  private async currentBranch(): Promise<string | null> {
    const result = await this.exec(["symbolic-ref", "-q", "HEAD"]);
    if (result.code !== 0) return null;
    const ref = value(result.stdout);
    return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
  }

  private async remoteNames(): Promise<string[]> {
    const result = await this.git(["remote"]);
    return result.stdout.split("\n").filter(Boolean);
  }

  /**
   * Local checks first (cheap, and `check-ref-format --branch` would expand `@{-1}`), then Git's
   * own rules. The output must equal the input so no expansion slipped through.
   */
  private async validateBranchName(name: string): Promise<string> {
    const invalid = () => gitPrecondition("invalid-ref-name", `"${name}" is not a valid branch name.`);
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > 255 ||
      name.startsWith("-") ||
      name.includes("@{") ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
      /[\s\u0000-\u001f\u007f]/.test(name)
    ) {
      throw invalid();
    }
    const result = await this.exec(["check-ref-format", "--branch", name]);
    if (result.code !== 0 || value(result.stdout) !== name) throw invalid();
    return name;
  }

  async branches(): Promise<GitBranchList> {
    const [refs, current, head, remotes] = await Promise.all([
      this.git(["for-each-ref", `--format=${REF_FORMAT}`, "refs/heads", "refs/remotes"]),
      this.currentBranch(),
      this.exec(["rev-parse", "-q", "--verify", "HEAD^{commit}"]),
      this.remoteNames(),
    ]);
    const all = parseRefs(refs.stdout, remotes);
    const local = all.filter((branch) => branch.kind === "local");
    if (current && !local.some((branch) => branch.name === current)) {
      // Unborn branch: HEAD names it but the ref does not exist yet.
      local.unshift({
        name: current,
        ref: `refs/heads/${current}`,
        kind: "local",
        oid: null,
        isCurrent: true,
      });
    }
    return {
      current,
      detached: current === null,
      headOid: head.code === 0 ? value(head.stdout) : null,
      local,
      remote: all.filter((branch) => branch.kind === "remote"),
    };
  }

  async switchBranch(name: string): Promise<void> {
    const branch = await this.validateBranchName(name);
    // Plain `switch` refuses to overwrite local changes; we never pass --force/--discard-changes.
    // `--no-guess`: a remote-only name must go through createBranch, not an implicit DWIM.
    await this.mutate(() => this.write(["switch", "--no-guess", "--end-of-options", branch]));
  }

  async createBranch(name: string, options: GitCreateBranchOptions = {}): Promise<void> {
    const branch = await this.validateBranchName(name);
    let start: string | undefined;
    if (options.from !== undefined) {
      start = validateRevision(options.from);
      const check = await this.exec(["rev-parse", "-q", "--verify", "--end-of-options", `${start}^{commit}`]);
      if (check.code !== 0) throw gitPrecondition("invalid-argument", `Unknown start point "${start}".`);
    }
    const args = options.switch
      ? ["switch", "-c", branch, "--end-of-options", ...(start ? [start] : [])]
      : ["branch", "--end-of-options", branch, ...(start ? [start] : [])];
    await this.mutate(() => this.write(args));
  }

  // ---------------------------------------------------------------- history

  async log(options: GitLogOptions = {}): Promise<GitCommit[]> {
    const limit = clampInteger(options.limit ?? 100, 1, 10_000, "limit");
    const skip = clampInteger(options.skip ?? 0, 0, Number.MAX_SAFE_INTEGER, "skip");
    const ref = options.ref === undefined ? "HEAD" : validateRevision(options.ref);
    const args = ["log", "-z", "--decorate=full", `--format=${LOG_FORMAT}`, `--max-count=${limit}`];
    if (skip > 0) args.push(`--skip=${skip}`);
    args.push("--end-of-options", ref, "--");
    if (options.path !== undefined) args.push(literalPathspec(this.path(options.path)));
    const result = await this.exec(args, this.call(options, this.timeouts.read));
    if (result.code !== 0) {
      if (options.ref === undefined && UNBORN_LOG.test(result.stderr)) return [];
      throw gitFailure({ args: result.args, exitCode: result.code, stderr: result.stderr, stdout: "" });
    }
    return parseLog(result.stdout);
  }

  // ---------------------------------------------------------------- stash

  async stashList(): Promise<GitStash[]> {
    const result = await this.git(["stash", "list", "-z", `--format=${STASH_FORMAT}`]);
    return parseStashList(result.stdout);
  }

  async stashPush(options: GitStashPushOptions = {}): Promise<GitStashPushResult> {
    const args = ["stash", "push"];
    if (options.includeUntracked) args.push("--include-untracked");
    if (options.message?.trim()) {
      // Stash messages are reflog subjects: one line. A single `--message=` argument cannot be
      // mistaken for an option whatever the text starts with.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: flattening control characters is the point.
      args.push(`--message=${options.message.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim()}`);
    }
    const result = await this.mutate(() => this.write(args));
    return { created: !/No local changes to save/i.test(`${result.stdout}\n${result.stderr}`) };
  }

  async stashApply(index: number, options: GitStashApplyOptions = {}): Promise<void> {
    await this.stashApplyOrPop("apply", index, options);
  }

  async stashPop(index: number, options: GitStashApplyOptions = {}): Promise<void> {
    await this.stashApplyOrPop("pop", index, options);
  }

  private async stashApplyOrPop(
    command: "apply" | "pop",
    index: number,
    options: GitStashApplyOptions,
  ): Promise<void> {
    const ref = `stash@{${validateIndex(index)}}`;
    const args = ["stash", command, ...(options.restoreIndex ? ["--index"] : []), ref];
    await this.mutate(() => this.write(args));
  }

  async stashDrop(index: number): Promise<void> {
    const ref = `stash@{${validateIndex(index)}}`;
    await this.mutate(() => this.write(["stash", "drop", "-q", ref]));
  }

  // ---------------------------------------------------------------- remotes

  async remotes(): Promise<GitRemote[]> {
    const result = await this.git(["remote", "-v"]);
    return parseRemotes(result.stdout);
  }

  private async validateRemote(name: string): Promise<string> {
    const names = await this.remoteNames();
    if (typeof name !== "string" || name.startsWith("-") || !names.includes(name)) {
      throw gitPrecondition("invalid-argument", `Unknown remote "${name}".`);
    }
    return name;
  }

  private networkCall(options: GitCallOptions | undefined): GitExecOptions {
    return { kind: "network", ...this.call(options, this.timeouts.network) };
  }

  async fetch(options: GitFetchOptions = {}): Promise<void> {
    const args = ["fetch"];
    if (options.prune) args.push("--prune");
    if (options.all) args.push("--all");
    else if (options.remote !== undefined) args.push(await this.validateRemote(options.remote));
    await this.network.run(() => this.git(args, this.networkCall(options)));
  }

  async pull(options: GitPullOptions = {}): Promise<void> {
    const ffOnly = options.ffOnly ?? true;
    // `--no-edit`: a merge commit must never wait for an editor.
    const args = ["pull", ffOnly ? "--ff-only" : "--no-edit"];
    await this.mutate(() => this.git(args, this.networkCall(options)));
  }

  async push(options: GitPushOptions = {}): Promise<GitPushResult> {
    const branch = await this.currentBranch();
    if (!options.setUpstream) {
      const args = ["push"];
      const remote = options.remote === undefined ? null : await this.validateRemote(options.remote);
      if (remote) args.push(remote);
      await this.network.run(() => this.git(args, this.networkCall(options)));
      return { remote, branch, upstreamSet: false };
    }
    if (!branch) {
      throw gitPrecondition("invalid-argument", "Cannot publish a detached HEAD; create a branch first.");
    }
    const remote = await this.defaultRemote(options.remote);
    // Explicit refspec under refs/: unambiguous and never an option, never forced.
    const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
    await this.network.run(() =>
      this.git(["push", "--set-upstream", remote, refspec], this.networkCall(options)),
    );
    return { remote, branch, upstreamSet: true };
  }

  private async defaultRemote(requested: string | undefined): Promise<string> {
    if (requested !== undefined) return this.validateRemote(requested);
    const names = await this.remoteNames();
    if (names.length === 1 && names[0]) return names[0];
    if (names.includes("origin")) return "origin";
    throw gitPrecondition(
      "invalid-argument",
      names.length === 0 ? "This repository has no remotes." : "Choose which remote to publish to.",
    );
  }
}
