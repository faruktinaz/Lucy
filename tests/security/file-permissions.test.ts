/**
 * Item: Lucy's own files are private.
 *
 * `config.toml` (new), every config backup and the log file are 0600; directories Lucy creates
 * are 0700. Directories that already exist (such as `~/.config` itself) keep their mode, and an
 * existing `config.toml` keeps the mode the user gave it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { chmod, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "@/core/config/atomic-write";
import { BACKUP_DIR_NAME, saveConfig } from "@/core/config/save";
import { defaultConfig, withSetting } from "@/core/config/values";
import { configureLogger, flushLogs, log } from "@/core/log";

let root: string;
let previousUmask: number;

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "lucy-modes-")));
  // The usual umask: without explicit modes, files would be 0644 and directories 0755.
  previousUmask = process.umask(0o022);
  await chmod(root, 0o755);
});

afterEach(() => {
  process.umask(previousUmask);
  configureLogger({});
  rmSync(root, { recursive: true, force: true });
});

describe("config files", () => {
  test("a new config.toml is 0600 and the directories Lucy creates are 0700", async () => {
    // `xdg` stands for ~/.config: it exists and must keep its mode.
    const xdg = join(root, "xdg");
    await mkdir(xdg, { mode: 0o755 });
    const dirs = { config: join(xdg, "lucy") };
    const first = await saveConfig(dirs, withSetting(defaultConfig(), "layout.sidebarWidth", 40));
    expect(await mode(first.path)).toBe(0o600);
    expect(await mode(dirs.config)).toBe(0o700);
    expect(await mode(xdg)).toBe(0o755);
    expect(await mode(root)).toBe(0o755);
  });

  test("backups (.bak, timestamped, broken) are 0600 even when an old backup was 0644", async () => {
    const dirs = { config: join(root, "lucy") };
    await mkdir(dirs.config, { mode: 0o755 });
    // A file that does not parse, and a world-readable backup from an older version.
    await writeFile(join(dirs.config, "config.toml"), "this is = = not toml\n", { mode: 0o644 });
    await writeFile(join(dirs.config, "config.toml.bak"), "old\n", { mode: 0o644 });
    const result = await saveConfig(dirs, withSetting(defaultConfig(), "layout.sidebarWidth", 41));
    expect(result.backupPath).toBeDefined();
    expect(result.timestampedBackupPath).toBeDefined();
    expect(result.brokenBackupPath).toBeDefined();
    for (const path of [result.backupPath, result.timestampedBackupPath, result.brokenBackupPath]) {
      expect(await mode(path as string)).toBe(0o600);
    }
    expect(await mode(join(dirs.config, BACKUP_DIR_NAME))).toBe(0o700);
    // The existing config.toml keeps the mode its owner chose; the config dir is not chmodded.
    expect(await mode(result.path)).toBe(0o644);
    expect(await mode(dirs.config)).toBe(0o755);
    expect((await readdir(dirs.config)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("writeFileAtomic creates missing ancestors 0700 and never changes existing ones", async () => {
    const existing = join(root, "existing");
    await mkdir(existing, { mode: 0o751 });
    const target = join(existing, "new-a", "new-b", "state.json");
    await writeFileAtomic(target, "{}", { mode: 0o600 });
    expect(await mode(existing)).toBe(0o751);
    expect(await mode(join(existing, "new-a"))).toBe(0o700);
    expect(await mode(join(existing, "new-a", "new-b"))).toBe(0o700);
    expect(await mode(target)).toBe(0o600);
  });
});

describe("log file", () => {
  test("the log file is created 0600 in a 0700 directory", async () => {
    const state = join(root, "state");
    await mkdir(state, { mode: 0o755 });
    const file = join(state, "logs", "lucy.log");
    configureLogger({ file, level: "info" });
    log.info("first line");
    await flushLogs();
    log.info("second line");
    await flushLogs();
    expect(await mode(file)).toBe(0o600);
    expect(await mode(join(state, "logs"))).toBe(0o700);
    expect(await mode(state)).toBe(0o755);
    expect((await Bun.file(file).text()).split("\n").filter(Boolean)).toHaveLength(2);
  });
});
