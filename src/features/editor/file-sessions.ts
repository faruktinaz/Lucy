/**
 * The open file tabs' sessions, keyed by tab id. Sessions outlive their view (only the active
 * tab's view is mounted) and end with their tab.
 *
 * Also the glue to the workbench: reveal requests (Quick Open `file:42`, the `:` provider,
 * search results, the diff view) become pending reveals; watcher batches reload the touched
 * files; viewer state is mirrored into the tab's view-state bag so it survives tab switches and,
 * for the fields the workspace state keeps (scroll, cursor), restarts.
 */
import type { AppContext } from "@/app/app-context";
import type { EditorTab } from "@/app/workbench/editors";
import { type Disposable, DisposableStore, toDisposable } from "@/core/events";
import { Store } from "@/core/store";
import { FileSession } from "./file-session";
import { createViewerState, type ViewerState } from "./model";

/** Scroll and cursor writes are coalesced; toggles are written at once (the header reads them). */
const PERSIST_DELAY_MS = 150;

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

/** Viewer state from a tab's view-state bag (restored from disk or kept from an earlier session). */
export function viewerStateFromTab(tab: EditorTab, defaultWrap: boolean): ViewerState {
  const bag = tab.viewState;
  const base = createViewerState({ wrap: defaultWrap });
  return {
    activeLine: count(bag.cursorLine) ?? base.activeLine,
    scrollTop: count(bag.scrollTop) ?? base.scrollTop,
    scrollLeft: count(bag.scrollLeft) ?? base.scrollLeft,
    wrap: typeof bag.wrap === "boolean" ? bag.wrap : base.wrap,
    markdownPreview: typeof bag.markdownPreview === "boolean" ? bag.markdownPreview : base.markdownPreview,
  };
}

export class FileSessions implements Disposable {
  readonly #ctx: AppContext;
  readonly #sessions = new Map<string, { session: FileSession; store: DisposableStore }>();
  readonly #store = new DisposableStore();
  /** Increases when sessions are recreated (a setting that needs a fresh load changed). */
  readonly generation = new Store(0);

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
    this.#store.add(ctx.editors.onDidClose((tab) => this.#drop(tab.id)));
    // A preview tab replaced by the next preview is not "closed": prune by presence instead.
    this.#store.add(
      toDisposable(
        ctx.editors.store.subscribe(() => {
          if (this.#sessions.size === 0) return;
          const ids = new Set(ctx.editors.tabs.map((tab) => tab.id));
          for (const id of [...this.#sessions.keys()]) if (!ids.has(id)) this.#drop(id);
        }),
      ),
    );
    this.#store.add(
      ctx.editors.onDidRequestReveal((request) => {
        const tab = ctx.editors.get(request.tabId);
        if (tab?.kind !== "file") return;
        this.forTab(tab)?.reveal(request.line, request.column);
      }),
    );
    this.#store.add(
      ctx.services.onDidChangeFiles((batch) => {
        if (this.#sessions.size === 0) return;
        const touched = new Set(batch.paths);
        for (const { session } of this.#sessions.values()) {
          if (batch.overflow || touched.has(session.path)) void session.tab.checkForChanges();
        }
      }),
    );
    this.#store.add(
      ctx.config.onDidChange((event) => {
        if (event.changed.includes("editor.maxFileSizeMb")) this.#recreateAll();
        if (event.changed.some((path) => path.startsWith("editor.autosave"))) {
          for (const { session } of this.#sessions.values()) session.edit?.settingsChanged();
        }
      }),
    );
  }

  /** The session of a file tab, created on first use. */
  forTab(tab: EditorTab): FileSession | undefined {
    if (tab.kind !== "file" || !tab.resource) return undefined;
    const existing = this.#sessions.get(tab.id);
    if (existing) return existing.session;
    const session = new FileSession({
      root: this.#ctx.workspace.root,
      path: tab.resource,
      syntax: this.#ctx.services.syntax,
      maxFileSizeMb: this.#ctx.config.get("editor.maxFileSizeMb"),
      viewer: viewerStateFromTab(tab, this.#ctx.config.get("editor.wrap")),
      editing: {
        syntax: this.#ctx.services.syntax,
        tabWidth: () => this.#ctx.config.get("editor.tabWidth"),
        autosave: () => ({
          mode: this.#ctx.config.get("editor.autosave"),
          delayMs: this.#ctx.config.get("editor.autosaveDelayMs"),
        }),
      },
    });
    const store = new DisposableStore();
    store.add(this.#mirrorViewState(tab.id, session));
    store.add(this.#mirrorDirty(tab.id, session));
    store.add(session);
    this.#sessions.set(tab.id, { session, store });
    return session;
  }

  get(tabId: string): FileSession | undefined {
    const tab = this.#ctx.editors.get(tabId);
    return tab ? this.forTab(tab) : undefined;
  }

  /** The session of the active tab when it is a file tab. */
  active(): FileSession | undefined {
    const tab = this.#ctx.editors.active;
    return tab ? this.forTab(tab) : undefined;
  }

  /** Every session with unsaved edits. */
  dirty(): { tabId: string; session: FileSession }[] {
    const out: { tabId: string; session: FileSession }[] = [];
    for (const [tabId, { session }] of this.#sessions)
      if (session.edit?.state.get().dirty) out.push({ tabId, session });
    return out;
  }

  /** Sessions that exist right now (no creation), for status and tests. */
  existing(tabId: string): FileSession | undefined {
    return this.#sessions.get(tabId)?.session;
  }

  dispose(): void {
    this.#store.dispose();
    for (const id of [...this.#sessions.keys()]) this.#drop(id);
  }

  #drop(tabId: string): void {
    const entry = this.#sessions.get(tabId);
    if (!entry) return;
    this.#sessions.delete(tabId);
    entry.store.dispose();
  }

  #recreateAll(): void {
    // Unsaved edits are never dropped for a setting change; those tabs keep their session.
    for (const [id, { session }] of [...this.#sessions]) if (!session.edit?.state.get().dirty) this.#drop(id);
    this.generation.set((value) => value + 1);
  }

  /** The tab's dirty marker follows the buffer (it is created when the file starts editing). */
  #mirrorDirty(tabId: string, session: FileSession): Disposable {
    let off: (() => void) | undefined;
    const attach = () => {
      if (off || !session.edit) return;
      const edit = session.edit;
      let failed = false;
      const sync = () => {
        const state = edit.state.get();
        this.#ctx.editors.setDirty(tabId, state.dirty);
        // A failed save (auto save included) is said once, not on every retry.
        if (state.status === "failed" && !failed) {
          this.#ctx.notifications.show({
            severity: "error",
            title: `Could not save ${session.path.split("/").at(-1) ?? session.path}`,
            message: `${state.error ?? "The file could not be written."} Your changes are still in the editor.`,
            key: `editor.save.${session.path}`,
          });
        }
        failed = state.status === "failed";
      };
      off = edit.state.subscribe(sync);
      sync();
    };
    const offTab = session.tab.state.subscribe(attach);
    attach();
    return toDisposable(() => {
      offTab();
      off?.();
    });
  }

  #mirrorViewState(tabId: string, session: FileSession): Disposable {
    const { editors } = this.#ctx;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = session.tab.viewer.get();
    const write = () => {
      timer = undefined;
      const state = session.tab.viewer.get();
      editors.setViewState(tabId, {
        scrollTop: state.scrollTop,
        scrollLeft: state.scrollLeft,
        cursorLine: state.activeLine,
        cursorColumn: session.ui.get().column,
        wrap: state.wrap,
        markdownPreview: state.markdownPreview,
      });
    };
    const schedule = () => {
      const state = session.tab.viewer.get();
      const toggled = state.wrap !== last.wrap || state.markdownPreview !== last.markdownPreview;
      last = state;
      if (toggled) {
        clearTimeout(timer);
        write();
        return;
      }
      if (timer !== undefined) return;
      timer = setTimeout(write, PERSIST_DELAY_MS);
      (timer as { unref?: () => void }).unref?.();
    };
    const offViewer = session.tab.viewer.subscribe(schedule);
    const offUi = session.ui.subscribe(schedule);
    return toDisposable(() => {
      offViewer();
      offUi();
      if (timer !== undefined) {
        clearTimeout(timer);
        // The last position still counts: a tab switch right after scrolling must keep it.
        if (editors.get(tabId)) write();
      }
    });
  }
}
