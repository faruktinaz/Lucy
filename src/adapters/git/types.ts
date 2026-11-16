/**
 * Public, UI-agnostic Git domain model.
 *
 * Every path in this module is repository-root-relative POSIX text exactly as Git reports it
 * (UTF-8, unquoted, NFC on macOS when `core.precomposeunicode` is on). Convert workspace or
 * absolute paths with the helpers in `paths.ts`; never hand a workspace-relative path to an
 * adapter method.
 */
import type { Disposable } from "@/core/events";

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "type-changed"
  | "unmerged"
  | "untracked";

export type GitConflictKind =
  | "both-deleted"
  | "added-by-us"
  | "deleted-by-them"
  | "added-by-them"
  | "deleted-by-us"
  | "both-added"
  | "both-modified";

export interface GitSubmoduleState {
  /** The submodule's checked-out commit differs from the recorded one. */
  commitChanged: boolean;
  /** The submodule has modified tracked files. */
  trackedChanges: boolean;
  /** The submodule has untracked files. */
  untrackedChanges: boolean;
}

export interface GitChange {
  /** Repo-root-relative POSIX path, exactly as Git reports it. */
  path: string;
  /** Source path of a rename or copy. */
  origPath?: string;
  /** Staged side; `undefined` when the index matches HEAD for this path. */
  index?: GitFileStatus;
  /** Unstaged side; `"untracked"` for untracked files, `"unmerged"` for conflicts. */
  worktree?: GitFileStatus;
  conflicted: boolean;
  conflictKind?: GitConflictKind;
  isSubmodule?: boolean;
  submodule?: GitSubmoduleState;
  /** Similarity percentage (0-100) for renames and copies. */
  score?: number;
}

export interface GitBranchStatus {
  /** Current branch name; `null` when HEAD is detached. */
  name: string | null;
  /** Commit HEAD points at; `null` on an unborn branch (no commits yet). */
  oid: string | null;
  detached: boolean;
  /** The branch has no commits yet. */
  unborn: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
}

export type GitOperation = "merge" | "rebase" | "am" | "cherry-pick" | "revert" | "bisect";

export type GitStatusTruncation = "entry-limit" | "output-limit" | "untracked-timeout";

export interface GitStatus {
  branch: GitBranchStatus;
  /** Every entry, in Git's order (tracked changes first, then untracked files). */
  changes: readonly GitChange[];
  /** Index differs from HEAD (excludes conflicts). */
  staged: readonly GitChange[];
  /** Working tree differs from the index (excludes conflicts and untracked files). */
  unstaged: readonly GitChange[];
  untracked: readonly GitChange[];
  conflicts: readonly GitChange[];
  operation: GitOperation | null;
  /** Number of stash entries (0 on Git versions that do not report it in porcelain v2). */
  stashCount: number;
  /** The list is incomplete; the UI should show a notice. */
  truncated: boolean;
  truncatedReason?: GitStatusTruncation;
}

export interface GitRepositoryInfo {
  /** Absolute, symlink-resolved top level of the working tree. */
  root: string;
  /** Absolute per-worktree Git directory (`.git`, or `.git/worktrees/<name>` for linked worktrees). */
  gitDir: string;
  /** Absolute Git directory shared by all worktrees. */
  commonDir: string;
  /** `.git` is a file pointing at another repository's worktree directory. */
  isLinkedWorktree: boolean;
  /** Absolute directory the workspace was opened at (may be a subdirectory of `root`). */
  workspaceRoot: string;
  /** Repo-relative POSIX path of `workspaceRoot` without trailing slash; `""` at the root. */
  workspacePrefix: string;
  gitVersion: string;
  /** Git converts NFD file names to NFC (macOS default); inputs are normalized to match. */
  precomposeUnicode: boolean;
}

export type GitDiscovery =
  | { kind: "repository"; repository: GitRepositoryInfo }
  | { kind: "bare-repository"; gitDir: string; gitVersion: string }
  | { kind: "not-a-repository"; cwd: string }
  | { kind: "unsafe-repository"; cwd: string; message: string }
  | { kind: "git-missing" }
  | { kind: "git-too-old"; gitVersion: string; minimumVersion: string };

export interface GitDiffTarget {
  path: string;
  /** Diff the index against HEAD instead of the working tree against the index. */
  staged?: boolean;
  /** Original path of a staged rename, so the patch shows the rename instead of an addition. */
  origPath?: string;
}

export interface GitCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface GitDiffOptions extends GitCallOptions {
  /** Lines of context (`-U`). Default 3. */
  context?: number;
  /** Byte cap for the patch (and for untracked files). Defaults to the adapter limit. */
  maxBytes?: number;
}

/**
 * - `unstaged`: working tree vs index.
 * - `staged`: index vs HEAD (vs the empty tree on an unborn branch).
 * - `untracked`: synthesized all-added patch.
 * - `conflict`: working tree (with conflict markers) vs "ours" (stage 2); see README.
 */
export type GitDiffMode = "unstaged" | "staged" | "untracked" | "conflict";

export interface GitDiff {
  /** Unified diff text; `""` when empty, binary or too large. */
  patch: string;
  mode: GitDiffMode;
  isBinary: boolean;
  isTooLarge: boolean;
  isEmpty: boolean;
}

/**
 * `HEAD`, `INDEX` (stage 0), `WORKTREE` (file on disk), the conflict stages `BASE`/`OURS`/`THEIRS`,
 * or any other revision such as a commit id or branch name. A branch that is literally named like
 * one of the keywords can be addressed as `refs/heads/<name>`.
 */
export type GitRevision = "HEAD" | "INDEX" | "WORKTREE" | "BASE" | "OURS" | "THEIRS" | (string & {});

export interface GitReadOptions extends GitCallOptions {
  /** Byte cap. Defaults to the adapter limit. */
  maxBytes?: number;
}

export interface GitFileContent {
  /** The path exists at that revision (as a regular file or symlink). */
  exists: boolean;
  /** Text content; `null` when missing, binary or too large. Symlinks yield their target path. */
  content: string | null;
  isBinary: boolean;
  isTooLarge: boolean;
  /** Size in bytes when known. */
  size: number | null;
}

export type GitDiscardAction = "restore" | "delete" | "none" | "blocked";

export interface GitDiscardPreviewEntry {
  path: string;
  /**
   * - `restore`: unstaged changes are replaced by the staged (index) version.
   * - `delete`: the untracked file is deleted.
   * - `none`: nothing unstaged to discard.
   * - `blocked`: cannot be discarded safely (see `reason`); `discard()` refuses the whole call.
   */
  action: GitDiscardAction;
  reason?: "conflicted" | "submodule" | "directory";
  change: GitChange | null;
  isBinary: boolean;
  /** Lines that would be lost (present only in the working tree). `null` when unknown or binary. */
  linesLost: number | null;
  /** Lines that would come back from the index. `null` when unknown or binary. */
  linesRestored: number | null;
  /** Size of an untracked file that would be deleted. */
  bytes: number | null;
}

export interface GitDiscardResult {
  restored: string[];
  deleted: string[];
  unchanged: string[];
}

export interface GitStageAllOptions {
  /** Also mark conflicted files as resolved. Without it, `stageAll` refuses while conflicts exist. */
  includeConflicts?: boolean;
}

export interface GitCommitOptions {
  /** Required unless `amend` is set (amend without a message keeps the previous one). */
  message?: string;
  amend?: boolean;
  signoff?: boolean;
}

export interface GitCommitResult {
  oid: string;
  shortOid: string;
  summary: string;
  /** `null` when HEAD is detached. */
  branch: string | null;
}

export interface GitBranch {
  /** Short name: `main`, `origin/main`. */
  name: string;
  /** Full ref: `refs/heads/main`. */
  ref: string;
  kind: "local" | "remote";
  /** `null` for the current unborn branch. */
  oid: string | null;
  isCurrent: boolean;
  /** Remote name for remote-tracking branches. */
  remote?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** The configured upstream no longer exists. */
  upstreamGone?: boolean;
}

export interface GitBranchList {
  /** Current branch name; `null` when detached. */
  current: string | null;
  detached: boolean;
  headOid: string | null;
  local: GitBranch[];
  remote: GitBranch[];
}

export interface GitCreateBranchOptions {
  /** Start point (branch, tag or commit). Defaults to HEAD. Starting from a remote-tracking branch sets it as upstream (Git default). */
  from?: string;
  /** Switch to the new branch. */
  switch?: boolean;
}

export interface GitLogOptions extends GitCallOptions {
  /** Default 100, max 10 000. */
  limit?: number;
  skip?: number;
  /** Only commits touching this repo-relative path. */
  path?: string;
  /** Revision to start from. Defaults to HEAD. */
  ref?: string;
}

export interface GitCommitRef {
  /** Short name: `main`, `origin/main`, `v1.0`, `HEAD`. */
  name: string;
  kind: "branch" | "remote" | "tag" | "head" | "other";
  /** HEAD points at this branch (`HEAD -> main`). */
  isHead: boolean;
}

export interface GitCommit {
  oid: string;
  shortOid: string;
  parents: string[];
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  /** ISO 8601 author date. */
  authorDate: string;
  refs: GitCommitRef[];
}

export interface GitStash {
  index: number;
  /** `stash@{<index>}` */
  ref: string;
  oid: string;
  /** Reflog subject, e.g. `On main: message` or `WIP on main: abc1234 subject`. */
  message: string;
  branch: string | null;
  /** ISO 8601 creation date. */
  date: string;
}

export interface GitStashPushOptions {
  message?: string;
  includeUntracked?: boolean;
}

export interface GitStashApplyOptions {
  /** Also restore which changes were staged (`--index`). */
  restoreIndex?: boolean;
}

export interface GitStashPushResult {
  /** `false` when there was nothing to stash. */
  created: boolean;
}

export interface GitRemote {
  name: string;
  /** URL with any embedded credentials redacted. */
  fetchUrl: string | null;
  pushUrl: string | null;
}

export interface GitFetchOptions extends GitCallOptions {
  /** Defaults to Git's choice (the upstream's remote, else `origin`). */
  remote?: string;
  all?: boolean;
  prune?: boolean;
}

export interface GitPullOptions extends GitCallOptions {
  /** Default `true`. When `false`, Git's configured strategy (`pull.rebase`) applies. */
  ffOnly?: boolean;
}

export interface GitPushOptions extends GitCallOptions {
  /** Publish the current branch and record the upstream (`--set-upstream`). */
  setUpstream?: boolean;
  /** Remote for `setUpstream`. Defaults to the only remote, or `origin`. */
  remote?: string;
}

export interface GitPushResult {
  remote: string | null;
  branch: string | null;
  upstreamSet: boolean;
}

/**
 * The capability surface the Source Control UI and the explorer depend on. Implemented by the
 * real CLI adapter and by `MockGitAdapter`. Methods taking paths expect repo-relative paths.
 */
export interface GitAdapter extends Disposable {
  readonly repository: GitRepositoryInfo;

  /** Coalesced: concurrent calls share one in-flight run plus at most one trailing run. */
  status(): Promise<GitStatus>;
  diff(target: GitDiffTarget, options?: GitDiffOptions): Promise<GitDiff>;
  fileAtRevision(path: string, revision: GitRevision, options?: GitReadOptions): Promise<GitFileContent>;

  stage(paths: readonly string[]): Promise<void>;
  unstage(paths: readonly string[]): Promise<void>;
  stageAll(options?: GitStageAllOptions): Promise<void>;
  unstageAll(): Promise<void>;
  previewDiscard(paths: readonly string[]): Promise<GitDiscardPreviewEntry[]>;
  /** DESTRUCTIVE: overwrites unstaged changes and deletes untracked files. Show `previewDiscard` first. */
  discard(paths: readonly string[]): Promise<GitDiscardResult>;

  commit(options: GitCommitOptions): Promise<GitCommitResult>;
  lastCommitMessage(): Promise<string | null>;

  branches(): Promise<GitBranchList>;
  switchBranch(name: string): Promise<void>;
  createBranch(name: string, options?: GitCreateBranchOptions): Promise<void>;

  log(options?: GitLogOptions): Promise<GitCommit[]>;

  stashList(): Promise<GitStash[]>;
  stashPush(options?: GitStashPushOptions): Promise<GitStashPushResult>;
  stashApply(index: number, options?: GitStashApplyOptions): Promise<void>;
  stashPop(index: number, options?: GitStashApplyOptions): Promise<void>;
  /** DESTRUCTIVE: the stash entry is gone (recoverable only via `git fsck`). */
  stashDrop(index: number): Promise<void>;

  remotes(): Promise<GitRemote[]>;
  fetch(options?: GitFetchOptions): Promise<void>;
  pull(options?: GitPullOptions): Promise<void>;
  push(options?: GitPushOptions): Promise<GitPushResult>;
}

/** Names of adapter methods, used by the mock's call log and failure injection. */
export type GitAdapterMethod = Exclude<keyof GitAdapter, "repository" | "dispose">;
