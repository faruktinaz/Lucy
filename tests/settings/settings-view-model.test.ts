import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { configFilePath } from "@/core/config/load";
import type { SettingPath } from "@/core/config/schema";
import { ConfigService } from "@/core/config/service";
import { resolveAppDirs } from "@/core/paths";
import {
  type SettingItemRow,
  type SettingsIntent,
  SettingsViewModel,
} from "@/features/settings/model/settings-view-model";
import { makeTempDirs, type TempDirs } from "../core/helpers";

let temp: TempDirs;
beforeEach(async () => {
  temp = await makeTempDirs();
});
afterEach(async () => {
  await temp.cleanup();
});

async function setup(configText?: string) {
  if (configText !== undefined) {
    await mkdir(temp.dirs.config, { recursive: true });
    await writeFile(configFilePath(temp.dirs), configText);
  }
  const config = await ConfigService.load(temp.dirs);
  const vm = new SettingsViewModel({ config, home: join(temp.root, "home") });
  return { config, vm };
}

const fileTable = async () => parse(await readFile(configFilePath(temp.dirs), "utf8"));
const item = (vm: SettingsViewModel, path: SettingPath) => vm.item(path) as SettingItemRow;

describe("rows", () => {
  test("category headers followed by items, generated from the schema", async () => {
    const { vm } = await setup();
    const rows = vm.state.rows;
    expect(rows[0]).toEqual({ type: "header", category: "Appearance", count: 6 });
    const headers = rows
      .filter((r) => r.type === "header")
      .map((r) => (r.type === "header" ? r.category : ""));
    expect(headers).toEqual([
      "Appearance",
      "Layout",
      "Editor",
      "Explorer",
      "Search",
      "Source Control",
      "AI",
      "Terminal",
      "Workspace",
      "Keyboard",
    ]);
    expect(rows.filter((r) => r.type === "item")).toHaveLength(44);
    expect(vm.visibleRows(0, 3).map((r) => r.type)).toEqual(["header", "item", "item"]);
  });

  test("an item carries everything the row needs", async () => {
    const { vm } = await setup();
    const width = item(vm, "layout.sidebarWidth");
    expect(width).toMatchObject({
      title: "Sidebar width",
      category: "Layout",
      configKey: "layout.sidebar_width",
      control: { kind: "number", min: 16, max: 80, unit: "columns" },
      value: 30,
      valueLabel: "30 columns",
      defaultLabel: "30 columns",
      modified: false,
      requiresRestart: false,
      livePreview: false,
      problem: null,
    });
    expect(item(vm, "ui.theme").livePreview).toBe(true);
    expect(item(vm, "ui.colorMode").requiresRestart).toBe(true);
  });

  test("search matches title, description and path; selection follows", async () => {
    const { vm } = await setup();
    vm.setQuery("sidebar");
    const items = vm.state.rows.filter((r): r is SettingItemRow => r.type === "item").map((r) => r.path);
    expect(items).toEqual(["layout.sidebarSide", "layout.sidebarWidth"]);
    expect(vm.state.selectedPath).toBe("layout.sidebarSide");
    vm.setQuery("network_timeout");
    expect(vm.state.rows.filter((r) => r.type === "item").map((r) => (r as SettingItemRow).path)).toEqual([
      "git.networkTimeoutSeconds",
    ]);
    vm.setQuery("PERMISSION nothing-like-this");
    expect(vm.state.rows).toEqual([]);
    expect(vm.state.selectedPath).toBeNull();
    vm.setQuery("");
    expect(vm.state.rows.length).toBeGreaterThan(44);
  });

  test("selection skips headers and stops at the ends", async () => {
    const { vm } = await setup();
    expect(vm.state.selectedPath).toBe("ui.theme");
    vm.moveSelection(-1);
    expect(vm.state.selectedPath).toBe("ui.theme");
    vm.moveSelection(6);
    expect(vm.state.selectedPath).toBe("layout.sidebarSide");
    expect(vm.state.rows[vm.state.selectedIndex]?.type).toBe("item");
    vm.select("search.engine");
    expect(vm.state.selectedPath).toBe("search.engine");
    vm.moveSelection(1000);
    expect(vm.state.selectedPath).toBe("keybindings.bindings");
  });
});

describe("edits for every control kind", () => {
  test("toggle persists and marks the row modified", async () => {
    const { vm } = await setup();
    expect(await vm.toggle("editor.wrap")).toBe(true);
    expect(item(vm, "editor.wrap")).toMatchObject({ value: true, valueLabel: "On", modified: true });
    expect(await fileTable()).toEqual({ version: 1, editor: { wrap: true } });
    expect(await vm.toggle("editor.wrap")).toBe(true);
    expect(await fileTable()).toEqual({ version: 1 });
  });

  test("toggle on a non-boolean is a visible error", async () => {
    const { vm } = await setup();
    expect(await vm.toggle("ui.theme")).toBe(false);
    expect(vm.state.message?.severity).toBe("error");
  });

  test("select: cycle both ways and pick", async () => {
    const { vm } = await setup();
    await vm.cycleOption("ui.density");
    expect(item(vm, "ui.density").value).toBe("compact");
    await vm.cycleOption("ui.density");
    expect(item(vm, "ui.density").value).toBe("comfortable");
    await vm.cycleOption("ui.theme", -1);
    expect(item(vm, "ui.theme").value).toBe("high-contrast");
    expect(await vm.pickOption("search.engine", "git-grep")).toBe(true);
    expect(item(vm, "search.engine").valueLabel).toBe("git grep");
    expect(await vm.pickOption("search.engine", "grep-o-matic")).toBe(false);
    expect(vm.state.message?.text).toContain("not an option");
  });

  test("number edit with live validation", async () => {
    const { vm } = await setup();
    await vm.beginEdit("layout.sidebarWidth");
    expect(vm.state.edit).toMatchObject({ kind: "number", draft: "30", error: null });
    vm.updateEdit("5");
    expect(vm.state.edit?.error).toBe("Expected a whole number from 16 to 80 columns");
    vm.updateEdit("abc");
    expect(vm.state.edit?.error).toBe("Enter a whole number");
    expect(await vm.commitEdit()).toBe(false);
    expect(vm.state.edit).not.toBeNull();
    expect(vm.state.message?.severity).toBe("error");
    vm.updateEdit("44");
    expect(vm.state.edit?.error).toBeNull();
    expect(await vm.commitEdit()).toBe(true);
    expect(vm.state.edit).toBeNull();
    expect(await fileTable()).toEqual({ version: 1, layout: { sidebar_width: 44 } });
  });

  test("text edit, cancel leaves the value alone", async () => {
    const { vm } = await setup();
    await vm.beginEdit("ai.executable");
    vm.updateEdit("/opt/bin/claude");
    vm.cancelEdit();
    expect(item(vm, "ai.executable").value).toBe("");
    await vm.beginEdit("ai.executable");
    vm.updateEdit("bad\0path");
    expect(vm.state.edit?.error).toBe("Must not contain NUL characters");
    vm.updateEdit("/opt/bin/claude");
    expect(await vm.commitEdit()).toBe(true);
    expect(item(vm, "ai.executable").value).toBe("/opt/bin/claude");
  });

  test("select-or-color: named accents and a custom color", async () => {
    const { vm } = await setup();
    await vm.cycleOption("ui.accent");
    expect(item(vm, "ui.accent").value).toBe("blue");
    await vm.beginEdit("ui.accent");
    expect(vm.state.edit).toMatchObject({ kind: "color", draft: "#" });
    vm.updateEdit("#12345");
    expect(vm.state.edit?.error).toBe("Enter a color as #rrggbb");
    vm.updateEdit("#AbCdEf");
    expect(await vm.commitEdit()).toBe(true);
    expect(item(vm, "ui.accent")).toMatchObject({ value: "#abcdef", valueLabel: "#abcdef" });
    // Cycling from a custom color goes back to the first named option.
    await vm.cycleOption("ui.accent");
    expect(item(vm, "ui.accent").value).toBe("default");
  });

  test("select-or-command: a custom argv entered as one line", async () => {
    const { vm } = await setup();
    await vm.beginEdit("editor.external");
    vm.updateEdit('code --wait "My Workspace');
    expect(vm.state.edit?.error).toBe("Missing closing double quote");
    vm.updateEdit('code --wait "My Workspace"');
    expect(await vm.commitEdit()).toBe(true);
    expect(item(vm, "editor.external")).toMatchObject({
      value: ["code", "--wait", "My Workspace"],
      valueLabel: 'code --wait "My Workspace"',
    });
    expect(await fileTable()).toEqual({
      version: 1,
      editor: { external: ["code", "--wait", "My Workspace"] },
    });
    await vm.pickOption("editor.external", "nvim");
    expect(item(vm, "editor.external").value).toBe("nvim");
  });

  test("string list: add, edit and remove entries", async () => {
    const { vm } = await setup();
    await vm.beginAddEntry("explorer.exclude");
    vm.updateEdit("");
    expect(vm.state.edit?.error).toBe("An entry cannot be empty");
    vm.updateEdit("node_modules");
    expect(await vm.commitEdit()).toBe(true);
    expect(item(vm, "explorer.exclude").value).toEqual([".git", ".DS_Store", "node_modules"]);
    expect(vm.beginEditEntry("explorer.exclude", 2)).toBe(true);
    expect(vm.state.edit?.draft).toBe("node_modules");
    vm.updateEdit("dist");
    await vm.commitEdit();
    expect(await vm.removeEntry("explorer.exclude", 1)).toBe(true);
    expect(item(vm, "explorer.exclude").value).toEqual([".git", "dist"]);
    expect(vm.beginEditEntry("explorer.exclude", 9)).toBe(false);
    expect(await vm.removeEntry("explorer.exclude", 9)).toBe(false);
  });

  test("reset restores the default and removes the key from the file", async () => {
    const { vm } = await setup();
    await vm.pickOption("ui.theme", "gruvbox-dark");
    await vm.toggle("editor.wrap");
    expect(await vm.reset("ui.theme")).toBe(true);
    expect(item(vm, "ui.theme")).toMatchObject({ value: "catppuccin-mocha", modified: false });
    expect(await fileTable()).toEqual({ version: 1, editor: { wrap: true } });
  });

  test("activate does the natural thing per control", async () => {
    const { vm } = await setup();
    const intents: SettingsIntent[] = [];
    vm.onIntent((i) => intents.push(i));
    await vm.activate("editor.wrap");
    expect(item(vm, "editor.wrap").value).toBe(true);
    await vm.activate("ui.density");
    expect(item(vm, "ui.density").value).toBe("compact");
    await vm.activate("layout.sidebarWidth");
    expect(vm.state.edit?.kind).toBe("number");
    vm.cancelEdit();
    await vm.activate("explorer.exclude");
    expect(vm.state.edit?.kind).toBe("list-entry");
    vm.cancelEdit();
    await vm.activate("keybindings.bindings");
    expect(intents).toEqual([{ kind: "open-keybindings" }]);
  });
});

describe("persistence, preview and restart", () => {
  test("every save backs up the previous file", async () => {
    const { vm } = await setup();
    await vm.toggle("editor.wrap");
    await vm.toggle("editor.lineNumbers");
    expect(await readFile(`${configFilePath(temp.dirs)}.bak`, "utf8")).toContain("wrap = true");
    expect(await readdir(join(temp.dirs.config, "backups"))).toHaveLength(1);
  });

  test("live preview applies immediately, writes nothing until committed", async () => {
    const { config, vm } = await setup();
    expect(await vm.previewOption("ui.theme", "tokyo-night")).toBe(true);
    expect(config.get("ui.theme")).toBe("tokyo-night");
    expect(await vm.previewOption("ui.theme", "gruvbox-dark")).toBe(true);
    expect(vm.state.preview).toEqual({ path: "ui.theme", original: "catppuccin-mocha" });
    expect(await Bun.file(configFilePath(temp.dirs)).exists()).toBe(false);
    expect(await vm.cancelPreview()).toBe(true);
    expect(config.get("ui.theme")).toBe("catppuccin-mocha");
    await vm.previewOption("ui.theme", "high-contrast");
    expect(await vm.commitPreview()).toBe(true);
    expect(await fileTable()).toEqual({ version: 1, ui: { theme: "high-contrast" } });
    expect(vm.state.preview).toBeNull();
  });

  test("previewing another setting first restores the previous preview", async () => {
    const { config, vm } = await setup();
    await vm.previewOption("ui.theme", "tokyo-night");
    await vm.previewOption("ui.density", "compact");
    expect(config.get("ui.theme")).toBe("catppuccin-mocha");
    expect(vm.state.preview).toEqual({ path: "ui.density", original: "comfortable" });
  });

  test("settings without live preview refuse it", async () => {
    const { vm } = await setup();
    expect(await vm.previewOption("search.engine", "builtin")).toBe(false);
    expect(vm.state.message?.severity).toBe("error");
  });

  test("restart-only settings say so and are listed as pending", async () => {
    const { vm } = await setup();
    await vm.pickOption("ui.colorMode", "256");
    expect(vm.state.message).toMatchObject({ severity: "info" });
    expect(vm.state.message?.text).toContain("restarting Lucy");
    expect(vm.state.restartPending).toEqual(["ui.colorMode"]);
  });

  test("a save that fails is a visible error, never silent", async () => {
    await writeFile(join(temp.root, "not-a-dir"), "x");
    const dirs = resolveAppDirs({ LUCY_CONFIG_DIR: join(temp.root, "not-a-dir", "config"), HOME: temp.root });
    const config = await ConfigService.load(dirs);
    const vm = new SettingsViewModel({ config });
    expect(await vm.toggle("editor.wrap")).toBe(false);
    expect(vm.state.message?.severity).toBe("error");
    expect(vm.state.message?.text).toContain("this session only");
    expect(vm.state.saving).toBe(false);
  });

  test("external reloads refresh the rows", async () => {
    const { config, vm } = await setup();
    await mkdir(temp.dirs.config, { recursive: true });
    await writeFile(configFilePath(temp.dirs), '[ui]\ntheme = "tokyo-night"\n');
    await config.reload();
    expect(item(vm, "ui.theme").value).toBe("tokyo-night");
    vm.dispose();
  });
});

describe("config file problems and the file statement", () => {
  test("problems are listed with locations and attached to their rows", async () => {
    const { vm } = await setup('[ui]\ntheme = "dracula"\ncolour = "red"\n');
    expect(vm.state.problems.map((p) => [p.severity, p.key, p.location])).toEqual([
      ["warning", "ui.theme", "config.toml:2:1"],
      ["warning", "ui.colour", "config.toml:3:1"],
    ]);
    expect(item(vm, "ui.theme").problem).toContain("dracula");
    expect(vm.state.file.hasSyntaxError).toBe(false);
  });

  test("open-config-file intent carries the path and position", async () => {
    const { vm } = await setup('[ui]\ntheme = "dracula"\n');
    const intents: SettingsIntent[] = [];
    vm.onIntent((i) => intents.push(i));
    const problem = vm.state.problems[0];
    vm.openConfigFile(problem);
    vm.openConfigFile();
    expect(intents).toEqual([
      { kind: "open-config-file", path: configFilePath(temp.dirs), line: 2, column: 1 },
      { kind: "open-config-file", path: configFilePath(temp.dirs), line: undefined, column: undefined },
    ]);
  });

  test("a syntax error is explained, and saving backs the broken file up first", async () => {
    const { vm } = await setup('[ui\ntheme = "tokyo-night"\n');
    expect(vm.state.file.hasSyntaxError).toBe(true);
    expect(vm.state.file.saveNote).toContain("syntax error");
    expect(vm.state.file.saveNote).toContain("config.toml.broken-");
    expect(vm.state.problems[0]?.severity).toBe("error");
    expect(await vm.toggle("editor.wrap")).toBe(true);
    expect(vm.state.message?.text).toContain("could not be parsed");
    const broken = (await readdir(temp.dirs.config)).find((name) => name.startsWith("config.toml.broken-"));
    expect(broken).toBeDefined();
    expect(await readFile(join(temp.dirs.config, broken ?? ""), "utf8")).toBe('[ui\ntheme = "tokyo-night"\n');
    expect(vm.state.file.hasSyntaxError).toBe(false);
    expect(vm.state.problems).toEqual([]);
  });

  test("the statement names the file and promises not to touch other tools", async () => {
    const { vm } = await setup();
    expect(vm.state.file.path).toBe(configFilePath(temp.dirs));
    expect(vm.state.file.statement).toContain(vm.state.file.displayPath);
    expect(vm.state.file.statement).toContain("never edits other tools' configuration");
  });

  test("the display path uses ~ for the home directory", async () => {
    const dirs = resolveAppDirs({ HOME: temp.root, LUCY_CONFIG_DIR: join(temp.root, ".config", "lucy") });
    const vm = new SettingsViewModel({ config: await ConfigService.load(dirs), home: temp.root });
    expect(vm.state.file.displayPath).toBe("~/.config/lucy/config.toml");
  });
});
