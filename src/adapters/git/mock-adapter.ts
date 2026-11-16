/**
 * In-memory, scriptable `GitAdapter` for UI and service tests.
 *
 * It keeps a list of changes and updates it the way Git would on stage/unstage/commit/discard, so
 * tests can assert that the UI refreshes and regroups correctly. Every call is recorded, any
 * method can be told to fail, and an optional latency makes concurrency observable.
 */
import type { LucyError } from "@/core/errors";
import { gitFailure, gitPrecondition } from "./errors";
import { createGitStatus } from "./porcelain";
import type {
  GitAdapter,
  GitAdapterMethod,
  GitBranch,
  GitBranchList,
  GitBranchStatus,
  GitChange,
  GitCommit,
  GitCommitOptions,
  GitCommitResult,
  GitCreateBranchOptions,
  GitDiff,
  GitDiffOptions,
  GitDiffTarget,
  GitDiscardPreviewEntry,
  GitDiscardResult,
  GitFetchOptions,
  GitFileContent,
  GitLogOptions,
  GitOperation,
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

export interface MockGitCall {
  method: GitAdapterMethod;
  args: unknown[];
}

export interface MockGitAdapterOptions {
  repository?: Partial<GitRepositoryInfo>;
  changes?: GitChange[];
  branch?: Partial<GitBranchStatus>;
  operation?: GitOperation | null;
  /** Artificial delay for every call, in milliseconds. */
  latencyMs?: number;
}

interface Failure {
  error: Error;
  remaining: number;
}

const EMPTY_DIFF: GitDiff = {
  patch: "",
  mode: "unstaged",
  isBinary: false,
  isTooLarge: false,
  isEmpty: true,
};

function clone(change: GitChange): GitChange {
  return { ...change, submodule: change.submodule ? { ...change.submodule } : undefined };
}

function diffKey(path: string, staged: boolean): string {
  return `${staged ? "staged" : "unstaged"}:${path}`;
}

/** Deterministic fake object ids: 40 hex chars derived from a counter. */
function fakeOid(counter: number): string {
  return counter.toString(16).padStart(8, "0").repeat(5);
}

export class MockGitAdapter implements GitAdapter {
  readonly repository: GitRepositoryInfo;
  readonly calls: MockGitCall[] = [];
  latencyMs: number;
  disposed = false;

  private changes: GitChange[];
  private branchState: GitBranchStatus;
  private operation: GitOperation | null;
  private readonly diffs = new Map<string, GitDiff>();
  private readonly files = new Map<string, GitFileContent>();
  private readonly failures = new Map<GitAdapterMethod, Failure>();
  private localBranches: GitBranch[] = [];
  private remoteBranches: GitBranch[] = [];
  private history: GitCommit[] = [];
  private stashes: { entry: GitStash; changes: GitChange[] }[] = [];
  private remoteList: GitRemote[] = [];
  private oidCounter = 1;

  constructor(options: MockGitAdapterOptions = {}) {
    this.repository = {
      root: "/mock/repo",
      gitDir: "/mock/repo/.git",
      commonDir: "/mock/repo/.git",
      isLinkedWorktree: false,
      workspaceRoot: "/mock/repo",
      workspacePrefix: "",
      gitVersion: "2.50.0",
      precomposeUnicode: false,
      ...options.repository,
    };
    this.changes = (options.changes ?? []).map(clone);
    this.branchState = {
      name: "main",
      oid: fakeOid(0),
      detached: false,
      unborn: false,
      ...options.branch,
    };
    this.operation = options.operation ?? null;
    this.latencyMs = options.latencyMs ?? 0;
    if (this.branchState.name) {
      this.localBranches = [
        {
          name: this.branchState.name,
          ref: `refs/heads/${this.branchState.name}`,
          kind: "local",
          oid: this.branchState.oid,
          isCurrent: true,
        },
      ];
    }
  }

  // ---------------------------------------------------------------- scripting

  setChanges(changes: GitChange[]): void {
    this.changes = changes.map(clone);
  }

  setBranch(branch: Partial<GitBranchStatus>): void {
    this.branchState = { ...this.branchState, ...branch };
  }

  setOperation(operation: GitOperation | null): void {
    this.operation = operation;
  }

  setDiff(target: GitDiffTarget, diff: Partial<GitDiff> & { patch: string }): void {
    const full: GitDiff = {
      ...EMPTY_DIFF,
      mode: target.staged ? "staged" : "unstaged",
      isEmpty: diff.patch.length === 0,
      ...diff,
    };
    this.diffs.set(diffKey(target.path, target.staged ?? false), full);
  }

  setFile(
    path: string,
    revision: GitRevision,
    content: string | null,
    extra: Partial<GitFileContent> = {},
  ): void {
    this.files.set(`${revision}:${path}`, {
      exists: content !== null,
      content,
      isBinary: false,
      isTooLarge: false,
      size: content === null ? null : Buffer.byteLength(content),
      ...extra,
    });
  }

  setBranches(local: GitBranch[], remote: GitBranch[] = []): void {
    this.localBranches = local.map((branch) => ({ ...branch }));
    this.remoteBranches = remote.map((branch) => ({ ...branch }));
  }

  setLog(commits: GitCommit[]): void {
    this.history = commits.map((commit) => ({ ...commit }));
  }

  setRemotes(remotes: GitRemote[]): void {
    this.remoteList = remotes.map((remote) => ({ ...remote }));
  }

  /** Makes the next `times` calls of `method` reject with `error` (default: a generic GIT_FAILED). */
  failNext(method: GitAdapterMethod, error?: Error, times = 1): void {
    this.failures.set(method, {
      error:
        error ??
        gitFailure({
          args: [method],
          exitCode: 1,
          stderr: `mock failure: ${method}`,
          stdout: "",
          kind: "failed",
        }),
      remaining: times,
    });
  }

  /** Makes every call of `method` reject until `clearFailures()`. */
  failAlways(method: GitAdapterMethod, error?: Error): void {
    this.failNext(method, error, Number.POSITIVE_INFINITY);
  }

  clearFailures(): void {
    this.failures.clear();
  }

  callCount(method: GitAdapterMethod): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  /** Current changes (copies). */
  getChanges(): GitChange[] {
    return this.changes.map(clone);
  }

  // ---------------------------------------------------------------- plumbing

  private async enter(method: GitAdapterMethod, args: unknown[]): Promise<void> {
    this.calls.push({ method, args });
    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    if (this.disposed) throw gitPrecondition("cancelled", "The mock adapter was disposed.");
    const failure = this.failures.get(method);
    if (failure && failure.remaining > 0) {
      failure.remaining--;
      if (failure.remaining <= 0) this.failures.delete(method);
      throw failure.error;
    }
  }

  private find(path: string): GitChange | undefined {
    return this.changes.find((change) => change.path === path);
  }

  private prune(): void {
    this.changes = this.changes.filter(
      (change) => change.index !== undefined || change.worktree !== undefined,
    );
  }

  private stageChange(change: GitChange): void {
    if (change.conflicted) {
      change.conflicted = false;
      change.conflictKind = undefined;
      change.index = "modified";
      change.worktree = undefined;
      return;
    }
    if (change.worktree === "untracked") change.index = "added";
    else if (change.worktree !== undefined && change.index === undefined) change.index = change.worktree;
    change.worktree = undefined;
  }

  private unstageChange(change: GitChange): void {
    if (change.index === undefined || change.conflicted) return;
    if (change.index === "added" || change.index === "renamed" || change.index === "copied") {
      change.worktree = change.worktree === "deleted" ? undefined : "untracked";
      if (change.index === "renamed" && change.origPath) {
        this.changes.push({ path: change.origPath, worktree: "deleted", conflicted: false });
      }
      change.origPath = undefined;
    } else {
      change.worktree ??= change.index;
    }
    change.index = undefined;
  }

  // ---------------------------------------------------------------- GitAdapter

  async status(): Promise<GitStatus> {
    await this.enter("status", []);
    return createGitStatus({
      branch: { ...this.branchState },
      changes: this.changes.map(clone),
      operation: this.operation,
      stashCount: this.stashes.length,
    });
  }

  async diff(target: GitDiffTarget, options?: GitDiffOptions): Promise<GitDiff> {
    await this.enter("diff", [target, options]);
    return { ...(this.diffs.get(diffKey(target.path, target.staged ?? false)) ?? EMPTY_DIFF) };
  }

  async fileAtRevision(
    path: string,
    revision: GitRevision,
    options?: GitReadOptions,
  ): Promise<GitFileContent> {
    await this.enter("fileAtRevision", [path, revision, options]);
    return (
      this.files.get(`${revision}:${path}`) ?? {
        exists: false,
        content: null,
        isBinary: false,
        isTooLarge: false,
        size: null,
      }
    );
  }

  async stage(paths: readonly string[]): Promise<void> {
    await this.enter("stage", [[...paths]]);
    for (const path of paths) {
      const change = this.find(path);
      if (change) this.stageChange(change);
    }
  }

  async unstage(paths: readonly string[]): Promise<void> {
    await this.enter("unstage", [[...paths]]);
    for (const path of paths) {
      const change = this.find(path);
      if (change) this.unstageChange(change);
    }
    this.prune();
  }

  async stageAll(options?: GitStageAllOptions): Promise<void> {
    await this.enter("stageAll", [options]);
    if (!options?.includeConflicts && this.changes.some((change) => change.conflicted)) {
      throw gitPrecondition("conflicts", "Some files have merge conflicts.");
    }
    for (const change of this.changes) this.stageChange(change);
  }

  async unstageAll(): Promise<void> {
    await this.enter("unstageAll", []);
    for (const change of [...this.changes]) this.unstageChange(change);
    this.prune();
  }

  async previewDiscard(paths: readonly string[]): Promise<GitDiscardPreviewEntry[]> {
    await this.enter("previewDiscard", [[...paths]]);
    return paths.map((path) => {
      const change = this.find(path) ?? null;
      const entry: GitDiscardPreviewEntry = {
        path,
        action: "none",
        change: change ? clone(change) : null,
        isBinary: false,
        linesLost: null,
        linesRestored: null,
        bytes: null,
      };
      if (!change) return entry;
      if (change.conflicted) return { ...entry, action: "blocked", reason: "conflicted" };
      if (change.isSubmodule) return { ...entry, action: "blocked", reason: "submodule" };
      if (change.worktree === "untracked") return { ...entry, action: "delete" };
      if (change.worktree !== undefined) return { ...entry, action: "restore" };
      return entry;
    });
  }

  async discard(paths: readonly string[]): Promise<GitDiscardResult> {
    await this.enter("discard", [[...paths]]);
    const result: GitDiscardResult = { restored: [], deleted: [], unchanged: [] };
    const blocked = paths.filter((path) => {
      const change = this.find(path);
      return change?.conflicted || change?.isSubmodule;
    });
    if (blocked.length > 0) {
      throw gitPrecondition("discard-blocked", `Cannot discard ${blocked.join(", ")}.`, { paths: blocked });
    }
    for (const path of paths) {
      const change = this.find(path);
      if (!change || change.worktree === undefined) {
        result.unchanged.push(path);
      } else if (change.worktree === "untracked") {
        change.worktree = undefined;
        result.deleted.push(path);
      } else {
        change.worktree = undefined;
        result.restored.push(path);
      }
    }
    this.prune();
    return result;
  }

  async commit(options: GitCommitOptions): Promise<GitCommitResult> {
    await this.enter("commit", [{ ...options }]);
    const message = options.message ?? "";
    if (!message.trim() && !options.amend) {
      throw gitPrecondition("empty-message", "The commit message cannot be empty.");
    }
    if (this.changes.some((change) => change.conflicted)) {
      throw gitFailure({
        args: ["commit"],
        exitCode: 128,
        stderr: "unmerged files",
        stdout: "",
        kind: "conflicts",
      });
    }
    const staged = this.changes.filter((change) => change.index !== undefined);
    if (staged.length === 0 && !options.amend) {
      throw gitFailure({ args: ["commit"], exitCode: 1, stderr: "", stdout: "nothing to commit" });
    }
    const effective = message.trim() ? message : this.history[0] ? `${this.history[0].subject}` : "";
    const [subject = "", ...rest] = effective.split("\n");
    const oid = fakeOid(++this.oidCounter);
    const commit: GitCommit = {
      oid,
      shortOid: oid.slice(0, 7),
      parents: this.branchState.oid && !options.amend ? [this.branchState.oid] : [],
      subject,
      body: rest.join("\n").replace(/^\n+/, "").replace(/\n+$/, ""),
      authorName: "Mock Author",
      authorEmail: "mock@example.invalid",
      authorDate: "2026-01-01T00:00:00Z",
      refs: [],
    };
    if (options.amend) this.history.shift();
    else this.branchState.ahead = (this.branchState.ahead ?? 0) + (this.branchState.upstream ? 1 : 0);
    this.history.unshift(commit);
    for (const change of staged) {
      change.index = undefined;
      change.origPath = undefined;
    }
    this.prune();
    this.branchState.oid = oid;
    this.branchState.unborn = false;
    return { oid, shortOid: commit.shortOid, summary: subject, branch: this.branchState.name };
  }

  async lastCommitMessage(): Promise<string | null> {
    await this.enter("lastCommitMessage", []);
    const last = this.history[0];
    if (!last) return null;
    return last.body ? `${last.subject}\n\n${last.body}` : last.subject;
  }

  async branches(): Promise<GitBranchList> {
    await this.enter("branches", []);
    return {
      current: this.branchState.name,
      detached: this.branchState.detached,
      headOid: this.branchState.oid,
      local: this.localBranches.map((branch) => ({
        ...branch,
        isCurrent: branch.name === this.branchState.name,
      })),
      remote: this.remoteBranches.map((branch) => ({ ...branch })),
    };
  }

  async switchBranch(name: string): Promise<void> {
    await this.enter("switchBranch", [name]);
    const branch = this.localBranches.find((candidate) => candidate.name === name);
    if (!branch) {
      throw gitFailure({
        args: ["switch", name],
        exitCode: 128,
        stderr: `fatal: invalid reference: ${name}`,
        stdout: "",
      });
    }
    this.branchState = { name, oid: branch.oid, detached: false, unborn: branch.oid === null };
  }

  async createBranch(name: string, options?: GitCreateBranchOptions): Promise<void> {
    await this.enter("createBranch", [name, options]);
    if (!name || /[\s~^:?*[\\]|\.\.|^-|@\{/.test(name)) {
      throw gitPrecondition("invalid-ref-name", `"${name}" is not a valid branch name.`);
    }
    if (this.localBranches.some((branch) => branch.name === name)) {
      throw gitFailure({
        args: ["branch", name],
        exitCode: 128,
        stderr: `fatal: a branch named '${name}' already exists`,
        stdout: "",
      });
    }
    this.localBranches.push({
      name,
      ref: `refs/heads/${name}`,
      kind: "local",
      oid: this.branchState.oid,
      isCurrent: false,
    });
    if (options?.switch)
      this.branchState = {
        name,
        oid: this.branchState.oid,
        detached: false,
        unborn: this.branchState.unborn,
      };
  }

  async log(options?: GitLogOptions): Promise<GitCommit[]> {
    await this.enter("log", [options]);
    const skip = options?.skip ?? 0;
    return this.history.slice(skip, skip + (options?.limit ?? 100)).map((commit) => ({ ...commit }));
  }

  async stashList(): Promise<GitStash[]> {
    await this.enter("stashList", []);
    return this.stashes.map(({ entry }, index) => ({ ...entry, index, ref: `stash@{${index}}` }));
  }

  async stashPush(options?: GitStashPushOptions): Promise<GitStashPushResult> {
    await this.enter("stashPush", [options]);
    const stashed = this.changes.filter(
      (change) => options?.includeUntracked || change.worktree !== "untracked",
    );
    if (stashed.length === 0) return { created: false };
    this.changes = this.changes.filter((change) => !stashed.includes(change));
    const oid = fakeOid(++this.oidCounter);
    const message = options?.message
      ? `On ${this.branchState.name ?? "(no branch)"}: ${options.message}`
      : `WIP on ${this.branchState.name ?? "(no branch)"}`;
    this.stashes.unshift({
      entry: {
        index: 0,
        ref: "stash@{0}",
        oid,
        message,
        branch: this.branchState.name,
        date: "2026-01-01T00:00:00Z",
      },
      changes: stashed,
    });
    return { created: true };
  }

  private takeStash(index: number, drop: boolean): GitChange[] {
    const stash = this.stashes[index];
    if (!stash) {
      throw gitFailure({
        args: ["stash"],
        exitCode: 1,
        stderr: `error: stash@{${index}} is not a valid reference`,
        stdout: "",
      });
    }
    if (drop) this.stashes.splice(index, 1);
    return stash.changes.map(clone);
  }

  async stashApply(index: number, options?: GitStashApplyOptions): Promise<void> {
    await this.enter("stashApply", [index, options]);
    this.changes.push(...this.takeStash(index, false));
  }

  async stashPop(index: number, options?: GitStashApplyOptions): Promise<void> {
    await this.enter("stashPop", [index, options]);
    this.changes.push(...this.takeStash(index, true));
  }

  async stashDrop(index: number): Promise<void> {
    await this.enter("stashDrop", [index]);
    this.takeStash(index, true);
  }

  async remotes(): Promise<GitRemote[]> {
    await this.enter("remotes", []);
    return this.remoteList.map((remote) => ({ ...remote }));
  }

  async fetch(options?: GitFetchOptions): Promise<void> {
    await this.enter("fetch", [options]);
  }

  async pull(options?: GitPullOptions): Promise<void> {
    await this.enter("pull", [options]);
    this.branchState.behind = 0;
  }

  async push(options?: GitPushOptions): Promise<GitPushResult> {
    await this.enter("push", [options]);
    const branch = this.branchState.name;
    if (!options?.setUpstream && !this.branchState.upstream) {
      throw gitFailure({
        args: ["push"],
        exitCode: 128,
        stderr: `fatal: The current branch ${branch} has no upstream branch.`,
        stdout: "",
      });
    }
    if (options?.setUpstream) this.branchState.upstream = `${options.remote ?? "origin"}/${branch}`;
    this.branchState.ahead = 0;
    return {
      remote: options?.setUpstream ? (options.remote ?? "origin") : null,
      branch,
      upstreamSet: options?.setUpstream ?? false,
    };
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** Convenience for tests that need a typed error instance. */
export function mockGitError(message = "mock failure"): LucyError {
  return gitFailure({ args: ["mock"], exitCode: 1, stderr: message, stdout: "" });
}
