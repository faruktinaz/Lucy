/** First-run onboarding and the Integrations view through the real UI. */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { configFilePath } from "@/core/config/load";
import { settingsServices } from "@/features/settings";
import { readOnboardingMarker, shouldRunOnboarding } from "@/features/settings/model/onboarding-marker";
import { type MountedApp, mountApp } from "../helpers/app";
import { fakeBin, withSettings } from "./helpers";

async function until(app: MountedApp, predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("Timed out");
    await app.tui.advance(20);
  }
}

describe("onboarding", () => {
  test("never starts by itself in tests or demo mode", async () => {
    const app = await mountApp({ width: 120, height: 35 });
    await app.tui.advance(50);
    expect(app.ctx.overlays.layers.map((l) => l.id)).toEqual([]);
  });

  test("finish writes exactly the chosen settings; the marker prevents a second run", async () => {
    const bin = fakeBin({ nvim: "exit 0" });
    const app = await mountApp({
      width: 120,
      height: 35,
      features: withSettings({ onboarding: "always", env: { PATH: bin } }),
    });
    await until(app, () => app.ctx.overlays.layers.some((l) => l.id === "onboarding"));
    await app.tui.waitForText("Pick a color theme");
    // Theme: Down previews Tokyo Night on the real workbench, nothing is written yet.
    await app.tui.press("down");
    expect(app.ctx.themes.current.id).toBe("tokyo-night");
    expect(existsSync(configFilePath(app.dirs))).toBe(false);
    await app.tui.press("enter");
    // Icons: "Yes" selects Nerd Font icons.
    await app.tui.waitForText("Check the icons");
    await app.tui.press("enter");
    await app.tui.waitForText("Your keyboard");
    await app.tui.press("enter");
    // Editor: the fake nvim on PATH is offered.
    await app.tui.waitForText("Neovim");
    await app.tui.press("down");
    await app.tui.press("enter");
    const flow = settingsServices(app.ctx).onboarding;
    await until(app, () => flow.get()?.state.step === "ai");
    expect(flow.get()?.state.aiStatement).toContain("never sends prompts by itself");
    await app.tui.press("left");
    await app.tui.waitForText("Choose an editor");
    await app.tui.press("enter");
    await app.tui.press("enter");
    const summary = await app.tui.waitForText("Ready to go");
    expect(summary).toContain("Tokyo Night");
    expect(summary).toContain("ui.icons");
    expect(summary).toContain("editor.external");
    await app.tui.press("enter");
    await until(app, () => app.ctx.overlays.layers.length === 0);
    await app.ctx.config.flush();
    expect(parse(readFileSync(configFilePath(app.dirs), "utf8"))).toEqual({
      version: 1,
      ui: { theme: "tokyo-night", icons: "nerd" },
      editor: { external: "nvim" },
    });
    expect((await readOnboardingMarker(app.dirs))?.outcome).toBe("finished");
    expect(await shouldRunOnboarding({ dirs: app.dirs })).toBe(false);
  });

  test("Escape skips: nothing is written, the preview is undone, the marker is set", async () => {
    const app = await mountApp({
      width: 120,
      height: 35,
      features: withSettings({ onboarding: "always", env: { PATH: "/nonexistent" } }),
    });
    await until(app, () => app.ctx.overlays.layers.some((l) => l.id === "onboarding"));
    await app.tui.press("down");
    await app.tui.press("down");
    expect(app.ctx.themes.current.id).toBe("gruvbox-dark");
    await app.tui.press("escape");
    await until(app, () => app.ctx.overlays.layers.length === 0);
    expect(app.ctx.themes.current.id).toBe("catppuccin-mocha");
    expect(existsSync(configFilePath(app.dirs))).toBe(false);
    expect((await readOnboardingMarker(app.dirs))?.outcome).toBe("skipped");
    expect(await shouldRunOnboarding({ dirs: app.dirs })).toBe(false);
  });

  test("the Run Setup command opens it again; Skip and Back are clickable", async () => {
    const app = await mountApp({ width: 120, height: 35 });
    void app.ctx.commands.execute("onboarding.run");
    await app.tui.waitForText("Set up Lucy");
    await app.tui.clickText("Next");
    await app.tui.waitForText("Check the icons");
    await app.tui.clickText("Back");
    await app.tui.waitForText("Pick a color theme");
    await app.tui.clickText("Skip");
    await until(app, () => app.ctx.overlays.layers.length === 0);
    expect(existsSync(configFilePath(app.dirs))).toBe(false);
  });
});

describe("Integrations view", () => {
  test("shows found and missing tools with versions, the terminal and built-in modules", async () => {
    const bin = fakeBin({
      git: 'echo "git version 2.43.0"',
      claude: 'echo "1.0.33 (Claude Code)"',
      vim: 'echo "VIM - Vi IMproved 9.1" >&2; exit 1',
    });
    const app = await mountApp({
      width: 120,
      height: 35,
      features: withSettings({ onboarding: "never", env: { PATH: bin }, toolTimeoutMs: 10_000 }),
    });
    await app.tui.act(() => app.ctx.commands.execute("view.showIntegrations"));
    const model = settingsServices(app.ctx).integrations();
    await until(app, () => model.state.checkedAt !== null, 15_000);
    const frame = app.tui.frame();
    expect(frame).toContain("INTEGRATIONS");
    expect(frame).toContain("Lucy has no plugin system");
    expect(frame).toContain("3 of 12 found");
    expect(frame).toContain("2.43.0");
    expect(frame).toContain("ripgrep");
    expect(frame).toContain("not found");
    expect(model.state.tools.find((t) => t.id === "vim")?.version).toBe("9.1");
    // The selected tool shows what Lucy uses it for.
    expect(frame).toContain("Source Control");
    await app.tui.press("down");
    expect(app.tui.frame()).toContain("Fast project search.");
  }, 30_000);
});
