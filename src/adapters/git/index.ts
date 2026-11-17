/**
 * Public surface of the Git layer. Import from `@/adapters/git`; the runner, environment and
 * worktree helpers are internal, except `readOnlyGitInvocation`, the shared hardening for
 * read-only Git commands that other adapters run themselves (ignore detection, file index, grep).
 */
export {
  createGitAdapterFactory,
  DEFAULT_GIT_LIMITS,
  DEFAULT_GIT_TIMEOUTS,
  GitCliAdapter,
  type GitCliAdapterOptions,
  type GitLimits,
  type GitTimeouts,
  openGitRepository,
} from "./cli-adapter";
export { displayStatus, type GitDecoration, GitDecorationIndex, statusLetter } from "./decorations";
export { discoverRepository, type GitDiscoveryOptions, MINIMUM_GIT_VERSION } from "./discovery";
export { type ReadOnlyGitInvocation, readOnlyGitInvocation } from "./environment";
export {
  classifyGitFailure,
  type GitFailureDetails,
  type GitFailureKind,
  gitFailureKind,
  isGitFailure,
  isRetryableGitFailure,
} from "./errors";
export { MockGitAdapter, type MockGitAdapterOptions, type MockGitCall, mockGitError } from "./mock-adapter";
export {
  fromAbsolutePath,
  isInWorkspace,
  normalizeRepoPath,
  toAbsolutePath,
  toRepoPath,
  toWorkspacePath,
} from "./paths";
export { createGitStatus, type GitStatusInput, parsePorcelainV2, statusEquals } from "./porcelain";
export {
  GitRepositoryManager,
  type RepositoryEntry,
  type RepositoryManagerOptions,
  type RepositoryManagerState,
  repositoryLabelPath,
} from "./repository-manager";
export {
  DEFAULT_MAX_REPOSITORIES,
  DEFAULT_MAX_SCANNED_DIRECTORIES,
  type RepositoryScanOptions,
  type RepositoryScanResult,
  SKIPPED_FOLDERS,
  scanForRepositories,
} from "./repository-scan";
export {
  type GitAdapterFactory,
  type GitOperationName,
  GitService,
  type GitServiceOptions,
  type GitState,
  INITIAL_GIT_STATE,
} from "./service";
export type * from "./types";
