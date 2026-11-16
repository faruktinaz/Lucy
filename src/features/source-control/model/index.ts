/**
 * UI-independent Source Control model: patch parsing, diff rows, word diff, diff documents and
 * the Source Control view-model. No React or OpenTUI imports; views bind to the stores here.
 */
export {
  COMMIT_SUBJECT_SOFT_LIMIT,
  type CommitAction,
  type CommitBoxInput,
  type CommitBoxState,
  type CommitButton,
  computeCommitBox,
} from "./commit-box";
export {
  DiffDocument,
  type DiffDocumentInput,
  type DiffSideInfo,
  type DiffSideInput,
  type DiffSideName,
  type DiffSource,
  type DiffSyntax,
  type LoadDiffDocumentDeps,
  type LoadDiffDocumentOptions,
  loadDiffDocument,
  sidesForDiff,
} from "./diff-document";
export {
  DEFAULT_MAX_DIFF_ROWS,
  type DiffChange,
  type DiffHunkInfo,
  type DiffLineRef,
  DiffModel,
  type DiffModelOptions,
  type DiffViewKind,
  type SplitCell,
  type SplitHunkRow,
  type SplitPairRow,
  type SplitRow,
  type UnifiedHunkRow,
  type UnifiedLineRow,
  type UnifiedRow,
} from "./diff-model";
export {
  type DiffFileStatus,
  type DiffHunk,
  type DiffLine,
  type DiffLineKind,
  type ParsedDiff,
  parseUnifiedDiff,
  unquoteGitPath,
} from "./patch-parser";
export {
  createScmItem,
  itemKey,
  itemsFromStatus,
  SCM_SECTION_ORDER,
  SCM_SECTION_TITLES,
  type ScmGroup,
  type ScmItem,
  type ScmItemsByGroup,
  type ScmSection,
  scmStatusLetter,
  scmStatusToken,
  sectionKey,
  splitPath,
  statusInGroup,
} from "./scm-items";
export {
  type CommitDraft,
  describeProblem,
  type ScmActionError,
  type ScmActionResult,
  type ScmBranchInfo,
  type ScmCommitOutcome,
  type ScmConfirmation,
  type ScmDiscardConfirmation,
  type ScmDiscardSummary,
  type ScmDiscardTarget,
  type ScmPhase,
  type ScmProblem,
  type ScmProblemKind,
  type ScmRow,
  type ScmStageAllCommitConfirmation,
  type ScmState,
  ScmViewModel,
} from "./scm-view-model";
export {
  tokenizeForWordDiff,
  WORD_DIFF_DEFAULTS,
  type WordDiff,
  type WordDiffOptions,
  type WordRange,
  type WordToken,
  wordDiff,
} from "./word-diff";
