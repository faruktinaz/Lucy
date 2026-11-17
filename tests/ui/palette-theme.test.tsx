import { describe, expect, test } from "bun:test";
import { getTheme } from "@/themes";
import { mountApp } from "../helpers/app";
import { cellAt, hexOf, stableWorkspace } from "./support";

describe("command palette", () => {
  test("opens with F1, filters with fuzzy matching, and runs the chosen command", async () => {
    const { tui, ctx } = await mountApp({ workspace: { root: stableWorkspace() } });
    await tui.press("f1");
    expect(ctx.quickPick.state.open).toBe(true);
    expect(tui.frame()).toContain("Commands");
    await tui.type("zen");
    const frame = await tui.waitForText("Toggle Zen Mode");
    expect(frame).toContain("Ctrl+K Z");
    expect(ctx.layout.state.zen).toBe(false);
    await tui.press("enter");
    expect(ctx.quickPick.state.open).toBe(false);
    expect(ctx.layout.state.zen).toBe(true);
    // The command is now first under "recently used".
    await tui.press("f1");
    expect(ctx.quickPick.state.items[0]?.id).toBe("view.toggleZenMode");
    expect(tui.frame()).toContain("recently used");
  });

  test("Ctrl+Shift+P (kitty) and the Ctrl+\\ P leader open it too; Escape closes it", async () => {
    const { tui, ctx } = await mountApp({ workspace: { root: stableWorkspace() } });
    await tui.press("ctrl+shift+p");
    expect(ctx.quickPick.state.prefix).toBe(">");
    await tui.press("escape");
    expect(ctx.quickPick.state.open).toBe(false);
    await tui.press("ctrl+\\");
    expect(tui.frame()).toContain("P palette");
    await tui.press("p");
    expect(ctx.quickPick.state.open).toBe(true);
  });

  test("Quick Open lists workspace files with Turkish names and opens one as a tab", async () => {
    const { tui, ctx } = await mountApp({ workspace: { root: stableWorkspace() } });
    await tui.press("ctrl+p");
    await tui.type("calis");
    await tui.waitForText("çalışma.ts");
    await tui.press("enter");
    expect(ctx.editors.active?.resource).toBe("src/features/çalışma.ts");
    expect(ctx.focus.current).toBe("editor");
    const frame = tui.frame();
    expect(frame).toContain("çalışma.ts");
    expect(frame).toContain("features");
  });
});

describe("themes", () => {
  test("switching the theme recolors the canvas and the chrome live", async () => {
    const { tui, ctx } = await mountApp({ workspace: { root: stableWorkspace() } });
    const mocha = getTheme("catppuccin-mocha").tokens;
    const before = tui.spans();
    // The editor card (base) and the status bar, which sits on the canvas.
    expect(hexOf(cellAt(before, 50, 20).bg)).toBe(mocha.bg.base);
    expect(hexOf(cellAt(before, 50, 34).bg)).toBe(mocha.bg.canvas);

    await tui.act(() => ctx.config.set("ui.theme", "high-contrast", { persist: false }));
    const contrast = getTheme("high-contrast").tokens;
    const after = tui.spans();
    expect(hexOf(cellAt(after, 50, 20).bg)).toBe(contrast.bg.base);
    expect(hexOf(cellAt(after, 50, 34).bg)).toBe(contrast.bg.canvas);
    expect(tui.frame()).toContain("High Contrast");
  });

  test("the theme picker previews live and reverts on cancel", async () => {
    const { tui, ctx } = await mountApp({ workspace: { root: stableWorkspace() } });
    void ctx.commands.execute("theme.select");
    await tui.settle();
    expect(tui.frame()).toContain("Color Theme");
    await tui.press("down");
    expect(ctx.config.get("ui.theme")).toBe("tokyo-night");
    // Behind the picker the whole workbench already wears the previewed theme.
    expect(ctx.themes.current.id).toBe("tokyo-night");
    expect(tui.frame()).toContain("Tokyo Night");
    await tui.press("escape");
    await tui.settle();
    expect(ctx.config.get("ui.theme")).toBe("catppuccin-mocha");
  });

  test("no component draws with a color outside the active theme's tokens", async () => {
    const { tui } = await mountApp({ workspace: { root: stableWorkspace() } });
    const tokens = getTheme("catppuccin-mocha").tokens;
    const allowed = new Set<string>();
    for (const group of Object.values(tokens))
      for (const value of Object.values(group)) allowed.add(String(value));
    const used = new Set<string>();
    for (const line of tui.spans().lines) {
      for (const span of line.spans) {
        if (span.bg.a > 0) used.add(hexOf(span.bg));
        if (span.text.trim() !== "") used.add(hexOf(span.fg));
      }
    }
    expect([...used].filter((hex) => !allowed.has(hex))).toEqual([]);
  });
});
