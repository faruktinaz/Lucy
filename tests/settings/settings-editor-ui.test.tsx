/** The Settings editor through the real UI: every control kind, persistence, preview, problems. */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parse } from "smol-toml";
import { configFilePath } from "@/core/config/load";
import { settingsServices } from "@/features/settings";
import type { ExternalEditorRunner } from "@/features/settings/config-file";
import { createTestDirs, type MountedApp, mountApp } from "../helpers/app";
import { fakeBin, hideAgentPanel, normalizeFrame, withSettings } from "./helpers";

async function openSettings(app: MountedApp, query?: string): Promise<void> {
  await hideAgentPanel(app);
  await app.tui.act(() => app.ctx.commands.execute("settings.open"));
  if (query) await app.tui.type(query);
}

/** Choosing "Custom …" starts the inline edit asynchronously; wait for it before typing. */
async function untilEditing(app: MountedApp): Promise<void> {
  const vm = settingsServices(app.ctx).settings;
  const deadline = performance.now() + 3000;
  while (vm.state.edit === null) {
    if (performance.now() > deadline) throw new Error("The inline edit did not start");
    await app.tui.advance(20);
  }
}

async function fileTable(app: MountedApp): Promise<Record<string, unknown>> {
  await app.ctx.config.flush();
  const path = configFilePath(app.dirs);
  return existsSync(path) ? (parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
}

describe("Settings editor", () => {
  test("opens as an editor tab with categories, values and the file statement", async () => {
    const app = await mountApp({ width: 120, height: 35 });
    await openSettings(app);
    const frame = app.tui.frame();
    expect(app.ctx.editors.active?.kind).toBe("settings");
    expect(frame).toContain("APPEARANCE");
    expect(frame).toContain("Color theme");
    expect(frame).toContain("ui.theme");
    expect(frame).toContain("Catppuccin Mocha");
    expect(frame).toContain("50 settings");
    expect(frame).toContain("Saved in");
    expect(frame).toContain("never edits other tools' configuration");
  });

  test("toggle with Space persists, the row shows Reset, Delete resets", async () => {
    const app = await mountApp({ width: 120, height: 35 });
    await openSettings(app, "word wrap");
    await app.tui.press("down");
    await app.tui.press("space");
    expect(app.ctx.config.get("editor.wrap")).toBe(true);
    expect(await fileTable(app)).toEqual({ version: 1, editor: { wrap: true } });
    await app.tui.waitForText("Reset");
    await app.tui.press("delete");
    expect(app.ctx.config.get("editor.wrap")).toBe(false);
    expect(await fileTable(app)).toEqual({ version: 1 });
    // Two saves: the previous file was backed up.
    expect(existsSync(`${configFilePath(app.dirs)}.bak`)).toBe(true);
  });

  test("select: Left/Right cycle and save", async () => {
    const app = await mountApp({ width: 120, height: 35 });
    await openSettings(app, "search engine");
    await app.tui.press("down");
    await app.tui.press("right");
    expect(app.ctx.config.get("search.engine")).toBe("ripgrep");
    await app.tui.press("left");
    await app.tui.press("left");
    expect(app.ctx.config.get("search.engine")).toBe("builtin");
    expect(await fileTable(app)).toEqual({ version: 1, search: { engine: "builtin" } });
  });

  test("live preview applies while moving and reverts on Escape; Enter commits", async () => {
    const app = await mountApp({ width: 120, height: 35 });
    await openSettings(app, "color theme");
    await app.tui.press("down");
    await app.tui.press("enter");
    await app.tui.waitForText("Gruvbox Dark");
    await app.tui.press("down");
    expect(app.ctx.config.get("ui.theme")).toBe("tokyo-night");
    expect(app.ctx.themes.current.id).toBe("tokyo-night");
    expect(await fileTable(app)).toEqual({});
    await app.tui.press("escape");
    expect(app.ctx.config.get("ui.theme")).toBe("catppuccin-mocha");
    await app.tui.press("enter");
    await app.tui.press("down");
    await app.tui.press("down");
    await app.tui.press("enter");
    expect(app.ctx.config.get("ui.theme")).toBe("gruvbox-dark");
    expect(await fileTable(app)).toEqual({ version: 1, ui: { theme: "gruvbox-dark" } });
  });

  test("number: edit in place with live validation, then save", async () => {
    const app = await mountApp({ width: 120, height: 35 });
    await openSettings(app, "sidebar width");
    await app.tui.press("down");
    await app.tui.press("enter");
    await app.tui.press("backspace");
    await app.tui.press("backspace");
    await app.tui.type("5");
    await app.tui.waitForText("Expected a whole number from 16 to 80 columns");
    await app.tui.press("enter");
    expect(app.ctx.config.get("layout.sidebarWidth")).toBe(30);
    await app.tui.type("0");
    await app.tui.press("enter");
    expect(app.ctx.config.get("layout.sidebarWidth")).toBe(50);
    expect(await fileTable(app)).toEqual({ version: 1, layout: { sidebar_width: 50 } });
  });

  test("text: Escape cancels, Enter saves", async () => {
    const app = await mountApp({ width: 120, height: 35 });
    await openSettings(app, "claude code executable");
    await app.tui.press("down");
    await app.tui.press("enter");
    await app.tui.type("/opt/bin/claude");
    await app.tui.press("escape");
    expect(app.ctx.config.get("ai.executable")).toBe("");
    await app.tui.press("enter");
    await app.tui.type("/opt/bin/claude");
    await app.tui.press("enter");
    expect(await fileTable(app)).toEqual({ version: 1, ai: { executable: "/opt/bin/claude" } });
  });

  test("string list: add an entry, reject an empty one, remove an entry", async () => {
    const app = await mountApp({ width: 120, height: 35 });
    await openSettings(app, "excluded names");
    await app.tui.press("down");
    await app.tui.press("enter");
    await app.tui.waitForText("Add entry");
    await app.tui.press("enter");
    await app.tui.press("enter");
    await app.tui.waitForText("An entry cannot be empty");
    await app.tui.type("dist");
    await app.tui.press("enter");
    expect(app.ctx.config.get("explorer.exclude")).toEqual([".git", ".DS_Store", "dist"]);
    await app.tui.press("up");
    await app.tui.press("up");
    await app.tui.press("delete");
    expect(app.ctx.config.get("explorer.exclude")).toEqual([".git", "dist"]);
    expect(await fileTable(app)).toEqual({ version: 1, explorer: { exclude: [".git", "dist"] } });
  });

  test("custom command and custom color through the picker", async () => {
    const app = await mountApp({ width: 120, height: 35 });
    await openSettings(app, "external editor");
    await app.tui.press("down");
    await app.tui.press("enter");
    await app.tui.waitForText("Custom command", { timeoutMs: 8000 });
    for (let i = 0; i < 10; i++) await app.tui.press("down");
    await app.tui.press("enter");
    await untilEditing(app);
    await app.tui.type('code --wait "My Dir"');
    await app.tui.press("enter");
    expect(app.ctx.config.get("editor.external")).toEqual(["code", "--wait", "My Dir"]);

    await app.tui.press("/");
    for (let i = 0; i < 20; i++) await app.tui.press("backspace");
    await app.tui.type("accent color");
    await app.tui.press("down");
    await app.tui.press("enter");
    for (let i = 0; i < 10; i++) await app.tui.press("down");
    await app.tui.press("enter");
    await untilEditing(app);
    for (let i = 0; i < 2; i++) await app.tui.press("backspace");
    await app.tui.type("#12345");
    await app.tui.waitForText("Enter a color as #rrggbb", { timeoutMs: 8000 });
    await app.tui.type("6");
    await app.tui.press("enter");
    expect(app.ctx.config.get("ui.accent")).toBe("#123456");
  }, 20_000);

  test("text snapshots at 120x35 and 90x28", async () => {
    for (const [width, height] of [
      [120, 35],
      [90, 28],
    ] as const) {
      const app = await mountApp({ width, height });
      await openSettings(app);
      await app.tui.press("down");
      expect(normalizeFrame(app.tui.frame())).toMatchSnapshot(`settings-${width}x${height}`);
      await app.dispose();
    }
  });
});

describe("config problems", () => {
  function brokenConfigDirs() {
    const dirs = createTestDirs();
    mkdirSync(dirs.config, { recursive: true });
    writeFileSync(configFilePath(dirs), '[ui]\ntheme = "bogus"\ncolour = "red"\n');
    return dirs;
  }

  test("the banner lists problems and the startup toast offers to show them", async () => {
    const app = await mountApp({ width: 120, height: 35, dirs: brokenConfigDirs() });
    const toast = app.ctx.notifications.toasts.find((t) => t.key === "config-problems");
    expect(toast?.title).toBe("2 settings in config.toml were ignored");
    expect(toast?.actions?.map((a) => a.label)).toEqual(["Show Problems"]);
    await hideAgentPanel(app);
    await app.tui.act(() => toast?.actions?.[0]?.run());
    const frame = await app.tui.waitForText("2 problems in config.toml");
    expect(frame).toContain("Open config.toml");
    expect(frame).toContain("line 2");
    expect(frame).toContain("bogus");
  });

  test("Open config.toml uses the external editor outside the workspace, then reloads", async () => {
    const calls: { file: string; allow?: boolean; line?: number }[] = [];
    const runner: ExternalEditorRunner = async (options) => {
      calls.push({ file: options.file, allow: options.allowOutsideWorkspace, line: options.line });
      writeFileSync(options.file, '[ui]\ntheme = "tokyo-night"\n');
      return { exitCode: 0, signal: null, changed: true, deleted: false, file: options.file, argv: [] };
    };
    const bin = fakeBin({ micro: "exit 0" });
    const dirs = brokenConfigDirs();
    const app = await mountApp({
      width: 120,
      height: 35,
      dirs,
      features: withSettings({ onboarding: "never", env: { PATH: bin }, openExternalEditor: runner }),
      settings: { "editor.external": "micro" },
    });
    await openSettings(app);
    await app.tui.press("down");
    await app.tui.press("enter");
    await app.tui.waitForText("Settings reloaded");
    expect(calls).toEqual([{ file: configFilePath(dirs), allow: true, line: 2 }]);
    expect(app.ctx.config.get("ui.theme")).toBe("tokyo-night");
    expect(app.tui.frame()).not.toContain("problems in config.toml");
  });

  test("without an editor the path is shown with a copy action", async () => {
    const app = await mountApp({
      width: 120,
      height: 35,
      features: withSettings({ onboarding: "never", env: { PATH: "/nonexistent" } }),
    });
    await app.tui.act(() => app.ctx.commands.execute("settings.openConfigFile"));
    const toast = app.ctx.notifications.toasts.find((t) => t.key === "settings.configPath");
    expect(toast?.title).toContain("config.toml");
    expect(toast?.actions?.map((a) => a.label)).toEqual(["Copy Path"]);
  });
});
