/**
 * Panel visibility and sizes. The service stores what the user asked for; `effective` is
 * what fits on the current screen (see `layout-compute.ts`). Persisted per workspace.
 */
import type { Disposable } from "@/core/events";
import { Store } from "@/core/store";
import type { WorkspaceLayoutState } from "@/core/workspace";
import {
  bottomHeightBounds,
  clamp,
  computeEffectiveLayout,
  type EffectiveLayout,
  type FocusZone,
  LAYOUT_LIMITS,
  type LayoutDefaults,
  type LayoutState,
  type ResizablePart,
  type SidePart,
  sideWidthBounds,
  type Viewport,
} from "./layout-compute";
import { derived, type Readable } from "./readable";

/** The sidebar views a workspace state file may name. */
const PERSISTED_SIDEBAR_VIEWS = ["explorer", "search", "scm"] as const;
type PersistedSidebarView = (typeof PERSISTED_SIDEBAR_VIEWS)[number];

export const DEFAULT_SIDEBAR_VIEW = "explorer";

export function defaultLayoutState(): LayoutState {
  return {
    sidebar: { visible: true, view: DEFAULT_SIDEBAR_VIEW, width: null },
    auxiliary: { visible: false, view: null, width: null },
    bottom: { visible: false, tab: null, height: null, maximized: false },
    zen: false,
    lastSide: "sidebar",
  };
}

export interface LayoutServiceOptions {
  defaults: Readable<LayoutDefaults>;
  focusedZone: Readable<FocusZone>;
  /** Whether any auxiliary view is registered. */
  hasAuxiliaryView: Readable<boolean>;
  viewport?: Viewport;
}

export class LayoutService implements Disposable {
  readonly store = new Store<LayoutState>(defaultLayoutState());
  readonly viewport: Store<Viewport>;
  /** What actually fits on screen right now. */
  readonly effective: Readable<EffectiveLayout>;
  private readonly defaults: Readable<LayoutDefaults>;

  constructor(options: LayoutServiceOptions) {
    this.defaults = options.defaults;
    this.viewport = new Store<Viewport>(options.viewport ?? { width: 120, height: 35 });
    this.effective = derived(
      [this.store, this.viewport, options.defaults, options.focusedZone, options.hasAuxiliaryView] as const,
      (state, viewport, defaults, focusedZone, hasAuxiliaryView) =>
        computeEffectiveLayout({ state, viewport, defaults, focusedZone, hasAuxiliaryView }),
    );
  }

  get state(): LayoutState {
    return this.store.get();
  }

  setViewport(width: number, height: number): void {
    const current = this.viewport.get();
    if (current.width === width && current.height === height) return;
    this.viewport.set({ width, height });
  }

  // ------------------------------------------------------------------ sidebar

  setSidebarVisible(visible: boolean): void {
    this.store.set((s) => ({
      ...s,
      zen: visible ? false : s.zen,
      sidebar: { ...s.sidebar, visible },
      lastSide: visible ? "sidebar" : s.lastSide,
    }));
  }

  toggleSidebar(): void {
    this.setSidebarVisible(!this.state.sidebar.visible);
  }

  /** Shows the sidebar with `view` selected. */
  showSidebarView(view: string): void {
    this.store.set((s) => ({
      ...s,
      zen: false,
      sidebar: { ...s.sidebar, visible: true, view },
      lastSide: "sidebar",
    }));
  }

  setSidebarWidth(width: number): void {
    const bounds = sideWidthBounds("sidebar", this.viewport.get().width);
    const next = clamp(width, bounds.min, bounds.max);
    this.store.set((s) => (s.sidebar.width === next ? s : { ...s, sidebar: { ...s.sidebar, width: next } }));
  }

  // ---------------------------------------------------------------- auxiliary

  setAuxiliaryVisible(visible: boolean): void {
    this.store.set((s) => ({
      ...s,
      zen: visible ? false : s.zen,
      auxiliary: { ...s.auxiliary, visible },
      lastSide: visible ? "auxiliary" : s.lastSide,
    }));
  }

  toggleAuxiliary(): void {
    this.setAuxiliaryVisible(!this.state.auxiliary.visible);
  }

  showAuxiliaryView(view: string): void {
    this.store.set((s) => ({
      ...s,
      zen: false,
      auxiliary: { ...s.auxiliary, visible: true, view },
      lastSide: "auxiliary",
    }));
  }

  setAuxiliaryWidth(width: number): void {
    const bounds = sideWidthBounds("auxiliary", this.viewport.get().width);
    const next = clamp(width, bounds.min, bounds.max);
    this.store.set((s) =>
      s.auxiliary.width === next ? s : { ...s, auxiliary: { ...s.auxiliary, width: next } },
    );
  }

  /** Remembers which side region the user worked in last (it wins when only one fits). */
  noteSide(side: SidePart): void {
    this.store.set((s) => (s.lastSide === side ? s : { ...s, lastSide: side }));
  }

  // ------------------------------------------------------------------- bottom

  setBottomVisible(visible: boolean): void {
    this.store.set((s) => ({
      ...s,
      zen: visible ? false : s.zen,
      bottom: { ...s.bottom, visible, maximized: visible ? s.bottom.maximized : false },
    }));
  }

  toggleBottom(): void {
    this.setBottomVisible(!this.state.bottom.visible);
  }

  showBottomTab(tab: string): void {
    this.store.set((s) => ({ ...s, zen: false, bottom: { ...s.bottom, visible: true, tab } }));
  }

  setBottomHeight(height: number): void {
    const effective = this.effective.get();
    const content = effective.height - (effective.commandBar ? 1 : 0) - (effective.statusBar ? 1 : 0);
    const bounds = bottomHeightBounds(content);
    const next = clamp(height, bounds.min, bounds.max);
    this.store.set((s) => (s.bottom.height === next ? s : { ...s, bottom: { ...s.bottom, height: next } }));
  }

  toggleBottomMaximized(): void {
    this.store.set((s) => ({ ...s, bottom: { ...s.bottom, visible: true, maximized: !s.bottom.maximized } }));
  }

  // --------------------------------------------------------------------- misc

  setZen(zen: boolean): void {
    this.store.set((s) => (s.zen === zen ? s : { ...s, zen }));
  }

  toggleZen(): void {
    this.setZen(!this.state.zen);
  }

  /** Grows (positive) or shrinks (negative) a panel by `delta` cells, within its limits. */
  resize(part: ResizablePart, delta: number): void {
    const effective = this.effective.get();
    if (part === "sidebar") this.setSidebarWidth(effective.sidebar.width + delta);
    else if (part === "auxiliary") this.setAuxiliaryWidth(effective.auxiliary.width + delta);
    else this.setBottomHeight(effective.bottom.height + delta);
  }

  /** Restores default sizes and visibility, keeping the selected views. */
  reset(): void {
    const s = this.state;
    const fresh = defaultLayoutState();
    this.store.set({
      ...fresh,
      sidebar: { ...fresh.sidebar, view: s.sidebar.view },
      auxiliary: { ...fresh.auxiliary, view: s.auxiliary.view },
      bottom: { ...fresh.bottom, tab: s.bottom.tab },
    });
  }

  // -------------------------------------------------------------- persistence

  toPersisted(): WorkspaceLayoutState {
    const s = this.state;
    const view: PersistedSidebarView = (PERSISTED_SIDEBAR_VIEWS as readonly string[]).includes(s.sidebar.view)
      ? (s.sidebar.view as PersistedSidebarView)
      : "explorer";
    return {
      sidebar: { visible: s.sidebar.visible, view, width: s.sidebar.width },
      aiPanel: { visible: s.auxiliary.visible, width: s.auxiliary.width },
      bottomPanel: { visible: s.bottom.visible, height: s.bottom.height, tab: s.bottom.tab ?? "terminal" },
      zen: s.zen,
    };
  }

  restore(saved: WorkspaceLayoutState): void {
    const clampOrNull = (value: number | null, min: number, max: number) =>
      value === null ? null : clamp(value, min, max);
    this.store.set((s) => ({
      ...s,
      sidebar: {
        visible: saved.sidebar.visible,
        view: saved.sidebar.view,
        width: clampOrNull(saved.sidebar.width, LAYOUT_LIMITS.sidebar.min, LAYOUT_LIMITS.sidebar.max),
      },
      auxiliary: {
        ...s.auxiliary,
        visible: saved.aiPanel.visible,
        width: clampOrNull(saved.aiPanel.width, LAYOUT_LIMITS.auxiliary.min, LAYOUT_LIMITS.auxiliary.max),
      },
      bottom: {
        ...s.bottom,
        visible: saved.bottomPanel.visible,
        tab: saved.bottomPanel.tab,
        height: clampOrNull(saved.bottomPanel.height, LAYOUT_LIMITS.bottom.min, LAYOUT_LIMITS.bottom.max),
      },
      zen: saved.zen,
    }));
  }

  /** The configured defaults currently in effect. */
  get configured(): LayoutDefaults {
    return this.defaults.get();
  }

  dispose(): void {}
}
