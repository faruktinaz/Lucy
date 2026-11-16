/**
 * Public, immutable shapes produced by `FileTree` for a virtualized explorer list.
 *
 * Snapshots are replaced (never mutated) when something changes, so a renderer can compare
 * row objects by reference to skip redrawing unchanged rows.
 */
import type { LucyErrorCode } from "@/core/errors";
import type { EntryKind, SymlinkTarget } from "./list-directory";

export type { EntryKind, SymlinkTarget };

export interface TreeEntryError {
  readonly code: LucyErrorCode;
  readonly message: string;
}

export interface TreeEntry {
  /** Workspace-relative POSIX path, "" for the root. Raw bytes: may contain control characters. */
  readonly path: string;
  readonly name: string;
  /** For symlinks, the kind of the target ("file" when the link is broken). */
  readonly kind: EntryKind;
  readonly isSymlink: boolean;
  /** `null` unless `isSymlink`. */
  readonly symlinkTarget: SymlinkTarget | null;
  /** Ignored by Git (inside a repository only). The UI dims these. */
  readonly isIgnored: boolean;
  /** Name starts with ".". */
  readonly isHidden: boolean;
  /** Reached through an explicitly expanded symlinked directory that points outside the workspace. */
  readonly isExternal: boolean;
  /** 0 for top-level entries (the root itself is -1). */
  readonly depth: number;
  readonly expanded: boolean;
  /** Children have been read at least once and are available. */
  readonly loaded: boolean;
  /** A read of this directory is in flight. */
  readonly loading: boolean;
  /** Why the directory could not be read (permission denied, symlink loop, vanished, ...). */
  readonly error: TreeEntryError | null;
}

interface RowBase {
  /** Stable identity across refreshes: the entry path, or `<parent>\0more` for a marker. */
  readonly key: string;
  /** Indentation level, equal to the entry depth. */
  readonly depth: number;
  /**
   * One flag per indentation level `0..depth-1`: whether a vertical guide line continues
   * through this row at that level (the ancestor at that level has a following sibling).
   */
  readonly guides: readonly boolean[];
  /** Last row among its siblings (draw "└" rather than "├"). */
  readonly isLast: boolean;
}

export interface TreeEntryRow extends RowBase {
  readonly type: "entry";
  readonly entry: TreeEntry;
}

/** Stands in for children beyond the render cap of a huge directory. */
export interface TreeMoreRow extends RowBase {
  readonly type: "more";
  readonly parentPath: string;
  readonly hiddenCount: number;
}

export type TreeRow = TreeEntryRow | TreeMoreRow;

export interface FileTreeViewOptions {
  /** Show dotfiles. Default true. */
  readonly showHidden: boolean;
  /** Show Git-ignored entries (flagged with `isIgnored`). Default true, like VS Code. */
  readonly showIgnored: boolean;
  /** Always hidden. Simple globs (see `createGlobMatcher`). Default `.git`, `.DS_Store`. */
  readonly exclude: readonly string[];
}

export interface FileTreeFilterState {
  /** Active filter text, "" when not filtering. */
  readonly text: string;
  /** A filter computation is in flight (rows still show the previous result). */
  readonly pending: boolean;
  /** Number of matching files shown. */
  readonly matchCount: number;
  /** More files matched than `maxFilterMatches`; only the first ones are shown. */
  readonly truncated: boolean;
}
