/**
 * View shapes produced by `ExplorerViewModel`. Plain data: a renderer draws them as-is and
 * never needs the filesystem, Git or theme modules.
 */
import type { SymlinkTarget } from "@/adapters/filesystem";
import type { GitDecoration } from "@/adapters/git";
import type { LucyErrorCode } from "@/core/errors";
import type { FileIcon, TokenPath } from "@/themes";

/** Git status lookup for a workspace-relative path; `undefined` when unchanged or no repository. */
export type DecorationLookup = (path: string) => GitDecoration | undefined;

/** "Open this file" intent; the explorer never talks to an editor directly. */
export interface ExplorerOpenIntent {
  readonly path: string;
  /** Single click / space: a preview tab that the next preview replaces. */
  readonly preview: boolean;
}

export interface ExplorerGitBadge {
  /** Status letter (M, A, D, R, C, T, U, ?) for files; the "contains changes" glyph for folders. */
  readonly text: string;
  readonly color: TokenPath;
  /** Folder marker: render quieter than a file letter. */
  readonly quiet: boolean;
  /** Changed files at or below this entry. */
  readonly count: number;
}

interface RowBase {
  /** Stable identity for selection and React keys. */
  readonly key: string;
  readonly depth: number;
  /** Per indentation level: whether a vertical guide continues through this row. */
  readonly guides: readonly boolean[];
  readonly isLast: boolean;
  readonly selected: boolean;
}

export interface ExplorerEntryRow extends RowBase {
  readonly type: "entry";
  readonly path: string;
  /** Display-safe name (control and bidi characters replaced). */
  readonly name: string;
  readonly kind: "file" | "directory";
  readonly expanded: boolean;
  readonly loading: boolean;
  /** Why a folder could not be read, display-safe. */
  readonly error: string | null;
  /** Git-ignored: draw quieter. */
  readonly dimmed: boolean;
  /** Dotfile. */
  readonly hidden: boolean;
  /** Non-null for symlinks: where the link points. */
  readonly symlink: SymlinkTarget | null;
  /** Lives under a symlinked folder that points outside the workspace. */
  readonly external: boolean;
  readonly icon: FileIcon;
  /** Color for the name: Git status color, `git.ignored` when dimmed, else `fg.default`. */
  readonly nameColor: TokenPath;
  readonly git: ExplorerGitBadge | null;
  /** The file shown in the active editor. */
  readonly active: boolean;
}

/** "N more" marker for a capped folder; activating it shows more children. */
export interface ExplorerMoreRow extends RowBase {
  readonly type: "more";
  readonly parentPath: string;
  readonly hiddenCount: number;
  /** e.g. "19,500 more…". */
  readonly label: string;
}

export type InlineEditMode = "create-file" | "create-folder" | "rename";

export interface ValidationMessage {
  /** Errors block commit; warnings only inform (for example surrounding whitespace). */
  readonly severity: "error" | "warning";
  readonly text: string;
}

/** The input row of an inline create or rename. */
export interface ExplorerEditRow extends RowBase {
  readonly type: "edit";
  readonly mode: InlineEditMode;
  /** What is being created or renamed. */
  readonly entryKind: "file" | "directory";
  readonly value: string;
  readonly message: ValidationMessage | null;
  readonly busy: boolean;
  readonly icon: FileIcon;
}

export type ExplorerRow = ExplorerEntryRow | ExplorerMoreRow | ExplorerEditRow;

export interface InlineEditState {
  readonly mode: InlineEditMode;
  /** Folder the new entry goes into (create), or the entry's parent (rename). */
  readonly parentPath: string;
  /** Entry being renamed. */
  readonly targetPath: string | null;
  readonly value: string;
  readonly message: ValidationMessage | null;
  /** A commit is running. */
  readonly busy: boolean;
}

export interface DeleteConfirmation {
  readonly path: string;
  /** Display-safe name. */
  readonly name: string;
  readonly kind: "file" | "directory" | "symlink";
  /** Entries inside a folder (null for files and links). */
  readonly itemCount: number | null;
  /** Counting stopped at the limit: show "more than N". */
  readonly itemCountCapped: boolean;
  /** Short question, e.g. `Delete the folder “src” and its 42 items?`. */
  readonly title: string;
  /** e.g. "It will be moved to Lucy's undo trash. You can undo this." */
  readonly detail: string;
  readonly confirmLabel: string;
}

export interface ExplorerNotice {
  readonly kind: "info" | "error";
  /** For "info": what was done (an undo description); for "error": what went wrong. */
  readonly message: string;
  /** The failure's error code, so the UI can offer a way out (e.g. `TOO_LARGE`). */
  readonly code?: LucyErrorCode;
  /** The entry the failed operation was about. */
  readonly path?: string;
}

export interface ExplorerFilterSummary {
  readonly text: string;
  readonly active: boolean;
  readonly pending: boolean;
  readonly matchCount: number;
  readonly truncated: boolean;
  /** e.g. "12 matches", "No matches", "Searching…"; "" when not filtering. */
  readonly summary: string;
}

export interface ExplorerState {
  readonly rowCount: number;
  /** Bumped whenever any row may have changed: re-read the visible window with `getRows`. */
  readonly rowsVersion: number;
  readonly selectedKey: string | null;
  /** -1 when nothing is selected or the selection is not visible (filtered, collapsed). */
  readonly selectedIndex: number;
  readonly activePath: string | null;
  readonly showHidden: boolean;
  readonly showIgnored: boolean;
  readonly filter: ExplorerFilterSummary;
  readonly edit: InlineEditState | null;
  readonly pendingDelete: DeleteConfirmation | null;
  /** Description of what `undo()` would do (for a menu or tooltip), or null. */
  readonly undoDescription: string | null;
  /** Last operation outcome for a toast; cleared by `dismissNotice()`. */
  readonly notice: ExplorerNotice | null;
  /** The workspace root could not be read. */
  readonly rootError: string | null;
  /** The root listing has not arrived yet. */
  readonly loading: boolean;
}

/** What the workspace-restore layer persists for the explorer. */
export interface ExplorerSnapshot {
  readonly expanded: readonly string[];
  readonly selected: string | null;
}
