/**
 * UI-independent model of the file explorer (VS Code style) on top of `FileTree` and `FileOps`.
 *
 * - State lives in `store` (small scalars: counts, selection, edit/delete state, summaries).
 *   Rows are pulled for the visible window only with `getRows(start, end)`; row objects are
 *   cached per tree row, so unchanged rows keep their identity between renders.
 * - Keyboard behavior is a set of transitions on the selection (`moveDown`, `left`, `enter`,
 *   type-ahead, ...). Opening a file is an intent (`onOpen`), never an editor call.
 * - Create and rename are an inline-edit state machine (`beginCreate` / `beginRename` →
 *   `setEditValue` with live validation → `commitEdit` | `cancelEdit`). Delete is two-step
 *   (`requestDelete` returns what the dialog needs, `confirmDelete` performs it).
 * - The model never disposes the tree or the file operations it was given.
 */
import { join } from "node:path";
import type { FileOps, FileTree, TreeEntry, TreeRow, WatchBatch } from "@/adapters/filesystem";
import type { LucyErrorCode } from "@/core/errors";
import { errorMessage, isLucyError } from "@/core/errors";
import { type Disposable, DisposableStore } from "@/core/events";
import { Store } from "@/core/store";
import { sanitizeForDisplay } from "@/core/text";
import { STATE_LIMITS } from "@/core/workspace";
import { type IconTier, iconForFile } from "@/themes";
import { countEntries } from "./count-entries";
import { findTypeAhead, firstChildIndex, moveIndex, pageIndex, parentIndex } from "./explorer-navigation";
import { entryRowView, formatCount, moreRowView, type RowViewContext } from "./explorer-row-view";
import type {
  DecorationLookup,
  DeleteConfirmation,
  ExplorerEditRow,
  ExplorerFilterSummary,
  ExplorerOpenIntent,
  ExplorerRow,
  ExplorerSnapshot,
  ExplorerState,
  InlineEditMode,
  InlineEditState,
} from "./explorer-types";
import { joinPath, validateEntryName } from "./name-validation";

/**
 * The file operations the model uses. Structural on purpose: the app hands over a lazy
 * wrapper so the `FileOps` domain service is only created by the first real operation.
 */
export type ExplorerFileOps = Pick<
  FileOps,
  "createFile" | "createDirectory" | "rename" | "delete" | "undo" | "canUndo" | "describeUndo"
>;

export interface ExplorerViewModelOptions {
  readonly tree: FileTree;
  readonly fileOps: ExplorerFileOps;
  readonly iconTier: IconTier;
  /** Git decorations (e.g. `(path) => gitService.decorationFor(path)`); omit without a repository. */
  readonly decorations?: DecorationLookup;
  readonly onOpen?: (intent: ExplorerOpenIntent) => void;
  /** Clock for type-ahead (tests). */
  readonly now?: () => number;
  /** Pause after which type-ahead starts a new prefix. Default 1000 ms. */
  readonly typeAheadResetMs?: number;
  /** Folders larger than this report "more than N items" in the delete dialog. Default 10 000. */
  readonly deleteCountLimit?: number;
}

/** Key of the inline "create" input row. Cannot collide with a path (paths never contain NUL). */
export const EDIT_ROW_KEY = "\0edit";

interface CachedRow {
  readonly view: ExplorerRow;
  readonly epoch: number;
  readonly selected: boolean;
  readonly active: boolean;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function quote(text: string): string {
  return `“${sanitizeForDisplay(text)}”`;
}

function errorCode(error: unknown): LucyErrorCode | undefined {
  return isLucyError(error) ? error.code : undefined;
}

function friendlyError(error: unknown, attempted: string): string {
  if (!isLucyError(error)) return errorMessage(error);
  switch (error.code) {
    case "ALREADY_EXISTS":
      return `${quote(nameOf(attempted))} already exists here.`;
    case "OUTSIDE_WORKSPACE":
      return "The name must stay inside the workspace.";
    case "PERMISSION_DENIED":
      return `Permission denied: ${sanitizeForDisplay(attempted)}`;
    case "NOT_FOUND":
      return `${quote(attempted)} no longer exists.`;
    default:
      return sanitizeForDisplay(error.message);
  }
}

/** A sentence about the unreadable workspace root (the generic message would say "Not found: ."). */
function rootErrorMessage(error: { code: string; message: string }): string {
  if (error.code === "NOT_FOUND") return "The folder no longer exists.";
  if (error.code === "PERMISSION_DENIED") return "Lucy does not have permission to read this folder.";
  return sanitizeForDisplay(error.message);
}

function filterSummary(state: ReturnType<FileTree["getFilterState"]>): ExplorerFilterSummary {
  const active = state.text !== "";
  let summary = "";
  if (active) {
    if (state.pending && state.matchCount === 0) summary = "Searching…";
    else if (state.matchCount === 0) summary = "No matches";
    else {
      summary = `${formatCount(state.matchCount)} ${state.matchCount === 1 ? "match" : "matches"}`;
      if (state.truncated) summary += ` (showing the first ${formatCount(state.matchCount)})`;
    }
  }
  return {
    text: state.text,
    active,
    pending: state.pending,
    matchCount: state.matchCount,
    truncated: state.truncated,
    summary,
  };
}

export class ExplorerViewModel implements Disposable {
  readonly store: Store<ExplorerState>;
  private readonly tree: FileTree;
  private readonly fileOps: ExplorerFileOps;
  private readonly onOpen?: (intent: ExplorerOpenIntent) => void;
  private readonly now: () => number;
  private readonly typeAheadResetMs: number;
  private readonly deleteCountLimit: number;
  private readonly disposables = new DisposableStore();
  private tier: IconTier;
  private decorations: DecorationLookup | null;

  private treeRows: readonly TreeRow[] = [];
  private createIndex = -1;
  private edit: InlineEditState | null = null;
  private selectedKey: string | null = null;
  private lastIndex = -1;
  private activePath: string | null = null;
  private epoch = 0;
  private rowsVersion = 0;
  private readonly cache = new WeakMap<TreeRow, CachedRow>();
  private typeAheadBuffer = "";
  private typeAheadAt = 0;
  private pendingDelete: DeleteConfirmation | null = null;
  private notice: ExplorerState["notice"] = null;

  constructor(options: ExplorerViewModelOptions) {
    this.tree = options.tree;
    this.fileOps = options.fileOps;
    this.tier = options.iconTier;
    this.decorations = options.decorations ?? null;
    this.onOpen = options.onOpen;
    this.now = options.now ?? Date.now;
    this.typeAheadResetMs = options.typeAheadResetMs ?? 1000;
    this.deleteCountLimit = options.deleteCountLimit ?? 10_000;
    this.store = new Store<ExplorerState>(this.computeState());
    this.disposables.add(this.tree.onDidChange(() => this.sync()));
  }

  /** Reads the workspace root. */
  async initialize(): Promise<void> {
    await this.tree.initialize();
    this.sync();
  }

  dispose(): void {
    this.disposables.dispose();
  }

  // ---------------------------------------------------------------------------------------
  // Rows

  /** Display rows `[start, end)` of the virtualized list. */
  getRows(start: number, end: number): ExplorerRow[] {
    const out: ExplorerRow[] = [];
    const count = this.rowCount();
    for (let index = Math.max(0, start); index < Math.min(end, count); index++) {
      const row = this.getRow(index);
      if (row) out.push(row);
    }
    return out;
  }

  getRow(index: number): ExplorerRow | undefined {
    if (index === this.createIndex) return this.editRowView();
    const treeRow = this.treeRowAt(index);
    if (!treeRow) return undefined;
    if (treeRow.type === "entry" && this.edit?.mode === "rename" && treeRow.key === this.edit.targetPath) {
      return this.editRowView(treeRow);
    }
    const selected = treeRow.key === this.selectedKey;
    const active = treeRow.type === "entry" && treeRow.entry.path === this.activePath;
    const cached = this.cache.get(treeRow);
    if (cached && cached.epoch === this.epoch && cached.selected === selected && cached.active === active) {
      return cached.view;
    }
    const view =
      treeRow.type === "more"
        ? moreRowView(treeRow, this.selectedKey)
        : entryRowView(treeRow, treeRow.entry, this.viewContext());
    this.cache.set(treeRow, { view, epoch: this.epoch, selected, active });
    return view;
  }

  // ---------------------------------------------------------------------------------------
  // Selection and keyboard

  /** Selects a row by key (an entry path, a "more" row key) or clears the selection. */
  select(key: string | null): void {
    this.selectedKey = key;
    this.sync();
  }

  selectIndex(index: number): void {
    const key = this.keyAt(index);
    if (key !== null) this.select(key);
  }

  moveUp(): void {
    this.selectIndex(moveIndex(this.currentIndex(), -1, this.rowCount()));
  }

  moveDown(): void {
    this.selectIndex(moveIndex(this.currentIndex(), 1, this.rowCount()));
  }

  pageUp(pageSize: number): void {
    this.selectIndex(pageIndex(this.currentIndex(), -1, pageSize, this.rowCount()));
  }

  pageDown(pageSize: number): void {
    this.selectIndex(pageIndex(this.currentIndex(), 1, pageSize, this.rowCount()));
  }

  home(): void {
    this.selectIndex(0);
  }

  end(): void {
    this.selectIndex(this.rowCount() - 1);
  }

  /** Collapses an expanded folder, otherwise selects the parent folder. */
  async left(): Promise<void> {
    const index = this.currentIndex();
    const row = this.treeRowAt(index);
    if (!row) return;
    if (row.type === "entry" && row.entry.kind === "directory" && row.entry.expanded) {
      this.tree.collapse(row.entry.path);
      return;
    }
    const parent = parentIndex((i) => this.depthAt(i), index);
    if (parent !== -1) this.selectIndex(parent);
  }

  /** Expands a collapsed folder, otherwise moves to its first child. */
  async right(): Promise<void> {
    const index = this.currentIndex();
    const row = this.treeRowAt(index);
    if (row?.type !== "entry" || row.entry.kind !== "directory") return;
    if (!row.entry.expanded) {
      await this.tree.expand(row.entry.path);
      return;
    }
    const child = firstChildIndex((i) => this.depthAt(i), index, this.rowCount());
    if (child !== -1) this.selectIndex(child);
  }

  /** Enter: commits an inline edit, opens a file (kept), toggles a folder, or shows more. */
  async enter(): Promise<void> {
    if (this.edit) {
      await this.commitEdit();
      return;
    }
    await this.activate(this.currentIndex(), false);
  }

  /** Space: opens a file as a preview, toggles a folder, or shows more. */
  async space(): Promise<void> {
    if (this.edit) return;
    await this.activate(this.currentIndex(), true);
  }

  /** Row activation for mouse or keyboard: files open, folders toggle, "more" rows expand. */
  async activate(index: number, preview: boolean): Promise<void> {
    const row = this.treeRowAt(index);
    if (!row) return;
    this.selectIndex(index);
    if (row.type === "more") {
      this.tree.showMore(row.parentPath);
      return;
    }
    if (row.entry.kind === "directory") await this.tree.toggle(row.entry.path);
    else this.open(row.entry.path, preview);
  }

  open(path: string, preview: boolean): void {
    this.onOpen?.({ path, preview });
  }

  /** Type-ahead by first letters; keystrokes within `typeAheadResetMs` extend the prefix. */
  typeAhead(text: string): void {
    if (text === "" || this.edit) return;
    const now = this.now();
    this.typeAheadBuffer =
      now - this.typeAheadAt > this.typeAheadResetMs ? text : this.typeAheadBuffer + text;
    this.typeAheadAt = now;
    const index = findTypeAhead(
      (i) => {
        const row = this.treeRowAt(i);
        return row?.type === "entry" ? row.entry.name : null;
      },
      this.rowCount(),
      this.currentIndex(),
      this.typeAheadBuffer,
    );
    if (index !== -1) this.selectIndex(index);
  }

  /** Marks the file shown in the active editor. */
  setActiveFile(path: string | null): void {
    if (this.activePath === path) return;
    this.activePath = path;
    this.sync();
  }

  /**
   * "Reveal in explorer": reads and expands the ancestors, selects the entry and returns its
   * row index to scroll to (-1 when it does not exist or is hidden by the current options).
   */
  async reveal(path: string): Promise<number> {
    const treeIndex = await this.tree.expandTo(path);
    if (treeIndex === -1) return -1;
    this.selectedKey = path;
    this.sync();
    return this.store.get().selectedIndex;
  }

  // ---------------------------------------------------------------------------------------
  // Inline create / rename

  /** Starts creating a file or folder in the selected folder (or next to the selected file). */
  async beginCreate(kind: "file" | "folder"): Promise<void> {
    const parentPath = this.createParent();
    this.edit = null;
    if (parentPath !== "") await this.tree.expand(parentPath);
    const mode: InlineEditMode = kind === "file" ? "create-file" : "create-folder";
    this.edit = { mode, parentPath, targetPath: null, value: "", message: null, busy: false };
    this.selectedKey = EDIT_ROW_KEY;
    this.sync();
  }

  /** Starts renaming the selected entry. Returns false when nothing renamable is selected. */
  beginRename(): boolean {
    const row = this.treeRowAt(this.currentIndex());
    if (row?.type !== "entry") return false;
    this.edit = {
      mode: "rename",
      parentPath: parentOf(row.entry.path),
      targetPath: row.entry.path,
      value: row.entry.name,
      message: null,
      busy: false,
    };
    this.selectedKey = row.entry.path;
    this.sync();
    return true;
  }

  setEditValue(value: string): void {
    const edit = this.edit;
    if (!edit || edit.busy) return;
    this.edit = { ...edit, value, message: this.validate(edit, value) };
    this.sync();
  }

  /**
   * Commits the inline edit through `FileOps`. Returns the new path, or null when blocked by
   * validation or failed (the input stays open with the reason). A new file is opened.
   */
  async commitEdit(): Promise<string | null> {
    const edit = this.edit;
    if (!edit || edit.busy) return null;
    const message = this.validate(edit, edit.value);
    if (message?.severity === "error") {
      this.edit = { ...edit, message };
      this.sync();
      return null;
    }
    const target = joinPath(edit.parentPath, edit.value.endsWith("/") ? edit.value.slice(0, -1) : edit.value);
    if (edit.mode === "rename" && target === edit.targetPath) {
      this.cancelEdit();
      return target;
    }
    this.edit = { ...edit, busy: true, message };
    this.sync();
    try {
      let result: string;
      if (edit.mode === "create-file") result = await this.fileOps.createFile(target);
      else if (edit.mode === "create-folder") result = await this.fileOps.createDirectory(target);
      else result = await this.fileOps.rename(edit.targetPath as string, target);
      this.edit = null;
      await this.refreshAround([result, ...(edit.targetPath ? [edit.targetPath] : [])]);
      await this.reveal(result);
      if (edit.mode === "create-file") this.open(result, false);
      return result;
    } catch (error) {
      this.edit = {
        ...edit,
        busy: false,
        message: { severity: "error", text: friendlyError(error, target) },
      };
      this.sync();
      return null;
    }
  }

  cancelEdit(): void {
    const edit = this.edit;
    if (!edit) return;
    this.edit = null;
    if (this.selectedKey === EDIT_ROW_KEY) this.selectedKey = edit.parentPath === "" ? null : edit.parentPath;
    this.sync();
  }

  // ---------------------------------------------------------------------------------------
  // Delete and undo

  /** Prepares the confirmation for deleting `path` (default: the selection). */
  async requestDelete(path?: string): Promise<DeleteConfirmation | null> {
    const target = path ?? this.selectedEntry()?.path;
    if (target === undefined) return null;
    const entry = this.tree.getEntry(target);
    if (!entry || target === "") return null;
    const kind = entry.isSymlink ? "symlink" : entry.kind;
    let itemCount: number | null = null;
    let itemCountCapped = false;
    if (kind === "directory") {
      const counted = await countEntries(join(this.tree.root, ...target.split("/")), {
        limit: this.deleteCountLimit,
      });
      itemCount = counted.count;
      itemCountCapped = counted.capped;
    }
    const name = sanitizeForDisplay(entry.name);
    let title: string;
    if (kind === "symlink") title = `Delete the link “${name}”? Its target is not affected.`;
    else if (kind === "file") title = `Delete “${name}”?`;
    else if (itemCount === 0) title = `Delete the empty folder “${name}”?`;
    else {
      const amount = `${itemCountCapped ? "more than " : ""}${formatCount(itemCount ?? 0)}`;
      title = `Delete the folder “${name}” and the ${amount} ${itemCount === 1 ? "item" : "items"} inside it?`;
    }
    this.pendingDelete = {
      path: target,
      name,
      kind,
      itemCount,
      itemCountCapped,
      title,
      detail: "It will be moved to Lucy's undo trash. You can undo this.",
      confirmLabel: "Move to Trash",
    };
    this.sync();
    return this.pendingDelete;
  }

  /** Performs the pending delete. Returns false when there was nothing to do or it failed. */
  async confirmDelete(options: { permanent?: boolean } = {}): Promise<boolean> {
    const pending = this.pendingDelete;
    if (!pending) return false;
    this.pendingDelete = null;
    const neighbor = this.neighborAfterRemoving(pending.path);
    try {
      await this.fileOps.delete(pending.path, { permanent: options.permanent });
    } catch (error) {
      this.notice = {
        kind: "error",
        message: friendlyError(error, pending.path),
        code: errorCode(error),
        path: pending.path,
      };
      this.sync();
      return false;
    }
    if (this.selectedKey === pending.path || this.selectedKey?.startsWith(`${pending.path}/`)) {
      this.selectedKey = neighbor;
    }
    if (this.activePath === pending.path) this.activePath = null;
    await this.refreshAround([pending.path]);
    this.sync();
    return true;
  }

  cancelDelete(): void {
    if (!this.pendingDelete) return;
    this.pendingDelete = null;
    this.sync();
  }

  /** Undoes the last file operation; returns its description for a toast, or null. */
  async undo(): Promise<string | null> {
    if (!this.fileOps.canUndo) return null;
    try {
      const result = await this.fileOps.undo();
      await this.refreshAround(result.changedPaths);
      this.notice = { kind: "info", message: result.description };
      this.sync();
      return result.description;
    } catch (error) {
      this.notice = {
        kind: "error",
        message: `Could not undo: ${friendlyError(error, "")}`,
        code: errorCode(error),
      };
      this.sync();
      return null;
    }
  }

  dismissNotice(): void {
    if (!this.notice) return;
    this.notice = null;
    this.sync();
  }

  // ---------------------------------------------------------------------------------------
  // Filter, options, refresh, restore

  setFilter(text: string): Promise<void> {
    const pending = this.tree.setFilter(text);
    this.sync();
    return pending.then(() => this.sync());
  }

  clearFilter(): Promise<void> {
    return this.setFilter("");
  }

  setShowHidden(show: boolean): void {
    this.tree.setOptions({ showHidden: show });
    this.sync();
  }

  setShowIgnored(show: boolean): void {
    this.tree.setOptions({ showIgnored: show });
    this.sync();
  }

  setIconTier(tier: IconTier): void {
    if (tier === this.tier) return;
    this.tier = tier;
    this.invalidateDecorations();
  }

  setDecorationLookup(lookup: DecorationLookup | null): void {
    this.decorations = lookup;
    this.invalidateDecorations();
  }

  /** Call when Git status changed so badges are recomputed. */
  invalidateDecorations(): void {
    this.epoch++;
    this.sync();
  }

  /** Applies a file-watcher batch (the app layer wires `Watcher` to this). */
  async handleWatchBatch(batch: WatchBatch): Promise<void> {
    await this.tree.handleWatchBatch(batch);
    this.sync();
  }

  async refresh(): Promise<void> {
    await this.tree.refresh();
    this.sync();
  }

  exportSnapshot(): ExplorerSnapshot {
    const selected =
      this.selectedKey !== null && this.selectedKey !== EDIT_ROW_KEY && !this.selectedKey.includes("\0")
        ? this.selectedKey
        : null;
    return { expanded: this.tree.getExpandedPaths().slice(0, STATE_LIMITS.expandedPaths), selected };
  }

  /** Restores expansion lazily and the selection if it is visible afterwards. */
  async restoreSnapshot(snapshot: ExplorerSnapshot): Promise<void> {
    await this.tree.restoreExpanded(snapshot.expanded);
    if (snapshot.selected !== null && this.tree.indexOfPath(snapshot.selected) !== -1) {
      this.selectedKey = snapshot.selected;
    }
    this.sync();
  }

  // ---------------------------------------------------------------------------------------
  // Internals

  private viewContext(): RowViewContext {
    return {
      tier: this.tier,
      decorations: this.decorations,
      selectedKey: this.selectedKey,
      activePath: this.activePath,
    };
  }

  private rowCount(): number {
    return this.treeRows.length + (this.createIndex >= 0 ? 1 : 0);
  }

  private treeRowAt(index: number): TreeRow | undefined {
    if (index < 0 || index === this.createIndex) return undefined;
    return this.treeRows[this.createIndex >= 0 && index > this.createIndex ? index - 1 : index];
  }

  private keyAt(index: number): string | null {
    if (index >= 0 && index === this.createIndex) return EDIT_ROW_KEY;
    return this.treeRowAt(index)?.key ?? null;
  }

  private depthAt(index: number): number {
    if (index === this.createIndex) return this.createDepth();
    return this.treeRowAt(index)?.depth ?? 0;
  }

  private indexOfKey(key: string | null): number {
    if (key === null) return -1;
    if (key === EDIT_ROW_KEY) return this.createIndex;
    const treeIndex = this.tree.indexOfPath(key);
    if (treeIndex === -1) return -1;
    return this.createIndex >= 0 && treeIndex >= this.createIndex ? treeIndex + 1 : treeIndex;
  }

  /** The selection's index, or the last known position when the selected row disappeared. */
  private currentIndex(): number {
    const index = this.indexOfKey(this.selectedKey);
    if (index !== -1) return index;
    return this.lastIndex >= 0 ? Math.min(this.lastIndex, this.rowCount() - 1) : -1;
  }

  private selectedEntry(): TreeEntry | undefined {
    const row = this.treeRowAt(this.indexOfKey(this.selectedKey));
    return row?.type === "entry" ? row.entry : undefined;
  }

  private createParent(): string {
    const row = this.treeRowAt(this.indexOfKey(this.selectedKey));
    if (!row) return "";
    if (row.type === "more") return row.parentPath;
    if (row.entry.kind === "directory" && !row.entry.isSymlink) return row.entry.path;
    return parentOf(row.entry.path);
  }

  private createDepth(): number {
    const parent = this.edit?.parentPath ?? "";
    return parent === "" ? 0 : parent.split("/").length;
  }

  private kindOf(path: string): "file" | "directory" | null {
    return this.tree.getEntry(path)?.kind ?? null;
  }

  private validate(edit: InlineEditState, value: string) {
    return validateEntryName({
      root: this.tree.root,
      parentPath: edit.parentPath,
      value,
      kindOf: (path) => this.kindOf(path),
      currentPath: edit.targetPath,
    });
  }

  private editRowView(base?: TreeRow): ExplorerEditRow | undefined {
    const edit = this.edit;
    if (!edit) return undefined;
    let depth: number;
    let guides: readonly boolean[];
    let isLast: boolean;
    if (base) {
      ({ depth, guides, isLast } = base);
    } else {
      depth = this.createDepth();
      const parentRow =
        edit.parentPath === "" ? undefined : this.treeRows[this.tree.indexOfPath(edit.parentPath)];
      guides = parentRow ? [...parentRow.guides, !parentRow.isLast] : [];
      const next = this.treeRows[this.createIndex];
      isLast = next === undefined || next.depth < depth;
    }
    const isFolder =
      edit.mode === "create-folder" ||
      (edit.mode === "rename" && this.kindOf(edit.targetPath ?? "") === "directory");
    return {
      type: "edit",
      key: base ? base.key : EDIT_ROW_KEY,
      depth,
      guides,
      isLast,
      selected: true,
      mode: edit.mode,
      entryKind: isFolder ? "directory" : "file",
      value: edit.value,
      message: edit.message,
      busy: edit.busy,
      icon: iconForFile(nameOf(edit.value) || " ", isFolder ? "directory" : "file", this.tier),
    };
  }

  /** The key to select after `path` (and its subtree) disappears: the next row, else the previous. */
  private neighborAfterRemoving(path: string): string | null {
    const index = this.indexOfKey(path);
    if (index === -1) return this.selectedKey;
    const depth = this.depthAt(index);
    let next = index + 1;
    while (next < this.rowCount() && this.depthAt(next) > depth) next++;
    return this.keyAt(next) ?? this.keyAt(index - 1);
  }

  /** Re-reads the nearest loaded folder containing each path, so the change shows at once. */
  private async refreshAround(paths: readonly string[]): Promise<void> {
    const folders = new Set<string>();
    for (const path of paths) {
      let folder = parentOf(path);
      while (folder !== "" && this.tree.getEntry(folder) === undefined) folder = parentOf(folder);
      folders.add(folder);
    }
    // A folder that contains another in the set refreshes it too.
    const sorted = [...folders].sort((a, b) => a.length - b.length);
    const roots = sorted.filter(
      (folder, i) =>
        !sorted
          .slice(0, i)
          .some((outer) => outer === "" || folder === outer || folder.startsWith(`${outer}/`)),
    );
    for (const folder of roots) await this.tree.refresh(folder);
  }

  private computeState(): ExplorerState {
    const rootEntry = this.tree.getEntry("");
    const options = this.tree.getOptions();
    const selectedIndex = this.indexOfKey(this.selectedKey);
    return {
      rowCount: this.rowCount(),
      rowsVersion: this.rowsVersion,
      selectedKey: this.selectedKey,
      selectedIndex,
      activePath: this.activePath,
      showHidden: options.showHidden,
      showIgnored: options.showIgnored,
      filter: filterSummary(this.tree.getFilterState()),
      edit: this.edit,
      pendingDelete: this.pendingDelete,
      undoDescription: this.fileOps.describeUndo(),
      notice: this.notice,
      rootError: rootEntry?.error ? rootErrorMessage(rootEntry.error) : null,
      loading: rootEntry ? !rootEntry.loaded && rootEntry.error === null : true,
    };
  }

  private sync(): void {
    if (this.disposables.isDisposed) return;
    this.treeRows = this.tree.getVisibleRows();
    this.createIndex = -1;
    if (this.edit && this.edit.mode !== "rename") {
      const parentIndex = this.edit.parentPath === "" ? -1 : this.tree.indexOfPath(this.edit.parentPath);
      this.createIndex = parentIndex + 1;
    }
    if (this.edit?.mode === "rename" && this.tree.indexOfPath(this.edit.targetPath ?? "") === -1) {
      // The entry vanished (deleted on disk) while being renamed.
      this.edit = null;
    }
    const index = this.indexOfKey(this.selectedKey);
    if (index !== -1) this.lastIndex = index;
    this.rowsVersion++;
    this.store.set(this.computeState());
  }
}
