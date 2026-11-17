/**
 * The responsive layout rules as one pure function, so they can be tested without a renderer
 * and every part of the shell reads the same answer.
 *
 * What the user asked for (`LayoutState`) and what fits on screen (`EffectiveLayout`) are kept
 * apart: a sidebar hidden because the terminal is narrow comes back by itself when the
 * terminal grows, because the request was never changed.
 */

export type FocusZone = "sidebar" | "editor" | "auxiliary" | "bottom";
export type SidePart = "sidebar" | "auxiliary";
export type ResizablePart = "sidebar" | "auxiliary" | "bottom";

export interface LayoutState {
  sidebar: { visible: boolean; view: string; width: number | null };
  auxiliary: { visible: boolean; view: string | null; width: number | null };
  bottom: { visible: boolean; tab: string | null; height: number | null; maximized: boolean };
  zen: boolean;
  /** The side region opened or focused most recently; it wins when only one side fits. */
  lastSide: SidePart;
}

/** Values from the configuration that the layout depends on. */
export interface LayoutDefaults {
  sidebarWidth: number;
  auxiliaryWidth: number;
  bottomHeight: number;
  sidebarSide: "left" | "right";
  showCommandBar: boolean;
  showStatusBar: boolean;
  showActivityBar: boolean;
}

export interface Viewport {
  width: number;
  height: number;
}

export type LayoutMode = "wide" | "medium" | "narrow";

export interface EffectiveLayout {
  readonly width: number;
  readonly height: number;
  /** Below the minimum size the shell shows a "terminal too small" screen instead. */
  readonly tooSmall: boolean;
  readonly mode: LayoutMode;
  readonly zen: boolean;
  readonly sidebarSide: "left" | "right";
  readonly commandBar: boolean;
  /** Below 80 columns the search pill collapses to an icon. */
  readonly compactCommandBar: boolean;
  readonly statusBar: boolean;
  /**
   * Kept for compatibility: there is no separate activity bar any more (views are switched
   * in the sidebar card's header), so it is always hidden with width 0.
   */
  readonly activityBar: { readonly visible: boolean; readonly width: number };
  /** Columns of canvas between the window edge and the cards, and between cards. */
  readonly gap: number;
  /** `layout.showActivityBar`: show the view switcher in the sidebar header. */
  readonly viewSwitcher: boolean;
  readonly sidebar: { readonly visible: boolean; readonly width: number; readonly drawer: boolean };
  readonly auxiliary: { readonly visible: boolean; readonly width: number; readonly drawer: boolean };
  readonly bottom: { readonly visible: boolean; readonly height: number; readonly maximized: boolean };
  readonly editor: { readonly visible: boolean };
}

/** Canvas columns between cards and at the window edges. */
export const CARD_GAP = 1;

export const LAYOUT_LIMITS = {
  minViewport: { width: 60, height: 16 },
  /** At this width and above sidebar, editor and auxiliary panel can coexist. */
  wideWidth: 110,
  /** Below this width side regions open as a drawer in place of the editor. */
  narrowWidth: 80,
  /** Below this height the bottom panel is maximized or hidden and the command bar hides. */
  shortHeight: 24,
  activityBarWidth: 4,
  sidebar: { min: 16, max: 80 },
  auxiliary: { min: 30, max: 200 },
  bottom: { min: 4, max: 60 },
  editorMinWidth: 40,
  editorMinRows: 6,
} as const;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** The width limits a side region can be dragged to, for a viewport. */
export function sideWidthBounds(part: SidePart, viewportWidth: number): { min: number; max: number } {
  const limits = LAYOUT_LIMITS[part];
  const share = part === "sidebar" ? 0.4 : 0.4;
  const max = Math.max(limits.min, Math.min(limits.max, Math.floor(viewportWidth * share)));
  return { min: limits.min, max };
}

/** The height limits of the bottom panel for a content area of `contentHeight` rows. */
export function bottomHeightBounds(contentHeight: number): { min: number; max: number } {
  const { min, max } = LAYOUT_LIMITS.bottom;
  return { min, max: Math.max(min, Math.min(max, contentHeight - LAYOUT_LIMITS.editorMinRows)) };
}

export interface ComputeLayoutInput {
  state: LayoutState;
  viewport: Viewport;
  defaults: LayoutDefaults;
  focusedZone: FocusZone;
  /** Whether any auxiliary view is registered; an empty panel is never shown. */
  hasAuxiliaryView: boolean;
}

export function computeEffectiveLayout(input: ComputeLayoutInput): EffectiveLayout {
  const { state, viewport, defaults, focusedZone } = input;
  const { width, height } = viewport;
  const limits = LAYOUT_LIMITS;
  const tooSmall = width < limits.minViewport.width || height < limits.minViewport.height;
  const mode: LayoutMode =
    width >= limits.wideWidth ? "wide" : width >= limits.narrowWidth ? "medium" : "narrow";
  const short = height < limits.shortHeight;
  const zen = state.zen;

  const commandBar = defaults.showCommandBar && !zen && !short;
  const statusBar = defaults.showStatusBar && !zen;
  // Island layout: cards float on the canvas with one column between them and at the edges.
  const gap = CARD_GAP;
  const available = width - 2 * gap;

  const wantsSidebar = state.sidebar.visible && !zen;
  const wantsAuxiliary = state.auxiliary.visible && input.hasAuxiliaryView && !zen;
  const preferredSide: SidePart =
    focusedZone === "sidebar" || focusedZone === "auxiliary" ? focusedZone : state.lastSide;

  const sidebarBounds = sideWidthBounds("sidebar", width);
  const auxiliaryBounds = sideWidthBounds("auxiliary", width);
  let sidebarWidth = clamp(
    state.sidebar.width ?? defaults.sidebarWidth,
    sidebarBounds.min,
    sidebarBounds.max,
  );
  let auxiliaryWidth = clamp(
    state.auxiliary.width ?? defaults.auxiliaryWidth,
    auxiliaryBounds.min,
    auxiliaryBounds.max,
  );

  let showSidebar = wantsSidebar;
  let showAuxiliary = wantsAuxiliary;
  let drawer: SidePart | null = null;

  if (mode === "narrow") {
    // A drawer follows focus: it is open while the user works in it and closes when focus
    // returns to the editor, so the editor is never lost behind a panel.
    showSidebar = false;
    showAuxiliary = false;
    if (focusedZone === "sidebar" && wantsSidebar) drawer = "sidebar";
    if (focusedZone === "auxiliary" && wantsAuxiliary) drawer = "auxiliary";
    if (drawer === "sidebar") {
      showSidebar = true;
      sidebarWidth = available;
    }
    if (drawer === "auxiliary") {
      showAuxiliary = true;
      auxiliaryWidth = available;
    }
  } else {
    if (mode === "medium" && showSidebar && showAuxiliary) {
      if (preferredSide === "sidebar") showAuxiliary = false;
      else showSidebar = false;
    }
    // The editor stays the widest region on wide screens.
    const editorMin = Math.max(limits.editorMinWidth, Math.floor(width * 0.4));
    let over =
      (showSidebar ? sidebarWidth + gap : 0) +
      (showAuxiliary ? auxiliaryWidth + gap : 0) +
      editorMin -
      available;
    if (over > 0 && showAuxiliary) {
      const take = Math.min(over, auxiliaryWidth - auxiliaryBounds.min);
      auxiliaryWidth -= take;
      over -= take;
    }
    if (over > 0 && showSidebar) {
      const take = Math.min(over, sidebarWidth - sidebarBounds.min);
      sidebarWidth -= take;
      over -= take;
    }
    if (over > 0 && showSidebar && showAuxiliary) {
      if (preferredSide === "sidebar") showAuxiliary = false;
      else showSidebar = false;
    }
  }

  const contentHeight = height - (commandBar ? 1 : 0) - (statusBar ? 1 : 0);
  const bounds = bottomHeightBounds(contentHeight);
  const wantsBottom = state.bottom.visible && !zen && drawer === null;
  const bottomMaximized = wantsBottom && (state.bottom.maximized || short);
  const bottomHeight = bottomMaximized
    ? contentHeight
    : clamp(state.bottom.height ?? defaults.bottomHeight, bounds.min, bounds.max);

  return {
    width,
    height,
    tooSmall,
    mode,
    zen,
    sidebarSide: defaults.sidebarSide,
    commandBar,
    compactCommandBar: mode === "narrow",
    statusBar,
    activityBar: { visible: false, width: 0 },
    gap,
    viewSwitcher: defaults.showActivityBar,
    sidebar: { visible: showSidebar, width: sidebarWidth, drawer: drawer === "sidebar" },
    auxiliary: { visible: showAuxiliary, width: auxiliaryWidth, drawer: drawer === "auxiliary" },
    bottom: { visible: wantsBottom, height: bottomHeight, maximized: bottomMaximized },
    editor: { visible: drawer === null && !bottomMaximized },
  };
}
