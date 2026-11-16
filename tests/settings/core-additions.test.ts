/** Tests for the small additive core changes made for the settings models. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { parse } from "smol-toml";
import { configFilePath } from "@/core/config/load";
import { getDescriptor, settingsSchema } from "@/core/config/schema";
import { ConfigService } from "@/core/config/service";
import { isLucyError } from "@/core/errors";
import { KeybindingRegistry } from "@/core/keybindings/registry";
import { makeTempDirs, type TempDirs } from "../core/helpers";

let temp: TempDirs;
beforeEach(async () => {
  temp = await makeTempDirs();
});
afterEach(async () => {
  await temp.cleanup();
});

describe("setting behavior flags", () => {
  test("live-preview and restart flags", () => {
    expect(settingsSchema.filter((d) => d.livePreview).map((d) => d.path)).toEqual([
      "ui.theme",
      "ui.accent",
      "ui.density",
      "ui.icons",
    ]);
    expect(settingsSchema.filter((d) => d.requiresRestart).map((d) => d.path)).toEqual([
      "ui.colorMode",
      "git.enabled",
      "workspace.watch",
    ]);
    expect(getDescriptor("editor.wrap").requiresRestart).toBeUndefined();
  });
});

describe("ConfigService.setMany", () => {
  test("applies several settings with one event and one save", async () => {
    const service = await ConfigService.load(temp.dirs);
    await service.set("ui.density", "compact");
    let events = 0;
    service.onDidChange(() => events++);
    const result = await service.setMany([
      { path: "ui.theme", value: "tokyo-night" },
      { path: "editor.external", value: ["code", "--wait"] },
    ]);
    expect(events).toBe(1);
    expect(result?.written).toBe(true);
    expect(parse(await readFile(configFilePath(temp.dirs), "utf8"))).toEqual({
      version: 1,
      ui: { theme: "tokyo-night", density: "compact" },
      editor: { external: ["code", "--wait"] },
    });
    // One save after the first: exactly one timestamped backup.
    expect(await readdir(`${temp.dirs.config}/backups`)).toHaveLength(1);
  });

  test("is all-or-nothing and names every invalid entry", async () => {
    const service = await ConfigService.load(temp.dirs);
    const before = service.config;
    const error = await service
      .setMany([
        { path: "ui.theme", value: "tokyo-night" },
        { path: "layout.sidebarWidth", value: 9999 },
        { path: "ui.telemetry" as never, value: true },
      ])
      .catch((e: unknown) => e);
    expect(isLucyError(error, "CONFIG_INVALID")).toBe(true);
    expect((error as Error).message).toContain("layout.sidebar_width");
    expect((error as Error).message).toContain('"ui.telemetry"');
    expect(service.config).toBe(before);
    expect(await Bun.file(configFilePath(temp.dirs)).exists()).toBe(false);
  });

  test("an empty batch writes nothing", async () => {
    const service = await ConfigService.load(temp.dirs);
    expect(await service.setMany([])).toBeUndefined();
    expect(await Bun.file(configFilePath(temp.dirs)).exists()).toBe(false);
  });
});

describe("KeybindingRegistry additions", () => {
  const defaults = [
    { command: "view.toggleSidebar", keys: ["ctrl+b"], when: "!inputFocus" },
    { command: "file.quickOpen", keys: ["ctrl+p"], global: true },
  ];

  test("defaultRulesFor survives user overrides; commandIds lists bound commands", () => {
    const registry = new KeybindingRegistry({ defaults });
    registry.setUserBindings({ "view.toggleSidebar": false, "custom.thing": "ctrl+t" });
    expect(registry.defaultRulesFor("view.toggleSidebar").map((r) => [r.key, r.when, r.source])).toEqual([
      ["ctrl+b", "!inputFocus", "default"],
    ]);
    expect(registry.defaultRulesFor("file.quickOpen")[0]?.global).toBe(true);
    expect(registry.defaultRulesFor("custom.thing")).toEqual([]);
    expect(registry.commandIds()).toEqual(["view.toggleSidebar", "file.quickOpen", "custom.thing"]);
  });

  test("onDidChangeBindings fires after setUserBindings", () => {
    const registry = new KeybindingRegistry({ defaults });
    let count = 0;
    const sub = registry.onDidChangeBindings(() => count++);
    registry.setUserBindings({});
    registry.setUserBindings({ "file.quickOpen": "ctrl+o" });
    sub.dispose();
    registry.setUserBindings({});
    expect(count).toBe(2);
  });
});
