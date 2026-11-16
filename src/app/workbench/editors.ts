/**
 * Editor tabs, VS Code style.
 *
 * - A tab is identified by kind + resource + params, so opening the same thing twice
 *   activates the existing tab.
 * - Preview tabs: a single-click open (`preview: true`) reuses one italic preview tab until
 *   the user pins it, edits it (dirty) or opens it "for real" (double-click, Enter).
 * - Back/forward history over activations, and a per-tab view-state bag (scroll, cursor)
 *   that editor views read and write and that is persisted for file and diff tabs.
 */
import { type Disposable, Emitter } from "@/core/events";
import { Store } from "@/core/store";
import type { OpenFileState } from "@/core/workspace";

export type EditorParamValue = string | number | boolean;

export interface EditorInput {
  /** Which editor view renders the tab: "file", "diff", "settings", ... */
  kind: string;
  /** Workspace-relative POSIX path, or another stable resource key. */
  resource?: string;
  /** Extra identity, e.g. `{ staged: true }` for a staged diff. */
  params?: Readonly<Record<string, EditorParamValue>>;
  /** Overrides the provider's title. */
  title?: string;
  /** Secondary text (a folder path), shown muted beside the title when names collide. */
  description?: string;
}

export interface EditorTab {
  readonly id: string;
  readonly key: string;
  readonly kind: string;
  readonly resource?: string;
  readonly params: Readonly<Record<string, EditorParamValue>>;
  readonly title: string;
  readonly description?: string;
  readonly pinned: boolean;
  /** A preview tab is replaced by the next preview open. Shown in italics. */
  readonly preview: boolean;
  /** Unsaved changes; a dirty tab is never replaced and asks before closing. */
  readonly dirty: boolean;
  /** Free-form state owned by the tab's editor view (scroll, cursor, selection). */
  readonly viewState: Readonly<Record<string, unknown>>;
}

export interface EditorsState {
  readonly tabs: readonly EditorTab[];
  readonly activeId: string | null;
}

export interface OpenEditorOptions {
  /** Open as a preview tab (single click). Default false. */
  preview?: boolean;
  /** Activate the tab. Default true. */
  activate?: boolean;
  pinned?: boolean;
  /** Initial view state for a new tab (merged into an existing one). */
  viewState?: Readonly<Record<string, unknown>>;
}

export interface RevealRequest {
  tabId: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column?: number;
}

export interface EditorServiceOptions {
  /** Whether single-click opens reuse a preview tab (`editor.previewTabs`). */
  previewEnabled?: () => boolean;
  /** Title for a new tab when the input has none; defaults to the resource's base name. */
  titleFor?: (input: EditorInput) => string | undefined;
}

const HISTORY_LIMIT = 50;

/** The cursor fields of `WorkspaceState`'s view state, when the editor view recorded them. */
function cursorOf(viewState: Readonly<Record<string, unknown>>): {
  cursorLine?: number;
  cursorColumn?: number;
} {
  const out: { cursorLine?: number; cursorColumn?: number } = {};
  for (const key of ["cursorLine", "cursorColumn"] as const) {
    const value = viewState[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = Math.floor(value);
  }
  return out;
}

function canonicalParams(params: Readonly<Record<string, EditorParamValue>> | undefined): string {
  if (!params) return "";
  return Object.keys(params)
    .sort()
    .map((key) => `${key}=${String(params[key])}`)
    .join("&");
}

/** The dedupe key: kind + resource + params. */
export function editorKey(input: Pick<EditorInput, "kind" | "resource" | "params">): string {
  return `${input.kind}\u0000${input.resource ?? ""}\u0000${canonicalParams(input.params)}`;
}

function baseName(resource: string | undefined): string | undefined {
  if (!resource) return undefined;
  const trimmed = resource.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

export class EditorService implements Disposable {
  readonly store = new Store<EditorsState>({ tabs: [], activeId: null });
  private back: string[] = [];
  private forward: string[] = [];
  private nextId = 1;
  private readonly reveals = new Emitter<RevealRequest>();
  private readonly closings = new Emitter<EditorTab>();
  private readonly previewEnabled: () => boolean;
  private readonly titleFor: (input: EditorInput) => string | undefined;

  constructor(options: EditorServiceOptions = {}) {
    this.previewEnabled = options.previewEnabled ?? (() => true);
    this.titleFor = options.titleFor ?? (() => undefined);
  }

  get state(): EditorsState {
    return this.store.get();
  }

  get tabs(): readonly EditorTab[] {
    return this.state.tabs;
  }

  get active(): EditorTab | undefined {
    const { tabs, activeId } = this.state;
    return tabs.find((tab) => tab.id === activeId);
  }

  get(id: string): EditorTab | undefined {
    return this.state.tabs.find((tab) => tab.id === id);
  }

  find(input: Pick<EditorInput, "kind" | "resource" | "params">): EditorTab | undefined {
    const key = editorKey(input);
    return this.state.tabs.find((tab) => tab.key === key);
  }

  /** Opens (or activates) a tab. See the module comment for the preview rules. */
  open(input: EditorInput, options: OpenEditorOptions = {}): EditorTab {
    const preview = options.preview === true && this.previewEnabled() && options.pinned !== true;
    const activate = options.activate ?? true;
    const existing = this.find(input);
    if (existing) {
      const promote = !preview && existing.preview;
      const pin = options.pinned === true && !existing.pinned;
      if (promote || pin || options.viewState) {
        this.replaceTab(existing.id, {
          ...existing,
          preview: promote || pin ? false : existing.preview,
          pinned: existing.pinned || options.pinned === true,
          viewState: options.viewState ? { ...existing.viewState, ...options.viewState } : existing.viewState,
        });
      }
      if (activate) this.activate(existing.id);
      return this.get(existing.id) ?? existing;
    }

    const tab: EditorTab = {
      id: `tab-${this.nextId++}`,
      key: editorKey(input),
      kind: input.kind,
      resource: input.resource,
      params: input.params ?? {},
      title: input.title ?? this.titleFor(input) ?? baseName(input.resource) ?? input.kind,
      description: input.description,
      pinned: options.pinned === true,
      preview,
      dirty: false,
      viewState: options.viewState ?? {},
    };

    this.store.set((state) => {
      const tabs = [...state.tabs];
      const reusable = preview ? tabs.findIndex((t) => t.preview && !t.dirty && !t.pinned) : -1;
      if (reusable !== -1) {
        const replaced = tabs[reusable];
        tabs[reusable] = tab;
        if (replaced) this.forgetHistory(replaced.id);
      } else {
        const activeIndex = tabs.findIndex((t) => t.id === state.activeId);
        // New tabs open to the right of the active one, as in VS Code.
        tabs.splice(activeIndex === -1 ? tabs.length : activeIndex + 1, 0, tab);
      }
      return { ...state, tabs };
    });
    if (activate || this.state.activeId === null) this.activate(tab.id);
    return tab;
  }

  activate(id: string): void {
    const state = this.state;
    if (!state.tabs.some((tab) => tab.id === id)) return;
    if (state.activeId === id) return;
    if (state.activeId) this.pushHistory(state.activeId);
    this.forward = [];
    this.store.set({ ...state, activeId: id });
  }

  /** Closes a tab. Returns false when it does not exist. Dirty tabs are closed too: ask first. */
  close(id: string): boolean {
    const state = this.state;
    const index = state.tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return false;
    const closing = state.tabs[index];
    const tabs = state.tabs.filter((tab) => tab.id !== id);
    this.forgetHistory(id);
    let activeId = state.activeId;
    if (activeId === id) {
      // Prefer the most recent tab in history, then the right neighbour, then the left one.
      const fromHistory = this.back.at(-1);
      activeId = fromHistory ?? tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
      if (fromHistory) this.back.pop();
    }
    this.store.set({ tabs, activeId });
    if (closing) this.closings.emit(closing);
    return true;
  }

  closeAll(): void {
    for (const tab of [...this.state.tabs]) this.close(tab.id);
  }

  closeOthers(id: string): void {
    for (const tab of [...this.state.tabs]) if (tab.id !== id && !tab.pinned) this.close(tab.id);
  }

  /** Makes a preview tab permanent, or toggles the pinned flag of a permanent one. */
  pin(id: string, pinned = true): void {
    const tab = this.get(id);
    if (!tab) return;
    this.replaceTab(id, { ...tab, pinned, preview: false });
  }

  /** Turns a preview tab into a regular one (double-click on the tab, an edit). */
  keep(id: string): void {
    const tab = this.get(id);
    if (tab?.preview) this.replaceTab(id, { ...tab, preview: false });
  }

  setDirty(id: string, dirty: boolean): void {
    const tab = this.get(id);
    if (!tab || tab.dirty === dirty) return;
    this.replaceTab(id, { ...tab, dirty, preview: dirty ? false : tab.preview });
  }

  setTitle(id: string, title: string, description?: string): void {
    const tab = this.get(id);
    if (!tab || (tab.title === title && tab.description === description)) return;
    this.replaceTab(id, { ...tab, title, description });
  }

  /** Merges into the tab's view-state bag. */
  setViewState(id: string, patch: Readonly<Record<string, unknown>>): void {
    const tab = this.get(id);
    if (!tab) return;
    this.replaceTab(id, { ...tab, viewState: { ...tab.viewState, ...patch } });
  }

  /** Asks the tab's editor view to scroll to a position (`:` in the quick pick, search results). */
  reveal(request: RevealRequest): void {
    this.reveals.emit(request);
  }

  onDidRequestReveal(listener: (request: RevealRequest) => void): Disposable {
    return this.reveals.on(listener);
  }

  onDidClose(listener: (tab: EditorTab) => void): Disposable {
    return this.closings.on(listener);
  }

  /** Activates the tab to the right (wrapping). */
  next(): void {
    this.step(1);
  }

  previous(): void {
    this.step(-1);
  }

  private step(delta: 1 | -1): void {
    const { tabs, activeId } = this.state;
    if (tabs.length === 0) return;
    const index = tabs.findIndex((tab) => tab.id === activeId);
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (next) this.activate(next.id);
  }

  get canGoBack(): boolean {
    return this.back.length > 0;
  }

  get canGoForward(): boolean {
    return this.forward.length > 0;
  }

  goBack(): void {
    const target = this.back.pop();
    const current = this.state.activeId;
    if (!target) return;
    if (current) this.forward.push(current);
    this.store.set({ ...this.state, activeId: target });
  }

  goForward(): void {
    const target = this.forward.pop();
    const current = this.state.activeId;
    if (!target) return;
    if (current) this.pushHistory(current);
    this.store.set({ ...this.state, activeId: target });
  }

  /** File and diff tabs in a form `WorkspaceState.openFiles` accepts. */
  toPersisted(): { openFiles: OpenFileState[]; activeFile: string | null } {
    const openFiles: OpenFileState[] = [];
    for (const tab of this.state.tabs) {
      if ((tab.kind !== "file" && tab.kind !== "diff") || !tab.resource || tab.preview) continue;
      const scrollTop =
        typeof tab.viewState.scrollTop === "number" ? Math.max(0, Math.floor(tab.viewState.scrollTop)) : 0;
      openFiles.push({
        path: tab.resource,
        kind: tab.kind,
        pinned: tab.pinned,
        staged: tab.kind === "diff" ? tab.params.staged === true : undefined,
        viewState: { scrollTop, ...cursorOf(tab.viewState) },
      });
    }
    const active = this.active;
    return {
      openFiles,
      activeFile:
        active?.resource && (active.kind === "file" || active.kind === "diff") ? active.resource : null,
    };
  }

  /** Reopens persisted tabs (without activating history). */
  restore(openFiles: readonly OpenFileState[], activeFile: string | null): void {
    for (const file of openFiles) {
      this.open(
        {
          kind: file.kind,
          resource: file.path,
          params: file.kind === "diff" && file.staged ? { staged: true } : undefined,
        },
        {
          activate: false,
          pinned: file.pinned,
          viewState: file.viewState ? { ...file.viewState } : undefined,
        },
      );
    }
    const target =
      this.state.tabs.find((tab) => tab.resource === activeFile && tab.kind === "file") ??
      this.state.tabs.find((tab) => tab.resource === activeFile) ??
      this.state.tabs[0];
    if (target) this.store.set({ ...this.state, activeId: target.id });
    this.back = [];
    this.forward = [];
  }

  private replaceTab(id: string, next: EditorTab): void {
    this.store.set((state) => ({ ...state, tabs: state.tabs.map((tab) => (tab.id === id ? next : tab)) }));
  }

  private pushHistory(id: string): void {
    this.back = [...this.back.filter((existing) => existing !== id), id].slice(-HISTORY_LIMIT);
  }

  private forgetHistory(id: string): void {
    this.back = this.back.filter((existing) => existing !== id);
    this.forward = this.forward.filter((existing) => existing !== id);
  }

  dispose(): void {
    this.reveals.dispose();
    this.closings.dispose();
  }
}
