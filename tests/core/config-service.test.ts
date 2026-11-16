import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parse } from "smol-toml";
import { configFilePath } from "@/core/config/load";
import { type ConfigChangeEvent, ConfigService } from "@/core/config/service";
import { isLucyError } from "@/core/errors";
import { makeTempDirs, type TempDirs } from "./helpers";

let temp: TempDirs;
beforeEach(async () => {
  temp = await makeTempDirs();
});
afterEach(async () => {
  await temp.cleanup();
});

const fileTable = async () => parse(await readFile(configFilePath(temp.dirs), "utf8"));

describe("ConfigService", () => {
  test("starts from defaults without creating a file", async () => {
    const service = await ConfigService.load(temp.dirs);
    expect(service.source).toBe("defaults");
    expect(service.get("ui.theme")).toBe("catppuccin-mocha");
    expect(service.store.get()).toBe(service.config);
  });

  test("set validates, updates the store, emits and persists", async () => {
    const service = await ConfigService.load(temp.dirs);
    const events: ConfigChangeEvent[] = [];
    service.onDidChange((e) => events.push(e));
    let storeNotified = 0;
    service.store.subscribe(() => storeNotified++);

    await service.set("ui.theme", "tokyo-night");
    expect(service.get("ui.theme")).toBe("tokyo-night");
    expect(storeNotified).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.changed).toEqual(["ui.theme"]);
    expect(events[0]?.reason).toBe("set");
    expect(events[0]?.previous.ui.theme).toBe("catppuccin-mocha");
    expect(await fileTable()).toEqual({ version: 1, ui: { theme: "tokyo-night" } });
  });

  test("invalid values and unknown paths are rejected without changing anything", async () => {
    const service = await ConfigService.load(temp.dirs);
    const before = service.config;
    const invalid = service.set("layout.sidebarWidth", 5000).catch((e: unknown) => e);
    expect(isLucyError(await invalid, "CONFIG_INVALID")).toBe(true);
    // @ts-expect-error: unknown setting path
    const unknown = service.set("ui.telemetry", true).catch((e: unknown) => e);
    expect(isLucyError(await unknown, "CONFIG_INVALID")).toBe(true);
    expect(service.config).toBe(before);
  });

  test("persist: false previews a value without writing", async () => {
    const service = await ConfigService.load(temp.dirs);
    const result = await service.set("ui.theme", "gruvbox-dark", { persist: false });
    expect(result).toBeUndefined();
    expect(service.get("ui.theme")).toBe("gruvbox-dark");
    expect(await Bun.file(configFilePath(temp.dirs)).exists()).toBe(false);
  });

  test("reset removes the key from the file", async () => {
    const service = await ConfigService.load(temp.dirs);
    await service.set("ui.density", "compact");
    await service.set("editor.wrap", true);
    await service.reset("ui.density");
    expect(service.get("ui.density")).toBe("comfortable");
    expect(await fileTable()).toEqual({ version: 1, editor: { wrap: true } });
  });

  test("rapid sets are serialized and all persisted", async () => {
    const service = await ConfigService.load(temp.dirs);
    await Promise.all([
      service.set("ui.theme", "tokyo-night"),
      service.set("layout.sidebarWidth", 44),
      service.set("search.smartCase", false),
    ]);
    await service.flush();
    expect(await fileTable()).toEqual({
      version: 1,
      ui: { theme: "tokyo-night" },
      layout: { sidebar_width: 44 },
      search: { smart_case: false },
    });
  });

  test("keeps unknown keys and recomputes problems after saving", async () => {
    await mkdir(temp.dirs.config, { recursive: true });
    await writeFile(configFilePath(temp.dirs), '[ui]\ncolour = "red"\ntheme = "nope"\n');
    const service = await ConfigService.load(temp.dirs);
    expect(service.problems.map((p) => p.path).sort()).toEqual(["ui.colour", "ui.theme"]);
    await service.set("ui.theme", "tokyo-night");
    expect(service.problems.map((p) => p.path)).toEqual(["ui.colour"]);
    expect(await fileTable()).toEqual({ version: 1, ui: { colour: "red", theme: "tokyo-night" } });
  });

  test("a broken file is backed up before the first save replaces it", async () => {
    await mkdir(temp.dirs.config, { recursive: true });
    await writeFile(configFilePath(temp.dirs), "[ui\n");
    const service = await ConfigService.load(temp.dirs);
    expect(service.source).toBe("fallback");
    const result = await service.set("ui.density", "compact");
    expect(result?.brokenBackupPath).toBeDefined();
    expect(await readFile(result?.brokenBackupPath ?? "", "utf8")).toBe("[ui\n");
    expect(service.source).toBe("file");
    expect(service.problems).toEqual([]);
  });

  test("reload picks up external edits and emits the changed paths", async () => {
    const service = await ConfigService.load(temp.dirs);
    await service.set("ui.theme", "tokyo-night");
    await writeFile(
      configFilePath(temp.dirs),
      'version = 1\n[ui]\ntheme = "high-contrast"\n[editor]\nwrap = true\n',
    );
    const events: ConfigChangeEvent[] = [];
    service.onDidChange((e) => events.push(e));
    await service.reload();
    expect(service.get("ui.theme")).toBe("high-contrast");
    expect(events[0]?.reason).toBe("reload");
    expect(events[0]?.changed).toEqual(["ui.theme", "editor.wrap"]);
  });

  test("setting the current value is a no-op for listeners", async () => {
    const service = await ConfigService.load(temp.dirs);
    let count = 0;
    service.onDidChange(() => count++);
    await service.set("ui.theme", "catppuccin-mocha");
    expect(count).toBe(0);
    service.dispose();
  });
});
