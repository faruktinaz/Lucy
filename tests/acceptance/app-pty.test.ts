/**
 * End-to-end acceptance: the real `bin/lucy --demo` in a real PTY at 120x35, driven by the
 * bytes a terminal sends for each key. The outer terminal is emulated by OpenTUI's
 * `EmbeddedTerminalRenderable` (libghostty-vt): it turns the app's output into a screen we
 * can read, and its answers to the app's terminal queries are written back to the PTY, the
 * way a real terminal would answer them.
 *
 * Isolation: HOME, TMPDIR, XDG_* and LUCY_* point into one temp root, PATH holds only system
 * directories (so the real `claude` cannot start and the shell is plain `/bin/sh`), and the
 * test checks afterwards that nothing outside the temp root changed and no process survived.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { EmbeddedTerminalRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { isProcessAlive, listProcessesSync } from "@/adapters/pty/process-tree";

setDefaultTimeout(60_000);

const REPO = join(import.meta.dir, "..", "..");
const COLS = 120;
const ROWS = 35;

/** Key bytes as a legacy (non-kitty) terminal sends them. */
const KEY = {
  ctrlP: "\x10",
  ctrlK: "\x0b",
  ctrlQ: "\x11",
  leader: "\x1c",
  enter: "\r",
  down: "\x1b[B",
} as const;

const root = realpathSync(mkdtempSync(join(tmpdir(), "lucy-acceptance-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Real per-user locations Lucy (or OpenTUI) would write to without the overrides. */
function watchedPaths(): string[] {
  const home = homedir();
  return [
    join(home, ".config", "lucy"),
    join(home, ".local", "state", "lucy"),
    join(home, ".cache", "lucy"),
    join(home, ".local", "share", "opentui"),
    REPO,
    join(REPO, "examples", "demo-project"),
  ];
}

/** Existence and mtime: any file created or removed in a directory changes its mtime. */
function fingerprint(paths: readonly string[]): Record<string, number | null> {
  return Object.fromEntries(paths.map((path) => [path, existsSync(path) ? statSync(path).mtimeMs : null]));
}

function descendants(pid: number): number[] {
  const table = listProcessesSync() ?? [];
  const found: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const entry of table) {
      if (entry.ppid === parent && !entry.state.startsWith("Z")) {
        found.push(entry.pid);
        queue.push(entry.pid);
      }
    }
  }
  return found;
}

describe("lucy --demo in a real PTY", () => {
  test("quick open, source control diff, AI start screen, terminal, leader, Ctrl+Q", async () => {
    const dirs = {
      HOME: join(root, "home"),
      TMPDIR: join(root, "tmp"),
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_STATE_HOME: join(root, "xdg-state"),
      XDG_CACHE_HOME: join(root, "xdg-cache"),
      XDG_DATA_HOME: join(root, "xdg-data"),
      LUCY_CONFIG_DIR: join(root, "config"),
      LUCY_STATE_DIR: join(root, "state"),
      LUCY_CACHE_DIR: join(root, "cache"),
    };
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
    const before = fingerprint(watchedPaths());

    const setup = await createTestRenderer({ width: COLS, height: ROWS, exitOnCtrlC: false });
    const screen = new EmbeddedTerminalRenderable(setup.renderer, {
      cols: COLS,
      rows: ROWS,
      width: COLS,
      height: ROWS,
    });
    setup.renderer.root.add(screen);

    const started = performance.now();
    const child = Bun.spawn([process.execPath, "run", join(REPO, "bin", "lucy"), "--demo"], {
      cwd: dirs.HOME,
      env: {
        ...dirs,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        SHELL: "/bin/sh",
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        // A prompt no file in the demo contains, so the test sees the shell itself.
        PS1: "lucy-sh$ ",
      },
      terminal: {
        cols: COLS,
        rows: ROWS,
        data: (_terminal, bytes) => screen.write(new Uint8Array(bytes)),
      },
    });
    // Answers to the app's queries (DA1, DECRQM, colours) go back as if typed by the terminal.
    screen.onData = (bytes, source) => {
      if (source === "response") child.terminal?.write(bytes);
    };
    const killer = setTimeout(() => child.kill("SIGKILL"), 55_000);
    const send = (bytes: string) => child.terminal?.write(bytes);
    const text = () => screen.screen().text;
    const timings: string[] = [];
    let mark = performance.now();
    const waitFor = async (label: string, predicate: (screenText: string) => boolean, timeoutMs = 10_000) => {
      const deadline = performance.now() + timeoutMs;
      while (!predicate(text())) {
        if (performance.now() > deadline || child.exitCode !== null) {
          throw new Error(`Timed out waiting for ${label}. Screen:\n${text()}`);
        }
        await Bun.sleep(25);
      }
      timings.push(`${label} ${Math.round(performance.now() - mark)} ms`);
      mark = performance.now();
    };

    let childPids: number[] = [];
    try {
      await waitFor("first paint", (s) => s.includes("EXPLORER") && s.includes("Ctrl+P"), 20_000);

      // Quick Open: Ctrl+P, type a file name, Enter; the file's content appears.
      send(KEY.ctrlP);
      await waitFor("quick open", (s) => s.includes("Search files by name"));
      send("fuzzy.ts");
      await waitFor("quick open match", (s) => s.includes("fuzzy.ts") && s.includes("src/"));
      send(KEY.enter);
      await waitFor("file content", (s) => s.includes("export function"));

      // Source Control: Ctrl+K G focuses its list; Down selects the first group header and the
      // next Down its first file.
      send(`${KEY.ctrlK}g`);
      await waitFor("source control", (s) => s.includes("SOURCE CONTROL") && s.includes("STAGED CHANGES"));
      // The selected file row shows its inline actions (⇗ opens the file): that is how the test
      // sees the selection move before it presses Enter.
      const sidebarRow = (screenText: string, name: string) =>
        screenText
          .split("\n")
          .find((line) => line.slice(0, 34).includes(name))
          ?.slice(0, 34) ?? "";
      send(KEY.down);
      await waitFor("group selected", (s) => sidebarRow(s, "STAGED CHANGES").trimEnd().endsWith("-"));
      send(KEY.down);
      await waitFor("file selected", (s) => sidebarRow(s, "getting-started").includes("⇗"));
      send(KEY.enter);
      // The first staged file is a pure rename: no hunks, and the view says so.
      await waitFor("rename diff", (s) => s.includes("Renamed without content changes"));
      // Back to the list (Enter moved focus to the diff); the next file has real hunks.
      send(`${KEY.ctrlK}g`);
      send(KEY.down);
      await waitFor("next file selected", (s) => sidebarRow(s, "package.json").includes("⇗"));
      send(KEY.enter);
      await waitFor("diff", (s) => s.includes("@@") && s.includes("package.json"));

      // AI panel start screen (Ctrl+K A). PATH has no `claude`, so nothing can be started.
      send(`${KEY.ctrlK}a`);
      await waitFor("AI start screen", (s) => s.includes("Claude Code was not found"));

      // Terminal: Ctrl+K T opens a shell with focus; the echo output differs from the input.
      send(`${KEY.ctrlK}t`);
      await waitFor("shell prompt", (s) => s.includes("lucy-sh$"), 15_000);
      send("echo lucy-$((40+2))\r");
      await waitFor("echo output", (s) => s.split("\n").some((line) => line.trim().startsWith("lucy-42")));

      childPids = descendants(child.pid);
      expect(childPids.length).toBeGreaterThan(0);

      // Leader Ctrl+\ then K moves focus up out of the terminal; Ctrl+P then reaches Lucy again.
      send(`${KEY.leader}k`);
      send(KEY.ctrlP);
      await waitFor("leader left the terminal", (s) => s.includes("Search files by name"));
      // Escape closes Quick Open. Wait for it: an Escape directly followed by Ctrl+Q would be
      // read as Alt+Ctrl+Q.
      send("\x1b");
      await waitFor("quick open closed", (s) => !s.includes("Search files by name"));

      send(KEY.ctrlQ);
      const exitCode = await Promise.race([child.exited, Bun.sleep(10_000).then(() => "timeout" as const)]);
      timings.push(`quit ${Math.round(performance.now() - mark)} ms`);
      expect(exitCode).toBe(0);
    } finally {
      clearTimeout(killer);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      child.terminal?.close();
      setup.renderer.destroy();
      console.log(`[acceptance] ${timings.join(", ")}; total ${Math.round(performance.now() - started)} ms`);
    }

    // No process the app started outlives it.
    const survivors = childPids.filter((pid) => isProcessAlive(pid));
    expect(survivors).toEqual([]);

    // Nothing outside the temp root changed, and the demo cleaned up its own temp dirs.
    expect(fingerprint(watchedPaths())).toEqual(before);
    expect(readdirSync(dirs.TMPDIR).filter((name) => name.startsWith("lucy-"))).toEqual([]);
  });
});
