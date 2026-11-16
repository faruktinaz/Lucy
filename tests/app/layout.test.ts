import { describe, expect, test } from "bun:test";
import { defaultLayoutState, LayoutService } from "@/app/workbench/layout";
import {
  computeEffectiveLayout,
  type FocusZone,
  LAYOUT_LIMITS,
  type LayoutDefaults,
  type LayoutState,
  sideWidthBounds,
} from "@/app/workbench/layout-compute";
import { constant } from "@/app/workbench/readable";
import { Store } from "@/core/store";

const DEFAULTS: LayoutDefaults = {
  sidebarWidth: 30,
  auxiliaryWidth: 64,
  bottomHeight: 12,
  sidebarSide: "left",
  showCommandBar: true,
  showStatusBar: true,
  showActivityBar: true,
};

function state(patch: (s: LayoutState) => LayoutState = (s) => s): LayoutState {
  return patch(defaultLayoutState());
}

function both(s: LayoutState): LayoutState {
  return { ...s, sidebar: { ...s.sidebar, visible: true }, auxiliary: { ...s.auxiliary, visible: true } };
}

function compute(
  layoutState: LayoutState,
  width: number,
  height: number,
  focusedZone: FocusZone = "editor",
  hasAuxiliaryView = true,
) {
  return computeEffectiveLayout({
    state: layoutState,
    viewport: { width, height },
    defaults: DEFAULTS,
    focusedZone,
    hasAuxiliaryView,
  });
}

/** The narrowest the editor may get beside side regions at this width. */
function editorMin(width: number): number {
  return Math.max(LAYOUT_LIMITS.editorMinWidth, Math.floor(width * 0.4));
}

/** Columns left for the editor: viewport minus activity bar and visible side regions. */
function editorWidth(result: ReturnType<typeof compute>): number {
  return (
    result.width -
    result.activityBar.width -
    (result.sidebar.visible ? result.sidebar.width : 0) -
    (result.auxiliary.visible ? result.auxiliary.width : 0)
  );
}

describe("computeEffectiveLayout", () => {
  test("wide (>= 110 columns): sidebar, editor and auxiliary panel coexist", () => {
    for (const width of [110, 120, 160]) {
      const result = compute(both(state()), width, 35);
      expect(result.mode).toBe("wide");
      expect(result.sidebar.visible).toBe(true);
      expect(result.auxiliary.visible).toBe(true);
      expect(result.editor.visible).toBe(true);
      expect(editorWidth(result)).toBeGreaterThanOrEqual(editorMin(width));
    }
  });

  test("widths are clamped so the editor keeps its minimum width", () => {
    const result = compute(both(state()), 120, 35);
    // The 64-column default AI panel cannot fit next to a 30-column sidebar at 120 columns:
    // the auxiliary panel gives way first, the sidebar keeps its width.
    expect(result.sidebar.width).toBe(30);
    expect(result.auxiliary.width).toBeLessThan(64);
    expect(result.auxiliary.width).toBeLessThanOrEqual(sideWidthBounds("auxiliary", 120).max);
    expect(result.auxiliary.width).toBeGreaterThanOrEqual(LAYOUT_LIMITS.auxiliary.min);
    expect(editorWidth(result)).toBe(editorMin(120));
    expect(editorMin(120)).toBeGreaterThanOrEqual(LAYOUT_LIMITS.editorMinWidth);
  });

  test("an auxiliary panel without a registered view is never shown", () => {
    const result = compute(both(state()), 140, 35, "editor", false);
    expect(result.auxiliary.visible).toBe(false);
  });

  test("medium (80..109): only the preferred side region sits beside the editor", () => {
    const lastSidebar = compute(both(state((s) => ({ ...s, lastSide: "sidebar" }))), 100, 30);
    expect(lastSidebar.mode).toBe("medium");
    expect(lastSidebar.sidebar.visible).toBe(true);
    expect(lastSidebar.auxiliary.visible).toBe(false);

    const lastAuxiliary = compute(both(state((s) => ({ ...s, lastSide: "auxiliary" }))), 100, 30);
    expect(lastAuxiliary.sidebar.visible).toBe(false);
    expect(lastAuxiliary.auxiliary.visible).toBe(true);

    // Focus wins over the remembered side.
    const focused = compute(both(state((s) => ({ ...s, lastSide: "sidebar" }))), 100, 30, "auxiliary");
    expect(focused.auxiliary.visible).toBe(true);
    expect(focused.sidebar.visible).toBe(false);
  });

  test("the hidden side comes back by itself when the terminal grows", () => {
    const requested = both(state((s) => ({ ...s, lastSide: "auxiliary" })));
    expect(compute(requested, 95, 30).sidebar.visible).toBe(false);
    const wide = compute(requested, 130, 30);
    expect(wide.sidebar.visible).toBe(true);
    expect(wide.auxiliary.visible).toBe(true);
  });

  test("narrow (< 80): a side region is a full-width drawer that follows focus", () => {
    const requested = both(state());
    const editorFocused = compute(requested, 70, 24, "editor");
    expect(editorFocused.mode).toBe("narrow");
    expect(editorFocused.sidebar.visible).toBe(false);
    expect(editorFocused.auxiliary.visible).toBe(false);
    expect(editorFocused.editor.visible).toBe(true);
    expect(editorFocused.compactCommandBar).toBe(true);

    const drawer = compute(requested, 70, 24, "sidebar");
    expect(drawer.sidebar.visible).toBe(true);
    expect(drawer.sidebar.drawer).toBe(true);
    expect(drawer.sidebar.width).toBe(70 - LAYOUT_LIMITS.activityBarWidth);
    expect(drawer.editor.visible).toBe(false);

    const auxiliaryDrawer = compute(requested, 70, 24, "auxiliary");
    expect(auxiliaryDrawer.auxiliary.drawer).toBe(true);
    expect(auxiliaryDrawer.sidebar.visible).toBe(false);
    expect(auxiliaryDrawer.editor.visible).toBe(false);
  });

  test("a drawer only opens for a side the user asked for", () => {
    const hidden = state((s) => ({ ...s, sidebar: { ...s.sidebar, visible: false } }));
    const result = compute(hidden, 70, 24, "sidebar");
    expect(result.sidebar.visible).toBe(false);
    expect(result.editor.visible).toBe(true);
  });

  test("short (< 24 rows): the bottom panel is maximized and the command bar hides", () => {
    const withBottom = state((s) => ({ ...s, bottom: { ...s.bottom, visible: true } }));
    const result = compute(withBottom, 120, 20);
    expect(result.commandBar).toBe(false);
    expect(result.bottom.visible).toBe(true);
    expect(result.bottom.maximized).toBe(true);
    expect(result.bottom.height).toBe(20 - 1); // only the status bar remains
    expect(result.editor.visible).toBe(false);

    const withoutBottom = compute(state(), 120, 20);
    expect(withoutBottom.bottom.visible).toBe(false);
    expect(withoutBottom.editor.visible).toBe(true);
  });

  test("below about 60x16 the screen is too small", () => {
    expect(compute(state(), 59, 30).tooSmall).toBe(true);
    expect(compute(state(), 100, 15).tooSmall).toBe(true);
    expect(compute(state(), 60, 16).tooSmall).toBe(false);
  });

  test("zen mode hides everything but the editor", () => {
    const zen = both(state((s) => ({ ...s, zen: true, bottom: { ...s.bottom, visible: true } })));
    const result = compute(zen, 140, 40);
    expect(result.zen).toBe(true);
    expect(result.commandBar).toBe(false);
    expect(result.statusBar).toBe(false);
    expect(result.activityBar.visible).toBe(false);
    expect(result.activityBar.width).toBe(0);
    expect(result.sidebar.visible).toBe(false);
    expect(result.auxiliary.visible).toBe(false);
    expect(result.bottom.visible).toBe(false);
    expect(result.editor.visible).toBe(true);
  });

  test("the bottom panel height leaves the editor at least six rows", () => {
    const tall = state((s) => ({ ...s, bottom: { ...s.bottom, visible: true, height: 60 } }));
    const result = compute(tall, 120, 30);
    const content = 30 - 2;
    expect(result.bottom.height).toBe(content - LAYOUT_LIMITS.editorMinRows);
    const tiny = state((s) => ({ ...s, bottom: { ...s.bottom, visible: true, height: 1 } }));
    expect(compute(tiny, 120, 30).bottom.height).toBe(LAYOUT_LIMITS.bottom.min);
  });
});

function createService(width = 120, height = 35, focused: FocusZone = "editor") {
  const zone = new Store<FocusZone>(focused);
  const service = new LayoutService({
    defaults: constant(DEFAULTS),
    focusedZone: zone,
    hasAuxiliaryView: constant(true),
    viewport: { width, height },
  });
  return { service, zone };
}

describe("LayoutService", () => {
  test("toggles and shows panels, leaving zen when a panel is shown", () => {
    const { service } = createService();
    expect(service.state.sidebar.visible).toBe(true);
    service.toggleSidebar();
    expect(service.state.sidebar.visible).toBe(false);
    service.setZen(true);
    service.showSidebarView("search");
    expect(service.state.sidebar).toEqual({ visible: true, view: "search", width: null });
    expect(service.state.zen).toBe(false);
    expect(service.state.lastSide).toBe("sidebar");

    service.showAuxiliaryView("claude");
    expect(service.state.auxiliary.visible).toBe(true);
    expect(service.state.lastSide).toBe("auxiliary");

    service.showBottomTab("terminal");
    expect(service.state.bottom).toMatchObject({ visible: true, tab: "terminal" });
    service.toggleBottomMaximized();
    expect(service.state.bottom.maximized).toBe(true);
    service.setBottomVisible(false);
    expect(service.state.bottom.maximized).toBe(false);
  });

  test("widths and heights are clamped to their limits", () => {
    const { service } = createService(120, 35);
    service.setSidebarWidth(5);
    expect(service.state.sidebar.width).toBe(LAYOUT_LIMITS.sidebar.min);
    service.setSidebarWidth(500);
    expect(service.state.sidebar.width).toBe(sideWidthBounds("sidebar", 120).max);
    service.setAuxiliaryWidth(500);
    expect(service.state.auxiliary.width).toBe(sideWidthBounds("auxiliary", 120).max);
    service.setAuxiliaryWidth(1);
    expect(service.state.auxiliary.width).toBe(LAYOUT_LIMITS.auxiliary.min);
    service.setBottomHeight(1);
    expect(service.state.bottom.height).toBe(LAYOUT_LIMITS.bottom.min);
    service.setBottomHeight(1000);
    expect(service.state.bottom.height).toBe(35 - 2 - LAYOUT_LIMITS.editorMinRows);
  });

  test("resize() grows and shrinks by keyboard steps from the effective size", () => {
    const { service } = createService(140, 40);
    const before = service.effective.get().sidebar.width;
    service.resize("sidebar", 4);
    expect(service.effective.get().sidebar.width).toBe(before + 4);
    service.resize("sidebar", -8);
    expect(service.effective.get().sidebar.width).toBe(before - 4);
    service.setBottomVisible(true);
    const height = service.effective.get().bottom.height;
    service.resize("bottom", 2);
    expect(service.effective.get().bottom.height).toBe(height + 2);
  });

  test("effective follows the viewport and focus stores", () => {
    const { service, zone } = createService(120, 35);
    service.setSidebarVisible(true);
    service.setViewport(70, 24);
    expect(service.effective.get().sidebar.visible).toBe(false);
    zone.set("sidebar");
    expect(service.effective.get().sidebar.drawer).toBe(true);
    // Same inputs, same object: subscribers can skip re-rendering.
    expect(service.effective.get()).toBe(service.effective.get());
  });

  test("toPersisted and restore round-trip", () => {
    const { service } = createService();
    service.showSidebarView("scm");
    service.setSidebarWidth(40);
    service.setAuxiliaryVisible(true);
    service.setAuxiliaryWidth(36);
    service.showBottomTab("terminal");
    service.setBottomHeight(10);
    const saved = service.toPersisted();
    expect(saved).toEqual({
      sidebar: { visible: true, view: "scm", width: 40 },
      aiPanel: { visible: true, width: 36 },
      bottomPanel: { visible: true, height: 10, tab: "terminal" },
      zen: false,
    });

    const { service: fresh } = createService();
    fresh.restore(saved);
    expect(fresh.toPersisted()).toEqual(saved);
  });

  test("a sidebar view the state file cannot name is persisted as the explorer", () => {
    const { service } = createService();
    service.showSidebarView("custom-view");
    expect(service.toPersisted().sidebar.view).toBe("explorer");
  });

  test("restore clamps stored sizes", () => {
    const { service } = createService();
    service.restore({
      sidebar: { visible: true, view: "search", width: 999 },
      aiPanel: { visible: false, width: 1 },
      bottomPanel: { visible: false, height: 1, tab: "terminal" },
      zen: false,
    });
    expect(service.state.sidebar.width).toBe(LAYOUT_LIMITS.sidebar.max);
    expect(service.state.auxiliary.width).toBe(LAYOUT_LIMITS.auxiliary.min);
    expect(service.state.bottom.height).toBe(LAYOUT_LIMITS.bottom.min);
  });

  test("reset restores defaults but keeps the selected views", () => {
    const { service } = createService();
    service.showSidebarView("search");
    service.setSidebarWidth(50);
    service.showAuxiliaryView("claude");
    service.showBottomTab("terminal");
    service.setZen(true);
    service.reset();
    expect(service.state.sidebar).toEqual({ visible: true, view: "search", width: null });
    expect(service.state.auxiliary).toEqual({ visible: false, view: "claude", width: null });
    expect(service.state.bottom).toEqual({ visible: false, tab: "terminal", height: null, maximized: false });
    expect(service.state.zen).toBe(false);
  });
});
