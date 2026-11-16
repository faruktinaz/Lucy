import { describe, expect, test } from "bun:test";
import type { PtyProcess } from "@/adapters/pty";
import { mountApp } from "../helpers/app";
import { stableWorkspace } from "../ui/support";

describe("createApp", () => {
  test("background services start only after the first paint", async () => {
    const { tui, ctx, app } = await mountApp({
      workspace: { root: stableWorkspace() },
      git: { branch: { name: "trunk" } },
    });
    // The Source Control stub subscribes to the Git service, which is a plain object until
    // refreshed: no Git process has run, and nothing else exists yet.
    expect(ctx.services.createdServices.filter((name) => name !== "git")).toEqual([]);
    expect(ctx.services.git.state.lastUpdated).toBeNull();
    expect(ctx.services.git.state.loading).toBe(false);
    app.markFirstPaint({ startBackground: true });
    await tui.waitForText("trunk");
    expect(ctx.services.createdServices).toContain("git");
  });

  test("dispose is idempotent and kills every PTY", async () => {
    let killed = 0;
    const fake = {
      pid: 1,
      isRunning: true,
      exited: new Promise<never>(() => {}),
      hangup: () => {},
      dispose: () => {
        killed++;
      },
    } as unknown as PtyProcess;
    const { ctx, app } = await mountApp({ workspace: { root: stableWorkspace() } });
    // Track a fake PTY whose process "never exits", so disposeAll must handle it.
    ctx.services.pty.track(Object.assign(fake, { isRunning: false }));
    const first = app.dispose();
    expect(app.dispose()).toBe(first);
    await first;
    expect(killed).toBe(0);
  });

  test("keybinding labels come from the registry and follow user overrides", async () => {
    const { ctx } = await mountApp({
      workspace: { root: stableWorkspace() },
      settings: { "keybindings.bindings": { "file.quickOpen": "ctrl+o" } },
    });
    expect(ctx.keybindingLabel("file.quickOpen")).toBe("Ctrl+O");
    expect(ctx.keybindingLabel("app.quit")).toBe("Ctrl+Q");
    // Legacy terminal (the test renderer reports no kitty support): the legacy-safe chord wins.
    expect(ctx.keybindingLabel("view.showExplorer")).toBe("Ctrl+K E");
    expect(ctx.keybindingLabel("palette.show")).toBe("F1");
  });
});
