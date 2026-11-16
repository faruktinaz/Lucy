/**
 * Editor model: the read-only viewer's documents, per-tab state, navigation and in-file find.
 * Plain TypeScript with state in `Store`s; views bind with `useSyncExternalStore`.
 */
export { type BreadcrumbSegment, breadcrumbSegments } from "./breadcrumbs";
export { decideReload, type FileObservation, observeFile, type ReloadDecision } from "./change-detection";
export { documentLines, splitLines } from "./document-lines";
export {
  type BinaryDocument,
  type DocumentAction,
  type DocumentFailureReason,
  type DocumentNotice,
  type FileStamp,
  type HighlightState,
  isLoadedDocument,
  type LoadedDocument,
  type TextDocument,
  type TooLargeDocument,
  type UnavailableDocument,
  type ViewerDocument,
} from "./document-types";
export { type FindMatch, firstMatchAtOrAfter, lineMatchRange, matchesOnLine } from "./find-matches";
export {
  DEFAULT_MAX_FIND_MATCHES,
  DEFAULT_REGEX_BUDGET_MS,
  FindModel,
  type FindModelOptions,
  type FindPosition,
  type FindState,
  type FindStatus,
  formatFindLabel,
} from "./find-model";
export {
  type CompiledFindQuery,
  compileFindQuery,
  DEFAULT_FIND_OPTIONS,
  type FindOptions,
} from "./find-query";
export { describeMime, encodingLabel, formatFileSize, lineEndingLabel } from "./format";
export { type GoToLineOptions, type GoToLineResult, goToLinePlaceholder, parseGoToLine } from "./go-to-line";
export {
  type LoadDocumentOptions,
  loadDocument,
  type SyntaxFacts,
  unavailableDocument,
} from "./load-document";
export {
  canPreviewMarkdown,
  isMarkdownLanguage,
  showsMarkdownPreview,
  toggleMarkdownPreview,
} from "./markdown";
export {
  clampLine,
  clampScrollTop,
  clampViewerState,
  DEFAULT_SCROLL_MARGIN,
  maxScrollTop,
  moveActiveLine,
  pageSize,
  scrollBy,
  scrollHorizontally,
  scrollToReveal,
  type ViewerMove,
  type ViewportMetrics,
} from "./navigation";
export {
  createViewerState,
  createViewerStore,
  exportViewerState,
  restoreViewerState,
  type ViewerState,
  type ViewerStateDefaults,
  type ViewerStateSnapshot,
} from "./viewer-state";
export { ViewerTab, type ViewerTabOptions, type ViewerTabState } from "./viewer-tab";
