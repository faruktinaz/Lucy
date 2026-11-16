import { describe, expect, test } from "bun:test";
import { mountApp } from "../helpers/app";
import { normalizeFrame, stableWorkspace } from "./support";

const GIT = {
  branch: { name: "main", upstream: "origin/main", ahead: 2, behind: 0 },
  changes: [
    { path: "README.md", worktree: "modified" as const, conflicted: false },
    { path: "src/new.ts", worktree: "untracked" as const, conflicted: false },
  ],
};

describe("shell text snapshots", () => {
  for (const [width, height] of [
    [120, 35],
    [90, 28],
    [70, 24],
  ] as const) {
    test(`${width}x${height}`, async () => {
      const { tui, ctx } = await mountApp({
        workspace: { root: stableWorkspace() },
        width,
        height,
        git: GIT,
      });
      await tui.act(() => ctx.services.git.refresh());
      expect(normalizeFrame(tui.frame())).toMatchSnapshot();
    });
  }
});

describe("shell structure", () => {
  test("the first screen shows the workspace, the Quick Open pill, the explorer and the welcome actions", async () => {
    const { tui } = await mountApp({ workspace: { root: stableWorkspace() } });
    const frame = tui.frame();
    expect(frame).toContain("atlas");
    expect(frame).toContain("Search files and commands");
    expect(frame).toContain("EXPLORER");
    expect(frame).toContain("Open a file");
    expect(frame).toContain("Ctrl+P");
    expect(frame).toContain("Catppuccin Mocha");
  });

  test("git status reaches the status bar and the activity badge", async () => {
    const { tui, ctx } = await mountApp({ workspace: { root: stableWorkspace() }, git: GIT });
    await tui.act(() => ctx.services.git.refresh());
    const frame = tui.frame();
    const status = frame.trimEnd().split("\n").at(-1) ?? "";
    expect(status).toContain("main");
    expect(status).toContain("2");
    expect(frame).toMatch(/^\s+2\s/m);
  });

  test("nothing heavy starts before the first paint", async () => {
    const { ctx, app } = await mountApp({ workspace: { root: stableWorkspace() } });
    // mountApp marks the first paint without starting background services.
    expect(ctx.services.createdServices.filter((name) => name !== "git")).toEqual([]);
    expect(ctx.services.git.state.status).toBeNull();
    app.markFirstPaint();
  });

  test("clicking the Quick Open pill opens Go to File", async () => {
    const { tui, ctx } = await mountApp({ workspace: { root: stableWorkspace() } });
    await tui.clickText("Search files and commands");
    expect(ctx.quickPick.state.open).toBe(true);
    expect(ctx.quickPick.state.prefix).toBe("");
    await tui.press("escape");
    expect(ctx.quickPick.state.open).toBe(false);
  });

  test("Ctrl+C outside a terminal never quits; it explains how", async () => {
    let quit = false;
    const { tui } = await mountApp({
      workspace: { root: stableWorkspace() },
      onQuit: () => {
        quit = true;
      },
    });
    await tui.press("ctrl+c");
    expect(quit).toBe(false);
    expect(tui.frame()).toContain("Quit with Ctrl+Q");
    await tui.press("ctrl+q");
    expect(quit).toBe(true);
  });
});
