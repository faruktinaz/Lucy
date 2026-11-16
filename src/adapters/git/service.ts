/**
 * Stateful, UI-agnostic Git layer over any `GitAdapter`.
 *
 * Owns a `Store<GitState>` the Source Control panel, status bar and explorer bind to. `refresh()`
 * is coalesced and never throws (failures land in `state.error`), so it is safe to call on every
 * file-watcher event or focus change. Mutators throw on failure and always refresh afterwards,
 * even when they fail, because a failed Git command can still have changed the working tree.
 */
import { errorMessage, isLucyError, LucyError } from "@/core/errors";
import type { Disposable } from "@/core/events";
import { Store } from "@/core/store";
import { type GitDecoration, GitDecorationIndex } from "./decorations";
import { gitFailureKind, gitPrecondition } from "./errors";
import { toRepoPath } from "./paths";
import { statusEquals } from "./porcelain";
import { Coalescer } from "./queue";
import type {
  GitAdapter,
  GitBranchList,
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

export type GitOperationName =
  | "stage"
  | "unstage"
  | "stageAll"
  | "unstageAll"
  | "discard"
  | "commit"
  | "switchBranch"
  | "createBranch"
  | "stashPush"
  | "stashApply"
  | "stashPop"
  | "stashDrop"
  | "fetch"
  | "pull"
  | "push";

export interface GitState {
  /** `null` until a repository was found (and while the workspace is not a repository). */
  repo: GitRepositoryInfo | null;
  status: GitStatus | null;
  /** A refresh is in flight. */
  loading: boolean;
  /** Why the last refresh failed (`NOT_A_REPOSITORY`, git missing, timeout, ...); cleared on success. */
  error: LucyError | null;
  /** Epoch ms of the last successful status. */
  lastUpdated: number | null;
  /** The mutation currently running, if any. */
  busyOperation: GitOperationName | null;
}

/** Opens the adapter; throws a typed error when the workspace has no usable repository. */
export type GitAdapterFactory = () => Promise<GitAdapter>;

export interface GitServiceOptions {
  /** Clock for `lastUpdated` (tests). */
  now?: () => number;
  /** Debounce for `scheduleRefresh`. Default 150 ms. */
  refreshDelayMs?: number;
}

export const INITIAL_GIT_STATE: GitState = {
  repo: null,
  status: null,
  loading: false,
  error: null,
  lastUpdated: null,
  busyOperation: null,
};

function toLucyError(error: unknown): LucyError {
  if (isLucyError(error)) return error;
  return new LucyError("INTERNAL", errorMessage(error), { cause: error });
}

export class GitService implements Disposable {
  readonly store = new Store<GitState>(INITIAL_GIT_STATE);
  private current: GitAdapter | null = null;
  private opening: Promise<GitAdapter> | null = null;
  private readonly refreshes = new Coalescer<GitState>(() => this.runRefresh());
  private readonly pending: GitOperationName[] = [];
  private decorationCache: { status: GitStatus | null; index: GitDecorationIndex } | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly now: () => number;
  private readonly refreshDelayMs: number;

  constructor(
    private readonly openAdapter: GitAdapterFactory,
    options: GitServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.refreshDelayMs = options.refreshDelayMs ?? 150;
  }

  get state(): GitState {
    return this.store.get();
  }

  /** The open adapter, or `null` before the first successful refresh. */
  get adapter(): GitAdapter | null {
    return this.current;
  }

  // ---------------------------------------------------------------- refresh

  /** Coalesced refresh. Never rejects; read `state.error` for failures. */
  refresh(): Promise<GitState> {
    if (this.disposed) return Promise.resolve(this.store.get());
    return this.refreshes.run();
  }

  /** Debounced refresh for bursts of file-system events. */
  scheduleRefresh(delayMs = this.refreshDelayMs): void {
    if (this.disposed) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, delayMs);
    this.refreshTimer.unref?.();
  }

  private async ensureAdapter(): Promise<GitAdapter> {
    if (this.current) return this.current;
    if (!this.opening) {
      this.opening = this.openAdapter()
        .then((adapter) => {
          if (this.disposed) {
            adapter.dispose();
            throw gitPrecondition("cancelled", "The Git service was disposed.");
          }
          this.current = adapter;
          return adapter;
        })
        .finally(() => {
          this.opening = null;
        });
    }
    return this.opening;
  }

  private dropAdapter(): void {
    this.current?.dispose();
    this.current = null;
  }

  private async runRefresh(): Promise<GitState> {
    if (this.disposed) return this.store.get();
    this.store.update({ loading: true });
    let adapter: GitAdapter;
    try {
      adapter = await this.ensureAdapter();
    } catch (error) {
      // Not a repository (yet): the next refresh tries again, e.g. after `git init`.
      if (!this.disposed)
        this.store.update({ repo: null, status: null, loading: false, error: toLucyError(error) });
      return this.store.get();
    }
    try {
      const status = await adapter.status();
      if (this.disposed) return this.store.get();
      const previous = this.store.get().status;
      this.store.update({
        repo: adapter.repository,
        // Keep the old reference when nothing changed, so subscribers can skip re-rendering.
        status: previous && statusEquals(previous, status) ? previous : status,
        loading: false,
        error: null,
        lastUpdated: this.now(),
      });
    } catch (error) {
      if (this.disposed) return this.store.get();
      if (gitFailureKind(error) === "not-a-repository") {
        // The repository disappeared (.git deleted): rediscover next time.
        this.dropAdapter();
        this.store.update({ repo: null, status: null, loading: false, error: toLucyError(error) });
      } else {
        this.store.update({ loading: false, error: toLucyError(error) });
      }
    }
    return this.store.get();
  }

  // ---------------------------------------------------------------- decorations

  /** Path → decoration index for the current status, rebuilt only when the status changes. */
  decorations(): GitDecorationIndex {
    const status = this.store.get().status;
    if (!this.decorationCache || this.decorationCache.status !== status) {
      this.decorationCache = { status, index: GitDecorationIndex.fromStatus(status) };
    }
    return this.decorationCache.index;
  }

  /**
   * Decoration for a file or directory. Paths are workspace-relative by default (what the
   * explorer has); pass `"repo"` for repo-relative paths from status entries.
   */
  decorationFor(path: string, base: "workspace" | "repo" = "workspace"): GitDecoration | undefined {
    const repo = this.store.get().repo;
    if (!repo) return undefined;
    return this.decorations().get(base === "repo" ? path : toRepoPath(repo, path));
  }

  // ---------------------------------------------------------------- mutations

  private async mutation<T>(name: GitOperationName, task: (adapter: GitAdapter) => Promise<T>): Promise<T> {
    if (this.disposed) throw gitPrecondition("cancelled", "The Git service was disposed.");
    const adapter = await this.ensureAdapter();
    this.pending.push(name);
    this.store.update({ busyOperation: this.pending[0] ?? null });
    try {
      return await task(adapter);
    } finally {
      const index = this.pending.indexOf(name);
      if (index !== -1) this.pending.splice(index, 1);
      if (!this.disposed) {
        this.store.update({ busyOperation: this.pending[0] ?? null });
        await this.refresh();
      }
    }
  }

  /** Adds rename partners from the current status so both sides of a rename move together. */
  private withRenamePartners(paths: readonly string[], side: "index" | "worktree"): string[] {
    const out = new Set(paths);
    for (const change of this.store.get().status?.changes ?? []) {
      if (change.origPath && change[side] === "renamed" && out.has(change.path)) out.add(change.origPath);
    }
    return [...out];
  }

  stage(paths: readonly string[]): Promise<void> {
    return this.mutation("stage", (adapter) => adapter.stage(this.withRenamePartners(paths, "worktree")));
  }

  /** Unstaging a staged rename also unstages the deletion of its source path. */
  unstage(paths: readonly string[]): Promise<void> {
    return this.mutation("unstage", (adapter) => adapter.unstage(this.withRenamePartners(paths, "index")));
  }

  stageAll(options?: GitStageAllOptions): Promise<void> {
    return this.mutation("stageAll", (adapter) => adapter.stageAll(options));
  }

  unstageAll(): Promise<void> {
    return this.mutation("unstageAll", (adapter) => adapter.unstageAll());
  }

  /** DESTRUCTIVE. Show `previewDiscard` and confirm first. */
  discard(paths: readonly string[]): Promise<GitDiscardResult> {
    return this.mutation("discard", (adapter) => adapter.discard(paths));
  }

  commit(options: GitCommitOptions): Promise<GitCommitResult> {
    return this.mutation("commit", (adapter) => adapter.commit(options));
  }

  switchBranch(name: string): Promise<void> {
    return this.mutation("switchBranch", (adapter) => adapter.switchBranch(name));
  }

  createBranch(name: string, options?: GitCreateBranchOptions): Promise<void> {
    return this.mutation("createBranch", (adapter) => adapter.createBranch(name, options));
  }

  stashPush(options?: GitStashPushOptions): Promise<GitStashPushResult> {
    return this.mutation("stashPush", (adapter) => adapter.stashPush(options));
  }

  stashApply(index: number, options?: GitStashApplyOptions): Promise<void> {
    return this.mutation("stashApply", (adapter) => adapter.stashApply(index, options));
  }

  stashPop(index: number, options?: GitStashApplyOptions): Promise<void> {
    return this.mutation("stashPop", (adapter) => adapter.stashPop(index, options));
  }

  /** DESTRUCTIVE. */
  stashDrop(index: number): Promise<void> {
    return this.mutation("stashDrop", (adapter) => adapter.stashDrop(index));
  }

  fetch(options?: GitFetchOptions): Promise<void> {
    return this.mutation("fetch", (adapter) => adapter.fetch(options));
  }

  pull(options?: GitPullOptions): Promise<void> {
    return this.mutation("pull", (adapter) => adapter.pull(options));
  }

  push(options?: GitPushOptions): Promise<GitPushResult> {
    return this.mutation("push", (adapter) => adapter.push(options));
  }

  // ---------------------------------------------------------------- reads (no state change)

  private async read<T>(task: (adapter: GitAdapter) => Promise<T>): Promise<T> {
    if (this.disposed) throw gitPrecondition("cancelled", "The Git service was disposed.");
    return task(await this.ensureAdapter());
  }

  diff(target: GitDiffTarget, options?: GitDiffOptions): Promise<GitDiff> {
    return this.read((adapter) => adapter.diff(target, options));
  }

  fileAtRevision(path: string, revision: GitRevision, options?: GitReadOptions): Promise<GitFileContent> {
    return this.read((adapter) => adapter.fileAtRevision(path, revision, options));
  }

  previewDiscard(paths: readonly string[]): Promise<GitDiscardPreviewEntry[]> {
    return this.read((adapter) => adapter.previewDiscard(paths));
  }

  lastCommitMessage(): Promise<string | null> {
    return this.read((adapter) => adapter.lastCommitMessage());
  }

  branches(): Promise<GitBranchList> {
    return this.read((adapter) => adapter.branches());
  }

  log(options?: GitLogOptions): Promise<GitCommit[]> {
    return this.read((adapter) => adapter.log(options));
  }

  stashList(): Promise<GitStash[]> {
    return this.read((adapter) => adapter.stashList());
  }

  remotes(): Promise<GitRemote[]> {
    return this.read((adapter) => adapter.remotes());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.dropAdapter();
  }
}
