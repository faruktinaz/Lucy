/**
 * The one picker, VS Code style. Typed text selects a provider by prefix (`>` commands,
 * `:` go to line, no prefix for files); any feature can register a provider, or show an
 * ad-hoc list with `pick()`. Key handling (arrows, Enter, Escape) lives here, so it is
 * testable without a renderer; the UI only renders `store`.
 */

import { fuzzyMatchPrepared, prepareFuzzyQuery } from "@/adapters/search";
import { errorMessage } from "@/core/errors";
import { type Disposable, toDisposable } from "@/core/events";
import { normalizeKey } from "@/core/keybindings";
import type { KeyStroke } from "@/core/keybindings/key-stroke";
import type { Logger } from "@/core/log";
import { Store } from "@/core/store";
import type { IconName } from "@/themes/icons";
import type { OverlayService } from "./overlays";

export interface QuickPickItem {
  readonly id: string;
  readonly label: string;
  /** Muted text after the label (a folder, a category). */
  readonly description?: string;
  readonly icon?: IconName;
  /** Derive the icon from a file name (file-type icon and color). */
  readonly fileIcon?: string;
  /** A key sequence (`ctrl+k ctrl+t`), formatted and shown on the right. */
  readonly keybinding?: string;
  /** Matched positions in `label` (UTF-16 indices), drawn highlighted. */
  readonly highlights?: readonly number[];
  readonly descriptionHighlights?: readonly number[];
  /** Shown greyed; accepting it does nothing. */
  readonly disabled?: boolean;
  /** Section title shown above the first item of a run with the same group ("recently used"). */
  readonly group?: string;
  /** Marks the current value in a choice list (the active theme). */
  readonly current?: boolean;
}

export interface QuickPickProvider {
  /** ">" for commands, ":" for go to line, "" for files. Longest matching prefix wins. */
  readonly prefix: string;
  readonly title: string;
  readonly placeholder: string;
  /** Items for the text after the prefix. The provider filters and ranks. */
  provideItems(
    query: string,
    signal: AbortSignal,
  ): readonly QuickPickItem[] | Promise<readonly QuickPickItem[]>;
  accept(item: QuickPickItem, query: string): void | Promise<void>;
  /** Shown when there are no items. */
  emptyText?(query: string): string;
}

export interface PickOptions {
  readonly items: readonly QuickPickItem[];
  readonly title?: string;
  readonly placeholder?: string;
  /** Item to select first (defaults to the first one, or the one marked `current`). */
  readonly activeId?: string;
  /** Called whenever the selection moves (live preview). */
  readonly onActive?: (item: QuickPickItem) => void;
  /** Also match the query against descriptions. */
  readonly matchOnDescription?: boolean;
  readonly emptyText?: string;
}

export interface QuickPickState {
  readonly open: boolean;
  readonly mode: "provider" | "pick";
  readonly value: string;
  /** The prefix of the active provider ("" in pick mode). */
  readonly prefix: string;
  readonly title: string;
  readonly placeholder: string;
  readonly items: readonly QuickPickItem[];
  readonly activeIndex: number;
  readonly loading: boolean;
  readonly emptyText: string;
}

const CLOSED: QuickPickState = {
  open: false,
  mode: "provider",
  value: "",
  prefix: "",
  title: "",
  placeholder: "",
  items: [],
  activeIndex: 0,
  loading: false,
  emptyText: "",
};

const PAGE = 10;

/** Fuzzy-filters a static list, filling in highlights. An empty query keeps the order. */
export function filterQuickPickItems(
  items: readonly QuickPickItem[],
  query: string,
  options: { matchOnDescription?: boolean } = {},
): QuickPickItem[] {
  const trimmed = query.trim();
  if (trimmed === "") return items.map((item) => ({ ...item, highlights: undefined }));
  const prepared = prepareFuzzyQuery(trimmed);
  // `tier` 0 = label match, 1 = description match: every label match ranks first, because
  // fuzzy scores carry large basename bonuses that a fixed penalty cannot outweigh.
  const scored: { item: QuickPickItem; tier: number; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const label = fuzzyMatchPrepared(prepared, item.label);
    const description =
      !label && options.matchOnDescription && item.description
        ? fuzzyMatchPrepared(prepared, item.description)
        : null;
    if (label)
      scored.push({
        item: { ...item, highlights: label.positions, group: undefined },
        tier: 0,
        score: label.score,
        index,
      });
    else if (description)
      scored.push({
        item: { ...item, descriptionHighlights: description.positions, group: undefined },
        tier: 1,
        score: description.score,
        index,
      });
  });
  scored.sort((a, b) => a.tier - b.tier || b.score - a.score || a.index - b.index);
  return scored.map((entry) => entry.item);
}

interface PickSession {
  options: PickOptions;
  resolve: (item: QuickPickItem | undefined) => void;
}

export class QuickPickService implements Disposable {
  readonly store = new Store<QuickPickState>(CLOSED);
  private readonly providers: QuickPickProvider[] = [];
  private layer: Disposable | null = null;
  private request: AbortController | null = null;
  private session: PickSession | null = null;
  private generation = 0;

  constructor(
    private readonly overlays: OverlayService,
    private readonly log?: Logger,
    private readonly onError?: (title: string, error: unknown) => void,
  ) {}

  get state(): QuickPickState {
    return this.store.get();
  }

  get isOpen(): boolean {
    return this.state.open;
  }

  registerProvider(provider: QuickPickProvider): Disposable {
    this.providers.push(provider);
    this.providers.sort((a, b) => b.prefix.length - a.prefix.length);
    return toDisposable(() => {
      const index = this.providers.indexOf(provider);
      if (index !== -1) this.providers.splice(index, 1);
    });
  }

  /** Lists the registered prefixes (for the `?` help). */
  listProviders(): readonly QuickPickProvider[] {
    return [...this.providers];
  }

  /** Opens the picker in provider mode with an initial value (`">"` for commands). */
  show(value = ""): void {
    this.endSession(undefined);
    this.store.set({ ...CLOSED, open: true, mode: "provider", value });
    this.ensureLayer();
    this.refresh();
  }

  /** Shows an ad-hoc list; resolves with the accepted item, or undefined on cancel. */
  pick(options: PickOptions): Promise<QuickPickItem | undefined> {
    this.endSession(undefined);
    this.cancelRequest();
    return new Promise((resolve) => {
      this.session = { options, resolve };
      const activeId = options.activeId ?? options.items.find((item) => item.current)?.id;
      const activeIndex = Math.max(
        0,
        options.items.findIndex((item) => item.id === activeId),
      );
      this.store.set({
        ...CLOSED,
        open: true,
        mode: "pick",
        title: options.title ?? "",
        placeholder: options.placeholder ?? "",
        items: options.items,
        activeIndex,
        emptyText: options.emptyText ?? "No matching items",
      });
      this.ensureLayer();
      this.notifyActive();
    });
  }

  /** The input text changed. */
  setValue(value: string): void {
    if (!this.state.open || value === this.state.value) return;
    this.store.set({ ...this.state, value });
    this.refresh();
  }

  setActiveIndex(index: number): void {
    const state = this.state;
    if (state.items.length === 0) return;
    const next = Math.max(0, Math.min(state.items.length - 1, index));
    if (next === state.activeIndex) return;
    this.store.set({ ...state, activeIndex: next });
    this.notifyActive();
  }

  /** Accepts the active item (or the item at `index`). */
  async accept(index = this.state.activeIndex): Promise<void> {
    const state = this.state;
    const item = state.items[index];
    if (!state.open || !item || item.disabled) return;
    if (state.mode === "pick") {
      this.endSession(item);
      this.close();
      return;
    }
    const provider = this.providerFor(state.value);
    const query = state.value.slice(provider?.prefix.length ?? 0).trim();
    this.close();
    if (!provider) return;
    try {
      await provider.accept(item, query);
    } catch (error) {
      this.log?.error("Quick pick action failed", { prefix: provider.prefix, error });
      this.onError?.(`${provider.title}: ${errorMessage(error)}`, error);
    }
  }

  /** Closes the picker; an ad-hoc pick resolves with undefined. */
  close(): void {
    this.endSession(undefined);
    this.cancelRequest();
    if (this.state.open) this.store.set(CLOSED);
    this.layer?.dispose();
    this.layer = null;
  }

  handleKey(stroke: KeyStroke): boolean {
    const state = this.state;
    if (!state.open) return false;
    const key = normalizeKey(stroke.key) ?? stroke.key;
    const plain = !stroke.alt && !stroke.super;
    const ctrl = stroke.ctrl && !stroke.shift;
    if (key === "escape") {
      this.close();
      return true;
    }
    if (key === "enter" && plain) {
      void this.accept();
      return true;
    }
    const count = state.items.length;
    const wrap = (index: number) => (count === 0 ? 0 : (index + count) % count);
    if ((key === "down" && plain && !stroke.ctrl) || (ctrl && key === "n")) {
      this.setActiveIndex(wrap(state.activeIndex + 1));
      return true;
    }
    if ((key === "up" && plain && !stroke.ctrl) || (ctrl && key === "p" && state.mode === "pick")) {
      this.setActiveIndex(wrap(state.activeIndex - 1));
      return true;
    }
    // In provider mode Ctrl+P is the Quick Open chord; pressing it again moves down, like VS Code.
    if (ctrl && key === "p") {
      this.setActiveIndex(wrap(state.activeIndex + 1));
      return true;
    }
    if (key === "pagedown" && plain) {
      this.setActiveIndex(Math.min(count - 1, state.activeIndex + PAGE));
      return true;
    }
    if (key === "pageup" && plain) {
      this.setActiveIndex(Math.max(0, state.activeIndex - PAGE));
      return true;
    }
    if (key === "tab") return true;
    return false;
  }

  private providerFor(value: string): QuickPickProvider | undefined {
    return this.providers.find((provider) => value.startsWith(provider.prefix));
  }

  private refresh(): void {
    const state = this.state;
    if (!state.open) return;
    if (state.mode === "pick") {
      const options = this.session?.options;
      const items = filterQuickPickItems(options?.items ?? [], state.value, options);
      this.store.set({ ...state, items, activeIndex: 0 });
      this.notifyActive();
      return;
    }
    const provider = this.providerFor(state.value);
    this.cancelRequest();
    if (!provider) {
      this.store.set({
        ...state,
        items: [],
        loading: false,
        title: "",
        placeholder: "",
        emptyText: "No results",
      });
      return;
    }
    const query = state.value.slice(provider.prefix.length).trim();
    const controller = new AbortController();
    this.request = controller;
    const generation = ++this.generation;
    const base = {
      ...state,
      prefix: provider.prefix,
      title: provider.title,
      placeholder: provider.placeholder,
      emptyText: provider.emptyText?.(query) ?? "No results",
    };
    let result: readonly QuickPickItem[] | Promise<readonly QuickPickItem[]>;
    try {
      result = provider.provideItems(query, controller.signal);
    } catch (error) {
      this.log?.error("Quick pick provider failed", { prefix: provider.prefix, error });
      this.store.set({
        ...base,
        items: [],
        loading: false,
        emptyText: `Could not list items: ${errorMessage(error)}`,
      });
      return;
    }
    if (!(result instanceof Promise)) {
      this.store.set({ ...base, items: result, activeIndex: 0, loading: false });
      return;
    }
    this.store.set({ ...base, loading: true });
    result.then(
      (items) => {
        if (generation !== this.generation || !this.state.open) return;
        this.store.set({ ...this.state, items, activeIndex: 0, loading: false });
      },
      (error: unknown) => {
        if (generation !== this.generation || !this.state.open || controller.signal.aborted) return;
        this.log?.error("Quick pick provider failed", { prefix: provider.prefix, error });
        this.store.set({
          ...this.state,
          items: [],
          loading: false,
          emptyText: `Could not list items: ${errorMessage(error)}`,
        });
      },
    );
  }

  private notifyActive(): void {
    const options = this.session?.options;
    const item = this.state.items[this.state.activeIndex];
    if (!options?.onActive || !item) return;
    try {
      options.onActive(item);
    } catch (error) {
      this.log?.warn("Quick pick preview failed", { error });
    }
  }

  private ensureLayer(): void {
    if (this.layer) return;
    this.layer = this.overlays.push({
      id: "quickPick",
      modal: true,
      acceptsText: true,
      handleKey: (stroke) => this.handleKey(stroke),
      dismiss: () => this.close(),
    });
  }

  private endSession(item: QuickPickItem | undefined): void {
    const session = this.session;
    this.session = null;
    session?.resolve(item);
  }

  private cancelRequest(): void {
    this.request?.abort();
    this.request = null;
    this.generation++;
  }

  dispose(): void {
    this.close();
    this.providers.length = 0;
  }
}
