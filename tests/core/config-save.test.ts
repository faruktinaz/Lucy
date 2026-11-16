import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, readdir, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { writeFileAtomic } from "@/core/config/atomic-write";
import { configFilePath, loadConfig, parseConfigText } from "@/core/config/load";
import { BACKUP_DIR_NAME, CONFIG_HEADER, saveConfig, serializeConfig } from "@/core/config/save";
import { defaultConfig, withSetting } from "@/core/config/values";
import { makeTempDirs, type TempDirs } from "./helpers";

let temp: TempDirs;
beforeEach(async () => {
  temp = await makeTempDirs();
});
afterEach(async () => {
  await temp.cleanup();
});

const read = (path: string) => readFile(path, "utf8");

function clock(start = Date.UTC(2026, 10, 16, 12, 0, 0)) {
  let t = start;
  return () => {
    t += 1000;
    return new Date(t);
  };
}

describe("serializeConfig", () => {
  test("defaults produce only the header and the version", () => {
    const { text } = serializeConfig(defaultConfig());
    expect(text.startsWith(CONFIG_HEADER)).toBe(true);
    expect(parse(text)).toEqual({ version: 1 });
    expect(text).toContain("Comments are not kept");
  });

  test("writes only keys that differ from the defaults, in snake_case", () => {
    let config = withSetting(defaultConfig(), "layout.sidebarWidth", 40);
    config = withSetting(config, "ui.colorMode", "256");
    config = withSetting(config, "keybindings.bindings", { "view.toggleSidebar": ["ctrl+b", "ctrl+k b"] });
    expect(parse(serializeConfig(config).text)).toEqual({
      version: 1,
      ui: { color_mode: "256" },
      layout: { sidebar_width: 40 },
      keybindings: { bindings: { "view.toggleSidebar": ["ctrl+b", "ctrl+k b"] } },
    });
  });

  test("preserves unknown keys and keeps top-level scalars before tables", () => {
    const loaded = parseConfigText('[future]\nflag = true\n[ui]\ncolour = "red"\n');
    const raw = { ...loaded.raw, mystery: 3 };
    const { text } = serializeConfig(withSetting(loaded.config, "ui.theme", "tokyo-night"), raw);
    expect(parse(text)).toEqual({
      version: 1,
      mystery: 3,
      ui: { colour: "red", theme: "tokyo-night" },
      future: { flag: true },
    });
  });

  test("keeps invalid values the user wrote instead of silently dropping them", () => {
    const loaded = parseConfigText('[ui]\ntheme = "dracula"\n[keybindings.bindings]\n"bad.entry" = 42\n');
    const { text } = serializeConfig(withSetting(loaded.config, "ui.density", "compact"), loaded.raw);
    const table = parse(text) as {
      ui: Record<string, unknown>;
      keybindings: { bindings: Record<string, unknown> };
    };
    expect(table.ui).toEqual({ theme: "dracula", density: "compact" });
    expect(table.keybindings.bindings).toEqual({ "bad.entry": 42 });
  });

  test("a value set back to its default disappears from the file", () => {
    const loaded = parseConfigText('[ui]\ntheme = "tokyo-night"\n');
    const { text } = serializeConfig(withSetting(loaded.config, "ui.theme", "catppuccin-mocha"), loaded.raw);
    expect(parse(text)).toEqual({ version: 1 });
  });

  test("a migrated file is written in the new format", () => {
    const loaded = parseConfigText('theme = "tokyo-night"\neditor = "hx"\n[keys]\n"app.quit" = "ctrl+k q"\n');
    expect(parse(serializeConfig(loaded.config, loaded.raw).text)).toEqual({
      version: 1,
      ui: { theme: "tokyo-night" },
      editor: { external: "hx" },
      keybindings: { bindings: { "app.quit": "ctrl+k q" } },
    });
  });

  test("round trip: saved text loads back to the same config without problems", () => {
    let config = withSetting(defaultConfig(), "explorer.exclude", ["node_modules", "*.log"]);
    config = withSetting(config, "editor.external", ["code", "--wait"]);
    config = withSetting(config, "ui.accent", "#123456");
    const reloaded = parseConfigText(serializeConfig(config).text);
    expect(reloaded.config).toEqual(config);
    expect(reloaded.problems).toEqual([]);
  });
});

describe("saveConfig", () => {
  test("creates the directory, writes atomically and makes no backup the first time", async () => {
    const config = withSetting(defaultConfig(), "ui.theme", "gruvbox-dark");
    const result = await saveConfig(temp.dirs, config);
    expect(result.written).toBe(true);
    expect(result.backupPath).toBeUndefined();
    expect((await loadConfig(temp.dirs)).config.ui.theme).toBe("gruvbox-dark");
    expect(await readdir(temp.dirs.config)).toEqual(["config.toml"]);
  });

  test("backs up the previous file to .bak and a timestamped copy", async () => {
    const now = clock();
    await saveConfig(temp.dirs, withSetting(defaultConfig(), "ui.theme", "tokyo-night"), { now });
    const first = await read(configFilePath(temp.dirs));
    const result = await saveConfig(temp.dirs, withSetting(defaultConfig(), "ui.theme", "gruvbox-dark"), {
      now,
    });
    expect(result.backupPath).toBe(`${configFilePath(temp.dirs)}.bak`);
    expect(await read(result.backupPath ?? "")).toBe(first);
    // The clock is only read when there is something to back up.
    expect(result.timestampedBackupPath).toMatch(/backups\/config-2026-11-16T12-00-01-000Z\.toml$/);
    expect(await read(result.timestampedBackupPath ?? "")).toBe(first);
    expect(result.brokenBackupPath).toBeUndefined();
  });

  test("prunes timestamped backups to the newest few", async () => {
    const now = clock();
    for (let width = 20; width < 30; width++) {
      await saveConfig(temp.dirs, withSetting(defaultConfig(), "layout.sidebarWidth", width), {
        now,
        maxBackups: 3,
      });
    }
    const backups = (await readdir(join(temp.dirs.config, BACKUP_DIR_NAME))).sort();
    expect(backups).toHaveLength(3);
    // The newest backup holds the second-to-last save.
    expect(await read(join(temp.dirs.config, BACKUP_DIR_NAME, backups[2] ?? ""))).toContain(
      "sidebar_width = 28",
    );
  });

  test("unchanged content is not rewritten and not backed up", async () => {
    const config = withSetting(defaultConfig(), "ui.density", "compact");
    await saveConfig(temp.dirs, config);
    const result = await saveConfig(temp.dirs, config);
    expect(result.written).toBe(false);
    expect(await readdir(temp.dirs.config)).toEqual(["config.toml"]);
  });

  test("a syntactically broken file is kept aside before it is overwritten", async () => {
    await mkdir(temp.dirs.config, { recursive: true });
    const broken = '[ui\ntheme = "tokyo-night"\n';
    await writeFile(configFilePath(temp.dirs), broken);
    const loaded = await loadConfig(temp.dirs);
    expect(loaded.source).toBe("fallback");
    const result = await saveConfig(temp.dirs, withSetting(loaded.config, "ui.density", "compact"), {
      raw: loaded.raw,
      now: clock(),
    });
    expect(result.brokenBackupPath).toMatch(/config\.toml\.broken-2026-11-16T12-00-01-000Z$/);
    expect(await read(result.brokenBackupPath ?? "")).toBe(broken);
    expect(await read(result.backupPath ?? "")).toBe(broken);
    expect((await loadConfig(temp.dirs)).source).toBe("file");
  });

  test("unknown keys survive a save and reload", async () => {
    await mkdir(temp.dirs.config, { recursive: true });
    await writeFile(
      configFilePath(temp.dirs),
      'mystery = 3\n[ui]\ncolour = "red"\n[plugins.x]\nenabled = true\n',
    );
    const loaded = await loadConfig(temp.dirs);
    await saveConfig(temp.dirs, withSetting(loaded.config, "ui.icons", "ascii"), { raw: loaded.raw });
    const again = await loadConfig(temp.dirs);
    expect(again.config.ui.icons).toBe("ascii");
    expect(again.raw?.mystery).toBe(3);
    expect(again.raw?.plugins).toEqual({ x: { enabled: true } });
    expect(again.problems.map((p) => p.path).sort()).toEqual(["mystery", "plugins", "ui.colour"]);
  });

  test("a symlinked config file stays a symlink and keeps its mode", async () => {
    const dotfiles = join(temp.root, "dotfiles");
    await mkdir(dotfiles, { recursive: true });
    await mkdir(temp.dirs.config, { recursive: true });
    const target = join(dotfiles, "lucy.toml");
    await writeFile(target, "version = 1\n", { mode: 0o600 });
    await symlink(target, configFilePath(temp.dirs));
    await saveConfig(temp.dirs, withSetting(defaultConfig(), "ui.theme", "high-contrast"));
    expect((await lstat(configFilePath(temp.dirs))).isSymbolicLink()).toBe(true);
    expect(await readlink(configFilePath(temp.dirs))).toBe(target);
    expect(await read(target)).toContain('theme = "high-contrast"');
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });
});

describe("writeFileAtomic", () => {
  test("leaves no temp files and replaces content in one step", async () => {
    const path = join(temp.root, "nested", "file.json");
    await writeFileAtomic(path, "one");
    await writeFileAtomic(path, "two");
    expect(await read(path)).toBe("two");
    expect(await readdir(join(temp.root, "nested"))).toEqual(["file.json"]);
  });

  test("applies an explicit mode to new files despite the umask", async () => {
    const path = join(temp.root, "private.json");
    await writeFileAtomic(path, "{}", { mode: 0o600 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("fails with a LucyError and cleans up when the directory cannot be created", async () => {
    const blocker = join(temp.root, "blocker");
    await writeFile(blocker, "x");
    await expect(writeFileAtomic(join(blocker, "child", "file"), "x")).rejects.toMatchObject({
      name: "LucyError",
    });
  });
});
