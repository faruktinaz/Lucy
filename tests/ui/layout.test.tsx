import { describe, expect, test } from "bun:test";
import { mountApp } from "../helpers/app";
import { stableWorkspace } from "./support";

describe("resizing", () => {
  test("dragging the sidebar edge resizes it, within its limits", async () => {
    const { tui, ctx } = await mountApp({ workspace: { root: stableWorkspace() } });
    const width = ctx.layout.effective.get().sidebar.width;
    // The handle is the sidebar's last column: activity bar (4) + width - 1.
    const edge = 4 + width - 1;
    await tui.drag(edge, 15, edge + 10, 15);
    expect(ctx.layout.effective.get().sidebar.width).toBe(width + 10);
    await tui.drag(edge + 10, 15, 0, 15);
    expect(ctx.layout.effective.get().sidebar.width).toBe(16);
  });

  test("the keyboard resizes the focused part (Ctrl+K = / Ctrl+K -)", async () => {
    const { tui, ctx } = await mountApp({ workspace: { root: stableWorkspace() } });
    await tui.act(() => ctx.focus.focus("sidebar"));
    const width = ctx.layout.effective.get().sidebar.width;
    await tui.press("ctrl+k");
    await tui.press("=");
    expect(ctx.layout.effective.get().sidebar.width).toBe(width + 4);
    await tui.press("ctrl+k");
    await tui.press("-");
    await tui.press("ctrl+k");
    await tui.press("-");
    expect(ctx.layout.effective.get().sidebar.width).toBe(width - 4);
  });

  test("dragging the bottom panel's header resizes the panel", async () => {
    const { tui, ctx } = await mountApp({ workspace: { root: stableWorkspace() } });
    await tui.press("ctrl+j");
    const before = ctx.layout.effective.get().bottom.height;
    const header = tui.findText("TERMINAL");
    if (!header) throw new Error("bottom panel header missing");
    await tui.drag(header.x + 20, header.y, header.x + 20, header.y - 5);
    expect(ctx.layout.effective.get().bottom.height).toBe(before + 5);
  });
});

describe("focus", () => {
  test("F6 cycles through visible parts and the focused header turns to the accent", async () => {
    const { tui, ctx } = await mountApp({ workspace: { root: stableWorkspace() } });
    expect(ctx.focus.current).toBe("editor");
    await tui.press("f6");
    expect(ctx.focus.current).toBe("sidebar");
    await tui.press("f6");
    expect(ctx.focus.current).toBe("editor");
    await tui.press("ctrl+j");
    expect(ctx.focus.current).toBe("bottom");
    await tui.press("shift+f6");
    expect(ctx.focus.current).toBe("editor");
    await tui.press("shift+f6");
    expect(ctx.focus.current).toBe("sidebar");
    const header = tui.findText("EXPLORER");
    if (!header) throw new Error("no sidebar header");
    const accent = ctx.themes.current.colors.accent.primary;
    const cell = tui.spans().lines[header.y]?.spans.find((span) => span.text.includes("EXPLORER"));
    expect(cell?.fg.equals(accent)).toBe(true);
  });

  test("clicking a part focuses it, and the leader moves focus by direction", async () => {
    const { tui, ctx } = await mountApp({ workspace: { root: stableWorkspace() } });
    await tui.click(10, 20);
    expect(ctx.focus.current).toBe("sidebar");
    await tui.press("ctrl+\\");
    await tui.press("l");
    expect(ctx.focus.current).toBe("editor");
    await tui.press("ctrl+\\");
    await tui.press("h");
    expect(ctx.focus.current).toBe("sidebar");
  });
});

describe("responsive layout", () => {
  test("from 80 to 109 columns only one side region sits beside the editor; growing restores both", async () => {
    const { tui, ctx } = await mountApp({ workspace: { root: stableWorkspace() } });
    await tui.press("ctrl+k");
    await tui.press("a");
    expect(ctx.layout.effective.get().sidebar.visible).toBe(true);
    expect(ctx.layout.effective.get().auxiliary.visible).toBe(true);
    await tui.resize(100, 30);
    // The AI panel was opened last and has focus, so it wins.
    expect(ctx.layout.effective.get().auxiliary.visible).toBe(true);
    expect(ctx.layout.effective.get().sidebar.visible).toBe(false);
    await tui.resize(130, 35);
    expect(ctx.layout.effective.get().sidebar.visible).toBe(true);
    expect(ctx.layout.effective.get().auxiliary.visible).toBe(true);
  });

  test("below 80 columns a side view is a drawer that Escape closes", async () => {
    const { tui, ctx } = await mountApp({ workspace: { root: stableWorkspace() }, width: 70, height: 24 });
    expect(ctx.layout.effective.get().sidebar.visible).toBe(false);
    expect(tui.frame()).toContain("Open a file");
    await tui.press("ctrl+k");
    await tui.press("e");
    expect(ctx.layout.effective.get().sidebar.drawer).toBe(true);
    expect(ctx.layout.effective.get().editor.visible).toBe(false);
    expect(tui.frame()).toContain("EXPLORER");
    await tui.press("escape");
    expect(ctx.focus.current).toBe("editor");
    expect(ctx.layout.effective.get().sidebar.visible).toBe(false);
  });

  test("a tiny terminal shows a friendly message, and the workbench comes back", async () => {
    const { tui } = await mountApp({ workspace: { root: stableWorkspace() } });
    await tui.resize(50, 12);
    expect(tui.frame()).toContain("Terminal too small");
    await tui.resize(120, 35);
    expect(tui.frame()).not.toContain("Terminal too small");
    expect(tui.frame()).toContain("EXPLORER");
  });

  test("zen mode shows only the editor and comes back with the same chord", async () => {
    const { tui, ctx } = await mountApp({ workspace: { root: stableWorkspace() } });
    await tui.press("ctrl+k");
    await tui.press("z");
    const frame = tui.frame();
    expect(frame).not.toContain("EXPLORER");
    expect(frame).not.toContain("Search files and commands");
    expect(frame).toContain("Zen mode");
    await tui.press("ctrl+k");
    await tui.press("z");
    expect(ctx.layout.state.zen).toBe(false);
    expect(tui.frame()).toContain("EXPLORER");
  });
});
