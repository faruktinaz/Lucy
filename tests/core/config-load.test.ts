import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configFilePath, loadConfig, parseConfigText } from "@/core/config/load";
import { defaultConfig } from "@/core/config/values";
import { makeTempDirs, type TempDirs } from "./helpers";

let temp: TempDirs;
beforeEach(async () => {
  temp = await makeTempDirs();
});
afterEach(async () => {
  await temp.cleanup();
});

async function writeConfig(text: string): Promise<void> {
  await mkdir(temp.dirs.config, { recursive: true });
  await writeFile(configFilePath(temp.dirs), text);
}

describe("loadConfig", () => {
  test("missing file gives defaults and creates nothing", async () => {
    const loaded = await loadConfig(temp.dirs);
    expect(loaded.source).toBe("defaults");
    expect(loaded.config).toEqual(defaultConfig());
    expect(loaded.problems).toEqual([]);
    expect(loaded.path).toBe(join(temp.dirs.config, "config.toml"));
    expect(await readdir(temp.root)).toEqual([]);
  });

  test("empty, whitespace-only and BOM-only files give defaults", async () => {
    for (const text of ["", "  \n\n", "﻿", "# only a comment\n"]) {
      await writeConfig(text);
      const loaded = await loadConfig(temp.dirs);
      expect(loaded.source).toBe("file");
      expect(loaded.config).toEqual(defaultConfig());
      expect(loaded.problems).toEqual([]);
    }
  });

  test("a syntax error gives defaults plus an error with its position", async () => {
    await writeConfig('version = 1\n[ui]\ntheme = "tokyo-night"\ndensity = \n');
    const loaded = await loadConfig(temp.dirs);
    expect(loaded.source).toBe("fallback");
    expect(loaded.config).toEqual(defaultConfig());
    expect(loaded.raw).toBeNull();
    expect(loaded.problems).toHaveLength(1);
    const [problem] = loaded.problems;
    expect(problem?.severity).toBe("error");
    expect(problem?.line).toBe(4);
    expect(problem?.column).toBeGreaterThan(0);
    expect(problem?.message).toContain("could not be parsed");
  });

  test("an unreadable file gives defaults plus an error, never a throw", async () => {
    await mkdir(join(temp.dirs.config, "config.toml"), { recursive: true });
    const loaded = await loadConfig(temp.dirs);
    expect(loaded.source).toBe("fallback");
    expect(loaded.problems[0]?.severity).toBe("error");
    expect(loaded.config).toEqual(defaultConfig());
  });

  test("a file without read permission gives defaults plus an error", async () => {
    if (process.getuid?.() === 0) return; // root ignores permissions
    await writeConfig('[ui]\ntheme = "tokyo-night"\n');
    await chmod(configFilePath(temp.dirs), 0o000);
    const loaded = await loadConfig(temp.dirs);
    expect(loaded.source).toBe("fallback");
    expect(loaded.problems[0]?.message).toContain("could not be read");
    await chmod(configFilePath(temp.dirs), 0o600);
  });
});

describe("per-key validation", () => {
  const text = [
    "version = 1",
    "[ui]",
    'theme = "bogus"',
    'density = "compact"',
    'accent = "#FF8800"',
    "[layout]",
    "sidebar_width = 500",
    "show_status_bar = false",
    "[editor]",
    "tab_width = 4.5",
    'external = ["code", "--wait"]',
    "[ai]",
    'executable = "/opt/claude\\u0000rm"',
    "[keybindings.bindings]",
    '"view.toggleSidebar" = ["ctrl+b", "ctrl+k b"]',
    '"file.quickOpen" = false',
    '"bad.entry" = 42',
    "",
  ].join("\n");

  test("one bad key never discards the file", () => {
    const loaded = parseConfigText(text);
    expect(loaded.source).toBe("file");
    expect(loaded.config.ui.density).toBe("compact");
    expect(loaded.config.ui.accent).toBe("#FF8800");
    expect(loaded.config.layout.showStatusBar).toBe(false);
    expect(loaded.config.editor.external).toEqual(["code", "--wait"]);
    expect(loaded.config.keybindings.bindings).toEqual({
      "view.toggleSidebar": ["ctrl+b", "ctrl+k b"],
      "file.quickOpen": false,
    });
  });

  test("invalid values fall back to their default with a warning naming the key", () => {
    const loaded = parseConfigText(text);
    expect(loaded.config.ui.theme).toBe("catppuccin-mocha");
    expect(loaded.config.layout.sidebarWidth).toBe(30);
    expect(loaded.config.editor.tabWidth).toBe(4);
    expect(loaded.config.ai.executable).toBe("");
    const byPath = new Map(loaded.problems.map((p) => [p.path, p]));
    expect(byPath.get("ui.theme")?.severity).toBe("warning");
    expect(byPath.get("ui.theme")?.message).toContain('"bogus"');
    expect(byPath.get("ui.theme")?.line).toBe(3);
    expect(byPath.get("layout.sidebar_width")?.message).toContain("16 to 80");
    expect(byPath.get("layout.sidebar_width")?.line).toBe(7);
    expect(byPath.get("editor.tab_width")).toBeDefined();
    expect(byPath.get("ai.executable")).toBeDefined();
    expect(byPath.get('keybindings.bindings."bad.entry"')?.line).toBe(17);
    expect(loaded.problems.every((p) => p.severity === "warning")).toBe(true);
  });

  test("a section that is not a table is reported once and defaulted", () => {
    const loaded = parseConfigText('ui = "dark"\n');
    expect(loaded.config.ui).toEqual(defaultConfig().ui);
    expect(loaded.problems.filter((p) => p.path === "ui")).toHaveLength(1);
  });

  test("named accents and hex accents are accepted, others are not", () => {
    expect(parseConfigText('[ui]\naccent = "purple"').config.ui.accent).toBe("purple");
    expect(parseConfigText('[ui]\naccent = "#abcdef"').config.ui.accent).toBe("#abcdef");
    expect(parseConfigText('[ui]\naccent = "#abc"').config.ui.accent).toBe("default");
    expect(parseConfigText('[ui]\naccent = "chartreuse"').problems[0]?.path).toBe("ui.accent");
  });

  test("editor.external rejects an empty argv", () => {
    const loaded = parseConfigText("[editor]\nexternal = []");
    expect(loaded.config.editor.external).toBe("auto");
    expect(loaded.problems[0]?.path).toBe("editor.external");
  });

  test("there is no telemetry setting", () => {
    expect(JSON.stringify(defaultConfig()).toLowerCase()).not.toContain("telemetry");
  });
});

describe("unknown keys", () => {
  test("are reported as warnings, with positions, and kept in raw", () => {
    const loaded = parseConfigText(
      'version = 1\nmystery = 3\n[ui]\ncolour = "red"\n[future]\nflag = true\n[editor]\n"weird key" = 1\n',
    );
    const unknown = loaded.problems.filter((p) => p.message.startsWith("Unknown setting"));
    expect(unknown.map((p) => [p.path, p.line])).toEqual([
      ["mystery", 2],
      ["ui.colour", 4],
      ["future", 5],
      ['editor."weird key"', 8],
    ]);
    expect(unknown.every((p) => p.severity === "warning")).toBe(true);
    expect(loaded.raw?.mystery).toBe(3);
    expect(loaded.raw?.future).toEqual({ flag: true });
  });
});

describe("versions and migration", () => {
  test("a newer version is a warning; known keys still apply", () => {
    const loaded = parseConfigText('version = 7\n[ui]\ntheme = "gruvbox-dark"\n[shiny]\nx = 1\n');
    expect(loaded.fileVersion).toBe(7);
    expect(loaded.config.ui.theme).toBe("gruvbox-dark");
    expect(loaded.problems.some((p) => p.path === "version" && p.message.includes("newer"))).toBe(true);
  });

  test("an invalid version is a warning and the file is read as current", () => {
    const loaded = parseConfigText('version = "one"\n[ui]\ntheme = "tokyo-night"\n');
    expect(loaded.config.ui.theme).toBe("tokyo-night");
    expect(loaded.problems[0]?.path).toBe("version");
  });

  test("the pre-versioned prototype format is migrated in memory", () => {
    const legacy = [
      'theme = "tokyo-night"',
      'icons = "nerd"',
      'sidebar = "right"',
      "line_numbers = false",
      'editor = "nvim"',
      "[keys]",
      '"file.quickOpen" = "ctrl+o"',
      "[claude]",
      'path = "/opt/bin/claude"',
      'args = ["--verbose"]',
      'model = "kept-as-unknown"',
      "",
    ].join("\n");
    const loaded = parseConfigText(legacy);
    expect(loaded.fileVersion).toBe(0);
    expect(loaded.config.ui.theme).toBe("tokyo-night");
    expect(loaded.config.ui.icons).toBe("nerd");
    expect(loaded.config.layout.sidebarSide).toBe("right");
    expect(loaded.config.editor.lineNumbers).toBe(false);
    expect(loaded.config.editor.external).toBe("nvim");
    expect(loaded.config.keybindings.bindings).toEqual({ "file.quickOpen": "ctrl+o" });
    expect(loaded.config.ai.executable).toBe("/opt/bin/claude");
    expect(loaded.config.ai.args).toEqual(["--verbose"]);
    const info = loaded.problems.find((p) => p.severity === "info");
    expect(info?.message).toContain("version 0 to 1");
    expect(loaded.raw?.version).toBe(1);
    expect(loaded.raw?.theme).toBeUndefined();
    // The one key the migration does not know stays visible as unknown.
    expect(loaded.problems.some((p) => p.path === "claude" && p.severity === "warning")).toBe(true);
  });

  test("when both spellings exist the new one wins", () => {
    const loaded = parseConfigText('theme = "tokyo-night"\n[ui]\ntheme = "gruvbox-dark"\n');
    expect(loaded.config.ui.theme).toBe("gruvbox-dark");
    expect(loaded.problems.find((p) => p.severity === "info")?.message).toContain('Dropped "theme"');
  });

  test("a v1-shaped file without a version loads silently", () => {
    const loaded = parseConfigText('[ui]\ntheme = "high-contrast"\n');
    expect(loaded.config.ui.theme).toBe("high-contrast");
    expect(loaded.problems).toEqual([]);
  });
});
