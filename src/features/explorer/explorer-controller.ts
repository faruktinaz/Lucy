/**
 * Glue between `ExplorerViewModel` and the workbench: opening files, Git decorations, the
 * file watcher, settings, persistence, dialogs, menus, toasts and the clipboard.
 *
 * Construction is cheap and side-effect free (the feature contract): the folder is first
 * read in `load()`, after the first paint, and the `FileOps` / `FileIndex` domain services
 * are only created by the first operation that needs them.
 */
import { join } from "node:path";
import { FileTree } from "@/adapters/filesystem";
import type { AppContext } from "@/app/app-context";
import { TRASH_LIMITS } from "@/app/domain/domain-services";
import type { MenuItem } from "@/app/workbench/menus";
import { type Disposable, DisposableStore, toDisposable } from "@/core/events";
import { Store } from "@/core/store";
import { sanitizeForDisplay, truncateMiddle } from "@/core/text";
import { type ExplorerFileOps, type ExplorerNotice, ExplorerViewModel } from "./model";

/** A screen cell a menu opens below. */
export interface ExplorerAnchor {
  readonly x: number;
  readonly y: number;
}

/** What only the mounted view can provide (screen geometry, the renderer's clipboard). */
export interface ExplorerViewBridge {
  /** The bottom-right corner of the explorer's header row. */
  headerAnchor(): ExplorerAnchor | null;
  /** The selected row, for menus opened from the keyboard. */
  selectionAnchor(): ExplorerAnchor | null;
  /** OSC 52 copy; false when the terminal refused or does not support it. */
  copy(text: string): boolean;
}

export interface ExplorerUiState {
  /** The folder has been read once (or failed). */
  readonly loaded: boolean;
  readonly filterOpen: boolean;
  /** Bumped to ask the view to focus the filter field. */
  readonly filterFocusRequest: number;
}

export type MenuWidthFn = (items: readonly MenuItem[]) => number;

const PERSIST_DELAY_MS = 300;

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function quote(text: string): string {
  return `“${truncateMiddle(sanitizeForDisplay(text), 40)}”`;
}

export class ExplorerController implements Disposable {
  readonly model: ExplorerViewModel;
  readonly tree: FileTree;
  readonly ui = new Store<ExplorerUiState>({ loaded: false, filterOpen: false, filterFocusRequest: 0 });
  private readonly disposables = new DisposableStore();
  private bridge: ExplorerViewBridge | null = null;
  private menuWidth: MenuWidthFn = () => 30;
  private loading: Promise<void> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPersisted = "";
  private lastNotice: ExplorerNotice | null = null;
  private lastActive: string | null = null;

  constructor(private readonly ctx: AppContext) {
    const { config } = ctx;
    const services = ctx.services;
    this.tree = new FileTree({
      root: ctx.workspace.root,
      showHidden: config.get("explorer.showHidden"),
      showIgnored: config.get("explorer.showIgnored"),
      exclude: config.get("explorer.exclude"),
      listAllFiles: (signal) => services.fileIndex.list(signal).then((result) => result.files),
      gitEnv: services.toolEnv ? { ...services.toolEnv } : undefined,
    });
    const created = () => services.createdServices.includes("fileOps");
    // Lazy on purpose: touching `services.fileOps` creates the service.
    const fileOps: ExplorerFileOps = {
      createFile: (path, contents) => services.fileOps.createFile(path, contents),
      createDirectory: (path) => services.fileOps.createDirectory(path),
      rename: (from, to) => services.fileOps.rename(from, to),
      delete: (path, options) => services.fileOps.delete(path, options),
      undo: () => services.fileOps.undo(),
      get canUndo() {
        return created() && services.fileOps.canUndo;
      },
      describeUndo: () => (created() ? services.fileOps.describeUndo() : null),
    };
    this.model = new ExplorerViewModel({
      tree: this.tree,
      fileOps,
      iconTier: ctx.themes.store.get().icons,
      decorations: (path) => services.git.decorationFor(path),
      onOpen: (intent) => this.openFile(intent.path, intent.preview),
    });
    this.disposables.add(this.model);
    this.disposables.add(this.tree);
    this.disposables.add(toDisposable(this.model.store.subscribe(() => this.onModelChange())));
    this.disposables.add(
      config.onDidChange((event) => {
        const changed = (path: string) => event.changed.includes(path as never);
        if (changed("explorer.showHidden")) this.model.setShowHidden(config.get("explorer.showHidden"));
        if (changed("explorer.showIgnored")) this.model.setShowIgnored(config.get("explorer.showIgnored"));
        if (changed("explorer.exclude")) this.tree.setOptions({ exclude: config.get("explorer.exclude") });
      }),
    );
    this.disposables.add(
      toDisposable(ctx.themes.store.subscribe(() => this.model.setIconTier(ctx.themes.store.get().icons))),
    );
    this.disposables.add(toDisposable(() => this.persistNow()));
  }

  /** Reads the folder, restores the saved expansion and starts following the workbench. */
  load(): Promise<void> {
    this.loading ??= this.doLoad();
    return this.loading;
  }

  private async doLoad(): Promise<void> {
    const ctx = this.ctx;
    await this.model.initialize();
    const saved = ctx.persisted.state.explorer;
    await this.model.restoreSnapshot({ expanded: saved.expanded, selected: saved.selected ?? null });
    this.lastPersisted = JSON.stringify(this.model.exportSnapshot());
    this.ui.update({ loaded: true });
    if (this.disposables.isDisposed) return;
    this.disposables.add(ctx.services.onDidChangeFiles((batch) => void this.model.handleWatchBatch(batch)));
    this.disposables.add(
      toDisposable(ctx.services.git.store.subscribe(() => this.model.invalidateDecorations())),
    );
    this.disposables.add(toDisposable(ctx.editors.store.subscribe(() => this.followActiveEditor())));
    this.followActiveEditor();
  }

  /** The view registers what only it knows; returns the registration. */
  attachView(bridge: ExplorerViewBridge, menuWidth: MenuWidthFn): Disposable {
    this.bridge = bridge;
    this.menuWidth = menuWidth;
    return toDisposable(() => {
      if (this.bridge === bridge) this.bridge = null;
    });
  }

  dispose(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.disposables.dispose();
  }

  // ---------------------------------------------------------------------------------------
  // Workbench integration

  openFile(path: string, preview: boolean): void {
    this.ctx.editors.open({ kind: "file", resource: path }, { preview });
    // Opening for good (Enter, double-click) hands the keyboard to the editor, like VS Code.
    if (!preview) this.ctx.focus.focus("editor");
  }

  /** The active editor's file is marked and revealed (VS Code's auto reveal). */
  private followActiveEditor(): void {
    const active = this.ctx.editors.active;
    const path = active?.kind === "file" && active.resource ? active.resource : null;
    if (path === this.lastActive) return;
    this.lastActive = path;
    this.model.setActiveFile(path);
    const state = this.model.store.get();
    if (path && !state.edit && !state.filter.active) void this.model.reveal(path);
  }

  private onModelChange(): void {
    const state = this.model.store.get();
    if (state.notice && state.notice !== this.lastNotice) {
      this.lastNotice = state.notice;
      const notice = state.notice;
      queueMicrotask(() => {
        this.model.dismissNotice();
        this.showNotice(notice);
      });
    }
    if (this.ui.get().loaded) this.schedulePersist();
  }

  private showNotice(notice: ExplorerNotice): void {
    const { notifications } = this.ctx;
    if (notice.kind === "info") {
      notifications.show({
        severity: "success",
        title: "Undone",
        message: notice.message,
        key: "explorer.undo",
      });
      return;
    }
    if (notice.code === "TOO_LARGE" && notice.path) {
      const path = notice.path;
      notifications.show({
        severity: "error",
        title: notice.message,
        actions: [{ label: "Delete Permanently…", run: () => this.deletePermanently(path) }],
        key: "explorer.delete",
      });
      return;
    }
    notifications.show({ severity: "error", title: notice.message, key: "explorer.error" });
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, PERSIST_DELAY_MS);
  }

  private persistNow(): void {
    if (!this.ui.get().loaded) return;
    const snapshot = this.model.exportSnapshot();
    const serialized = JSON.stringify(snapshot);
    if (serialized === this.lastPersisted) return;
    this.lastPersisted = serialized;
    this.ctx.persisted.update({
      explorer: { expanded: [...snapshot.expanded], selected: snapshot.selected ?? undefined },
    });
  }

  // ---------------------------------------------------------------------------------------
  // Actions (commands, menus and header buttons call these)

  /** Shows the explorer and gives it the keyboard. */
  async focusExplorer(): Promise<void> {
    await this.ctx.commands.execute("view.showExplorer");
    this.ctx.focus.focus("sidebar");
  }

  /** The selected entry's path, or null (nothing, a "more" row, or the inline input). */
  selectedPath(): string | null {
    const state = this.model.store.get();
    const row = state.selectedIndex >= 0 ? this.model.getRow(state.selectedIndex) : undefined;
    return row?.type === "entry" ? row.path : null;
  }

  activeFilePath(): string | null {
    const active = this.ctx.editors.active;
    return active?.kind === "file" && active.resource ? active.resource : null;
  }

  async newEntry(kind: "file" | "folder"): Promise<void> {
    await this.load();
    await this.focusExplorer();
    if (this.ui.get().filterOpen) await this.closeFilter();
    await this.model.beginCreate(kind);
  }

  async rename(): Promise<void> {
    await this.focusExplorer();
    this.model.beginRename();
  }

  /** Confirms (unless `explorer.confirmDelete` is off), deletes, and offers Undo in a toast. */
  async deleteSelection(path = this.selectedPath()): Promise<void> {
    if (!path) return;
    const confirmation = await this.model.requestDelete(path);
    if (!confirmation) return;
    if (this.ctx.config.get("explorer.confirmDelete")) {
      const confirmed = await this.ctx.dialogs.confirm({
        title: confirmation.title,
        message: `${confirmation.detail} Deleted items are kept for ${TRASH_LIMITS.maxAgeDays} days.`,
        confirmLabel: confirmation.confirmLabel,
        danger: true,
      });
      if (!confirmed) {
        this.model.cancelDelete();
        return;
      }
    }
    if (!(await this.model.confirmDelete())) return;
    this.ctx.notifications.show({
      severity: "info",
      title: `Moved ${quote(nameOf(path))} to Lucy's undo trash`,
      actions: [{ label: "Undo", run: () => this.undo() }],
      timeoutMs: 10_000,
      key: "explorer.delete",
    });
  }

  private async deletePermanently(path: string): Promise<void> {
    const confirmed = await this.ctx.dialogs.confirm({
      title: `Delete ${quote(nameOf(path))} permanently?`,
      message: "It is too large to move to Lucy's undo trash on this disk. This cannot be undone.",
      confirmLabel: "Delete Permanently",
      danger: true,
    });
    if (!confirmed) return;
    if (!(await this.model.requestDelete(path))) return;
    if (await this.model.confirmDelete({ permanent: true })) {
      this.ctx.notifications.success(`Deleted ${quote(nameOf(path))}`);
    }
  }

  async undo(): Promise<void> {
    await this.model.undo();
  }

  async refresh(): Promise<void> {
    await this.load();
    await this.model.refresh();
  }

  collapseAll(): void {
    this.tree.collapseAll();
  }

  async toggleSetting(path: "explorer.showHidden" | "explorer.showIgnored"): Promise<void> {
    const next = !this.ctx.config.get(path);
    // Applied live through `onDidChange`; persisted so the choice survives a restart.
    await this.ctx.config.set(path, next, { persist: true });
  }

  async revealActiveFile(): Promise<void> {
    const path = this.activeFilePath();
    if (!path) return;
    await this.load();
    if (this.ui.get().filterOpen) await this.closeFilter();
    await this.focusExplorer();
    const index = await this.model.reveal(path);
    if (index === -1) {
      this.ctx.notifications.info(
        `${quote(nameOf(path))} is not shown in the explorer`,
        "It may be hidden by the Show Hidden or Show Ignored settings, or excluded.",
      );
    }
  }

  /** Copies the explorer selection (or, from elsewhere, the active file) through OSC 52. */
  copyPath(relative: boolean): void {
    const focused = this.ctx.focus.current === "sidebar";
    const path = (focused ? this.selectedPath() : (this.activeFilePath() ?? this.selectedPath())) ?? null;
    if (path === null) {
      this.ctx.hints.flash({ text: "Select a file or folder to copy its path" });
      return;
    }
    const text = relative ? path : join(this.ctx.workspace.root, ...path.split("/"));
    let copied = false;
    try {
      copied = this.bridge?.copy(text) ?? false;
    } catch {
      copied = false;
    }
    if (copied) {
      this.ctx.hints.flash({ text: `Copied ${relative ? "relative path" : "path"}` });
      return;
    }
    this.ctx.notifications.show({
      severity: "warning",
      title: "This terminal did not accept the copy",
      message: `Copying needs OSC 52 clipboard support. The path is ${sanitizeForDisplay(text)}`,
      key: "explorer.copy",
    });
  }

  async openFilter(): Promise<void> {
    await this.load();
    if (this.model.store.get().edit) this.model.cancelEdit();
    await this.focusExplorer();
    this.ui.update({ filterOpen: true, filterFocusRequest: this.ui.get().filterFocusRequest + 1 });
  }

  async closeFilter(): Promise<void> {
    this.ui.update({ filterOpen: false });
    await this.model.clearFilter();
  }

  // ---------------------------------------------------------------------------------------
  // Menus

  /** Items of the context menu for the selection (or the empty area when nothing is selected). */
  contextMenuItems(): MenuItem[] {
    const path = this.selectedPath();
    const entry = path === null ? undefined : this.tree.getEntry(path);
    const isFile = entry?.kind === "file";
    const items: MenuItem[] = [];
    if (entry && path !== null) {
      if (isFile) {
        items.push({ id: "open", label: "Open", run: () => this.openFile(path, false), keybinding: "enter" });
        if (this.ctx.commands.get("editor.openExternal")) {
          items.push({
            id: "open-external",
            label: "Open in External Editor",
            command: "editor.openExternal",
            args: { path },
          });
        }
        items.push({ kind: "separator", id: "sep-open" });
      }
    }
    items.push(
      { id: "new-file", label: "New File…", command: "explorer.newFile" },
      { id: "new-folder", label: "New Folder…", command: "explorer.newFolder" },
    );
    if (entry) {
      items.push(
        { kind: "separator", id: "sep-edit" },
        { id: "rename", label: "Rename…", command: "explorer.rename" },
        { id: "delete", label: "Delete", command: "explorer.delete", danger: true },
        { kind: "separator", id: "sep-copy" },
        { id: "copy-path", label: "Copy Path", command: "explorer.copyPath" },
        { id: "copy-relative", label: "Copy Relative Path", command: "explorer.copyRelativePath" },
      );
    } else {
      items.push(
        { kind: "separator", id: "sep-tree" },
        { id: "refresh", label: "Refresh", command: "explorer.refresh" },
        { id: "collapse", label: "Collapse Folders", command: "explorer.collapseAll" },
      );
    }
    items.push(
      { kind: "separator", id: "sep-reveal" },
      {
        id: "reveal",
        label: "Reveal Active File",
        command: "explorer.revealActiveFile",
        disabled: this.activeFilePath() === null,
      },
    );
    return items;
  }

  /** Items of the header's "more" menu. */
  moreMenuItems(): MenuItem[] {
    const { config } = this.ctx;
    const undo = this.model.store.get().undoDescription;
    return [
      { id: "newFolder", label: "New Folder…", command: "explorer.newFolder" },
      { id: "refresh", label: "Refresh Explorer", command: "explorer.refresh" },
      { kind: "separator", id: "sep-actions" },
      {
        id: "hidden",
        label: "Show Hidden Files",
        command: "explorer.toggleHidden",
        checked: config.get("explorer.showHidden"),
      },
      {
        id: "ignored",
        label: "Show Ignored Files",
        command: "explorer.toggleIgnored",
        checked: config.get("explorer.showIgnored"),
      },
      { kind: "separator", id: "sep" },
      {
        id: "undo",
        label: undo ? `Undo: ${truncateMiddle(sanitizeForDisplay(undo), 48)}` : "Undo File Operation",
        command: "explorer.undo",
        disabled: undo === null,
      },
    ];
  }

  /** At the pointer, or below the selected row (keyboard). */
  showContextMenu(at?: ExplorerAnchor): void {
    const anchor = at ?? this.bridge?.selectionAnchor() ?? this.bridge?.headerAnchor() ?? { x: 0, y: 1 };
    this.ctx.menus.show(
      { x: anchor.x, y: anchor.y, items: this.contextMenuItems() },
      { highlightFirst: !at },
    );
  }

  /** Right-aligned under the header's "more" button. */
  showMoreMenu(): void {
    const items = this.moreMenuItems();
    const anchor = this.bridge?.headerAnchor();
    const x = anchor ? Math.max(0, anchor.x - this.menuWidth(items) + 1) : 0;
    this.ctx.menus.show({ x, y: anchor?.y ?? 1, items });
  }
}
