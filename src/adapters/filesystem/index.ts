/** Filesystem services: explorer tree model, safe mutations, viewer reads, file watching. */
export { foldCode, foldQuery, foldString } from "./case-fold";
export { FileOps, type FileOpsOptions, type UndoResult } from "./file-ops";
export { guessMime, isValidUtf8, looksBinary } from "./file-sniff";
export { FileTree, type FileTreeOptions } from "./file-tree";
export type {
  EntryKind,
  FileTreeFilterState,
  FileTreeViewOptions,
  SymlinkTarget,
  TreeEntry,
  TreeEntryError,
  TreeEntryRow,
  TreeMoreRow,
  TreeRow,
} from "./file-tree-types";
export { type ImageFormat, type ImageInfo, imageSize } from "./image-size";
export { createNameComparator } from "./natural-sort";
export {
  DEFAULT_VIEWER_LIMITS,
  type LineEnding,
  type ReadFileForViewerOptions,
  readFileForViewer,
  type ViewerBinaryFile,
  type ViewerFile,
  type ViewerLimits,
  type ViewerTextFile,
  type ViewerTooLargeFile,
} from "./read-file";
export type { PruneOptions, PruneResult } from "./undo-trash";
export {
  type WatchBatch,
  Watcher,
  type WatcherOptions,
  type WatcherState,
  type WatchFactory,
  type WatchHandle,
} from "./watcher";
export { normalizeWorkspacePath, type PathMode } from "./workspace-path";
