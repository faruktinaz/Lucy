/**
 * Everything the Search view does that is not drawing: it owns the `SearchViewModel`, the
 * focus inside the view (pattern field, the two glob fields, the results), the recent-query
 * recall in the empty field, opening matches through the editors service, and the restore
 * state. The view component renders `model.store` and `ui`, and forwards keys here, so the
 * behaviour is testable without a renderer.
 */
import type { AppContext } from "@/app/app-context";
import { errorMessage } from "@/core/errors";
import { type Disposable, DisposableStore, toDisposable } from "@/core/events";
import { type KeyStroke, normalizeKey } from "@/core/keybindings";
import { Store } from "@/core/store";
import { type SearchBackend, type SearchOpenIntent, SearchViewModel, type SearchViewState } from "./model";
import { decodeSearchSnapshot, encodeSearchSnapshot } from "./search-persistence";

/** Where keyboard focus is inside the Search view. */
export type SearchFocusTarget = "pattern" | "include" | "exclude" | "results";

export interface SearchUiState {
  readonly focus: SearchFocusTarget;
  /** The "files to include / exclude" fields are shown. */
  readonly detailsOpen: boolean;
  /** The user stopped the last search (Escape); its partial results are still listed. */
  readonly stopped: boolean;
  /** Searches started this session; the ripgrep hint is shown until the second one. */
  readonly runs: number;
}

/** Something the view can focus: the renderable behind a text field. */
export interface FocusableField {
  focus(): void;
  blur(): void;
}

export interface SearchControllerOptions {
  readonly backend: SearchBackend;
  readonly debounceMs?: number;
  readonly flushIntervalMs?: number;
}

const SEARCH_VIEW = "search";

export class SearchController implements Disposable {
  readonly model: SearchViewModel;
  readonly ui = new Store<SearchUiState>({ focus: "pattern", detailsOpen: false, stopped: false, runs: 0 });
  private readonly disposables = new DisposableStore();
  private readonly fields = new Map<Exclude<SearchFocusTarget, "results">, FocusableField>();
  /** Index into the recent queries while recalling them with Up/Down, -1 otherwise. */
  private historyIndex = -1;
  /** What the field held before recalling started (restored by Down past the newest). */
  private historyDraft = "";
  private restored = false;
  private lastWritten = "";
  private engineChecked = false;
  private firstPainted = false;

  constructor(
    private readonly ctx: AppContext,
    options: SearchControllerOptions,
  ) {
    this.model = new SearchViewModel({
      search: options.backend,
      iconTier: ctx.themes.current.icons,
      debounceMs: options.debounceMs,
      flushIntervalMs: options.flushIntervalMs,
      onOpen: (intent) => this.open(intent, "preview"),
    });
    this.disposables.add(this.model);
    this.disposables.add(ctx.themes.onDidChange((theme) => this.model.setIconTier(theme.icons)));

    let previous = this.model.store.get();
    this.disposables.add(
      toDisposable(
        this.model.store.subscribe(() => {
          const next = this.model.store.get();
          this.onModelChange(previous, next);
          previous = next;
        }),
      ),
    );

    // Features activate before the workspace state is loaded, so the restore happens when the
    // persisted store first carries a search slice. Restoring never starts a search.
    const restore = (): void => this.restoreFromPersisted();
    this.disposables.add(toDisposable(ctx.persisted.store.subscribe(restore)));
    restore();

    void ctx.lifecycle.firstPaint.then(() => {
      this.firstPainted = true;
      if (this.isVisible()) this.checkEngine();
    });
  }

  dispose(): void {
    this.disposables.dispose();
    this.fields.clear();
  }

  get state(): SearchViewState {
    return this.model.store.get();
  }

  // ------------------------------------------------------------------------------- focus

  /** The view registers each text field it renders, so focus can be moved between them. */
  registerField(target: Exclude<SearchFocusTarget, "results">, field: FocusableField): Disposable {
    this.fields.set(target, field);
    return toDisposable(() => {
      if (this.fields.get(target) === field) this.fields.delete(target);
    });
  }

  /** The zone's focus target: gives renderable focus to the field that should have it. */
  readonly focusTarget = {
    focus: (): void => this.applyRenderableFocus(),
  };

  setFocus(target: SearchFocusTarget): void {
    if ((target === "include" || target === "exclude") && !this.ui.get().detailsOpen) {
      this.ui.update({ detailsOpen: true });
    }
    if (target === "results" && this.state.rowCount === 0) target = "pattern";
    if (target === "results" && this.state.selectedIndex === -1) this.model.selectIndex(0);
    this.ui.update({ focus: target });
    if (this.zoneHasFocus()) this.applyRenderableFocus();
  }

  /** Shows the view and puts the cursor in the pattern field (`view.showSearch`). */
  focusPattern(): void {
    this.setFocus("pattern");
  }

  private applyRenderableFocus(): void {
    const target = this.ui.get().focus;
    if (target === "results") {
      for (const field of this.fields.values()) field.blur();
      return;
    }
    this.fields.get(target)?.focus();
  }

  private zoneHasFocus(): boolean {
    return this.ctx.focus.current === "sidebar" && this.isVisible();
  }

  isVisible(): boolean {
    return this.ctx.contextKeys.get("sidebarView") === SEARCH_VIEW;
  }

  /** Called when the view becomes visible: detects the engine once (after the first frame). */
  onVisible(): void {
    if (this.firstPainted) this.checkEngine();
  }

  private checkEngine(): void {
    if (this.engineChecked) return;
    this.engineChecked = true;
    this.model.detectEngine().catch((error: unknown) => {
      // Not fatal: the engine is reported after the first search instead.
      this.ctx.log.warn("Detecting the search engine failed", { error });
    });
  }

  // ------------------------------------------------------------------------------- query

  setPattern(pattern: string): void {
    if (this.historyIndex !== -1 && pattern !== this.state.recentQueries[this.historyIndex]) {
      this.historyIndex = -1;
    }
    this.model.setPattern(pattern);
  }

  setInclude(include: string): void {
    this.model.setQuery({ include });
  }

  setExclude(exclude: string): void {
    this.model.setQuery({ exclude });
  }

  toggleMatchCase(): void {
    this.model.setQuery({ caseMode: this.state.query.caseMode === "sensitive" ? "smart" : "sensitive" });
  }

  toggleWholeWord(): void {
    this.model.toggleWholeWord();
  }

  toggleRegex(): void {
    this.model.toggleRegex();
  }

  toggleDetails(): void {
    const open = !this.ui.get().detailsOpen;
    this.ui.update({ detailsOpen: open });
    const focus = this.ui.get().focus;
    if (!open && (focus === "include" || focus === "exclude")) this.setFocus("pattern");
  }

  /**
   * Turns off match case and whole word and clears the globs (the "no results" state offers
   * this). The regular-expression toggle stays: it changes what the pattern means.
   */
  resetFilters(): void {
    this.model.setQuery({ caseMode: "smart", wholeWord: false, include: "", exclude: "" });
  }

  /** Searches now (Enter, Refresh). Returns false when there is nothing to search for. */
  runNow(): boolean {
    if (this.state.query.pattern === "") return false;
    this.historyIndex = -1;
    void this.model.run();
    return true;
  }

  /** Stops the running search, keeping what arrived (Escape). */
  stop(): boolean {
    if (this.state.status !== "searching") return false;
    this.ui.update({ stopped: true });
    this.model.cancel();
    return true;
  }

  clear(): void {
    this.historyIndex = -1;
    this.model.clear();
    this.ui.update({ stopped: false });
  }

  // ------------------------------------------------------------------------------- opening

  /** Opens a match in the file viewer at its line and column. */
  open(intent: SearchOpenIntent, mode: "preview" | "keep"): void {
    const { editors } = this.ctx;
    const tab = editors.open({ kind: "file", resource: intent.path }, { preview: mode === "preview" });
    editors.reveal({ tabId: tab.id, line: intent.line, column: intent.column });
    // A narrow drawer covers the editor: close it so the match is actually visible.
    if (this.ctx.layout.effective.get().mode === "narrow") this.ctx.focus.focus("editor");
  }

  /** F4 / Shift+F4: selects and opens the next or previous match across files. */
  step(direction: 1 | -1): boolean {
    const match = direction > 0 ? this.model.nextMatch() : this.model.previousMatch();
    if (!match) return false;
    this.open({ path: match.path, line: match.line, column: match.column }, "preview");
    return true;
  }

  /** Selects a row with the pointer (a click beside its content, a right click). */
  selectRow(index: number): void {
    this.model.selectIndex(index);
    this.ui.update({ focus: "results" });
    if (this.zoneHasFocus()) this.applyRenderableFocus();
  }

  /** A click on a row: select it; open a match as a preview, toggle a file. */
  clickRow(index: number): void {
    this.selectRow(index);
    const row = this.model.getRow(index);
    if (!row) return;
    if (row.type === "file") this.model.toggleFile(row.path);
    else this.open(row, "preview");
  }

  /** A double-click on a match row keeps its tab open. */
  doubleClickRow(index: number): void {
    const row = this.model.getRow(index);
    if (row?.type === "match") this.open(row, "keep");
  }

  // ------------------------------------------------------------------------------- keys

  /** Keys while the view's zone is focused; `pageSize` is the visible result rows. */
  handleKey(stroke: KeyStroke, pageSize: number): boolean {
    if (stroke.ctrl || stroke.alt || stroke.super) return false;
    const key = normalizeKey(stroke.key) ?? stroke.key;
    const focus = this.ui.get().focus;
    if (key === "tab") {
      this.cycleFocus(stroke.shift ? -1 : 1);
      return true;
    }
    if (focus === "results") return this.handleResultsKey(key, pageSize);
    return this.handleFieldKey(focus, key);
  }

  private focusOrder(): SearchFocusTarget[] {
    const order: SearchFocusTarget[] = ["pattern"];
    if (this.ui.get().detailsOpen) order.push("include", "exclude");
    if (this.state.rowCount > 0) order.push("results");
    return order;
  }

  private cycleFocus(direction: 1 | -1): void {
    const order = this.focusOrder();
    const index = order.indexOf(this.ui.get().focus);
    const next = order[(index + direction + order.length) % order.length] ?? "pattern";
    this.setFocus(next);
  }

  private handleFieldKey(focus: Exclude<SearchFocusTarget, "results">, key: string): boolean {
    switch (key) {
      case "enter":
        this.runNow();
        return true;
      case "escape":
        if (this.stop()) return true;
        if (this.ctx.layout.effective.get().mode === "narrow") {
          // The workbench's own Escape handler does not see keys typed into a field.
          this.ctx.focus.focus("editor");
          return true;
        }
        return false;
      case "down":
        if (focus === "pattern" && this.historyIndex !== -1) {
          this.recall(this.historyIndex - 1);
          return true;
        }
        if (focus === "include") {
          this.setFocus("exclude");
          return true;
        }
        if (this.state.rowCount > 0) {
          this.setFocus("results");
          return true;
        }
        return focus === "exclude";
      case "up":
        if (focus === "exclude") {
          this.setFocus("include");
          return true;
        }
        if (focus === "include") {
          this.setFocus("pattern");
          return true;
        }
        if (this.historyIndex !== -1 || this.state.query.pattern === "") {
          this.recall(this.historyIndex + 1);
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  /** Recalls recent query `index` (0 = newest); -1 goes back to what was typed before. */
  private recall(index: number): void {
    const recent = this.state.recentQueries;
    if (index >= recent.length) return;
    if (this.historyIndex === -1) this.historyDraft = this.state.query.pattern;
    if (index < 0) {
      this.historyIndex = -1;
      this.model.setPattern(this.historyDraft);
      return;
    }
    this.historyIndex = index;
    // biome-ignore lint/correctness/useHookAtTopLevel: a view-model method, not a React hook.
    this.model.useRecentQuery(index);
  }

  private handleResultsKey(key: string, pageSize: number): boolean {
    const model = this.model;
    switch (key) {
      case "up":
      case "k":
        if (this.state.selectedIndex <= 0) this.setFocus("pattern");
        else model.moveUp();
        return true;
      case "down":
      case "j":
        model.moveDown();
        return true;
      case "pageup":
        model.pageUp(pageSize);
        return true;
      case "pagedown":
        model.pageDown(pageSize);
        return true;
      case "home":
        model.home();
        return true;
      case "end":
        model.end();
        return true;
      case "left":
        model.left();
        return true;
      case "right":
        model.right();
        return true;
      case "enter":
      case "space":
        model.enter();
        return true;
      case "escape":
        this.setFocus("pattern");
        return true;
      default:
        return false;
    }
  }

  // ------------------------------------------------------------------------------- state

  private onModelChange(previous: SearchViewState, next: SearchViewState): void {
    if (next.status === "searching" && previous.status !== "searching") {
      this.ui.update({ stopped: false, runs: this.ui.get().runs + 1 });
    }
    // Focus cannot stay on a results list that went away (cleared, new query).
    if (next.rowCount === 0 && this.ui.get().focus === "results") this.setFocus("pattern");
    if (next.query !== previous.query || next.recentQueries !== previous.recentQueries) this.persist();
  }

  private persist(): void {
    const encoded = encodeSearchSnapshot(this.model.exportSnapshot());
    if (encoded === this.lastWritten) return;
    this.lastWritten = encoded;
    this.restored = true;
    if (this.ctx.persisted.state.search.query !== encoded) {
      this.ctx.persisted.update({ search: { query: encoded } });
    }
  }

  private restoreFromPersisted(): void {
    if (this.restored) return;
    const text = this.ctx.persisted.state.search.query;
    if (text === "" || text === this.lastWritten) return;
    this.restored = true;
    try {
      const snapshot = decodeSearchSnapshot(text);
      this.lastWritten = text;
      this.model.restoreSnapshot(snapshot);
      if (snapshot.query.include !== "" || snapshot.query.exclude !== "")
        this.ui.update({ detailsOpen: true });
    } catch (error) {
      this.ctx.log.warn("Restoring the search query failed", { error: errorMessage(error) });
    }
  }
}
