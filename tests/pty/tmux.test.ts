/**
 * The tmux persistence backend against real tmux, on a private socket inside a temporary
 * TMUX_TMPDIR (never the user's server). Skipped when tmux is not installed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectTmux, type PtyProcess, parseTmuxVersion, spawnPty, TmuxBackend } from "@/adapters/pty";
import { collect, waitFor } from "./helpers";

const tmux = detectTmux();
const describeTmux = tmux.ok ? describe : describe.skip;

let dir = "";
let backend: TmuxBackend;
let previousTmpdir: string | undefined;
const live: PtyProcess[] = [];

function sh(...args: string[]): string {
  const result = Bun.spawnSync(backend.argv(...args), {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "ignore",
  });
  return result.stdout.toString().trim();
}

beforeAll(async () => {
  if (!tmux.ok) return;
  dir = mkdtempSync(join(tmpdir(), "lucy-tmux-test-"));
  previousTmpdir = process.env.TMUX_TMPDIR;
  process.env.TMUX_TMPDIR = dir;
  backend = new TmuxBackend({
    executable: tmux.executable,
    socketName: "lucy-test",
    configPath: join(dir, "tmux.conf"),
    spawn: spawnPty,
  });
  await backend.prepare();
  // A probe that enables modifyOtherKeys (as Claude Code does) and reports what it receives.
  writeFileSync(
    join(dir, "probe.ts"),
    `process.stdin.setRawMode(true);
process.stdout.write("\\x1b[>4;2mREADY\\r\\n");
process.stdin.on("data", (d) => {
  const text = [...d].map((b) => (b > 0x20 && b < 0x7f ? String.fromCharCode(b) : "<" + b.toString(16) + ">")).join("");
  process.stdout.write("IN:" + text + "\\r\\n");
});`,
  );
});

afterAll(() => {
  if (!tmux.ok) return;
  for (const pty of live) pty.dispose();
  Bun.spawnSync(backend.argv("kill-server"), { env: { ...process.env }, stdout: "ignore", stderr: "ignore" });
  if (previousTmpdir === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = previousTmpdir;
  rmSync(dir, { recursive: true, force: true });
});

function start(name: string, argv: string[], meta: Record<string, string> = {}): PtyProcess {
  const pty = backend.spawner({ name, argv, cwd: dir, meta })({ argv: [], cols: 80, rows: 24 });
  live.push(pty);
  return pty;
}

test("parses tmux versions", () => {
  expect(parseTmuxVersion("tmux 3.7b")).toEqual({ major: 3, minor: 7 });
  expect(parseTmuxVersion("tmux next-3.8")).toEqual({ major: 3, minor: 8 });
  expect(parseTmuxVersion("tmux master")).toBeNull();
});

describeTmux("tmux backend (real tmux, private socket)", () => {
  test("detach by disposing the client, reattach: same screen, process still running", async () => {
    const first = start("lucy-t-keep", ["/bin/sh", "-c", "echo started-here; exec sleep 600"], {
      kind: "terminal",
    });
    const out = collect(first);
    expect(await waitFor(() => out.text().includes("started-here"))).toBe(true);
    first.dispose();
    await first.exited;
    const sessions = await backend.list("lucy-t-");
    expect(sessions.map((session) => [session.name, session.dead, session.meta.kind])).toEqual([
      ["lucy-t-keep", false, "terminal"],
    ]);
    const second = start("lucy-t-keep", ["/bin/false"]);
    const again = collect(second);
    expect(await waitFor(() => again.text().includes("started-here"))).toBe(true);
    expect(sh("display-message", "-p", "-t", "lucy-t-keep", "#{pane_current_command}")).toBe("sleep");
    // Kill ends the tmux session, not just the client.
    expect(await second.kill()).toEqual({ code: null, signal: "SIGHUP" });
    expect(await backend.list("lucy-t-keep")).toEqual([]);
  });

  test("the program's exit status is reported; spawning again starts it over", async () => {
    const pty = start("lucy-t-exit", ["/bin/sh", "-c", "sleep 0.2; exit 7"]);
    expect(await pty.exited).toEqual({ code: 7, signal: null });
    const [session] = await backend.list("lucy-t-exit");
    expect(session?.dead).toBe(true);
    expect(session?.exit).toEqual({ code: 7, signal: null });
    const fresh = start("lucy-t-exit", ["/bin/sh", "-c", "echo fresh-run; exec sleep 600"]);
    const out = collect(fresh);
    expect(await waitFor(() => out.text().includes("fresh-run"))).toBe(true);
    await fresh.kill();
  });

  test("keys pass through: Ctrl+R, Ctrl+C, Escape, Shift+Enter (extended keys)", async () => {
    const pty = start("lucy-t-keys", ["bun", join(dir, "probe.ts")]);
    const out = collect(pty);
    expect(await waitFor(() => out.text().includes("READY"), 8000)).toBe(true);
    const received = () =>
      out
        .text()
        .split("\r\n")
        .filter((line) => line.startsWith("IN:"));
    const send = async (bytes: string, expected: RegExp) => {
      const before = received().length;
      pty.write(bytes);
      expect(await waitFor(() => received().length > before)).toBe(true);
      expect(received().at(-1)).toMatch(expected);
    };
    await send("\x12", /^IN:(<12>|<1b>\[114;5u)$/);
    await send("\x03", /^IN:(<3>|<1b>\[99;5u)$/);
    await send("\x1b", /^IN:<1b>$/);
    // What Lucy's emulator sends for Shift+Enter once tmux asked it for modifyOtherKeys.
    await send("\x1b[27;2;13~", /^IN:<1b>\[13;2u$/);
    await pty.kill();
  }, 30_000);

  test("resizing the client resizes the session", async () => {
    const pty = start("lucy-t-size", ["/bin/sh", "-c", "exec sleep 600"]);
    expect(
      await waitFor(
        () => sh("has-session", "-t", "lucy-t-size") === "" && sh("list-sessions").includes("lucy-t-size"),
      ),
    ).toBe(true);
    pty.resize(100, 30);
    expect(
      await waitFor(
        () =>
          sh("display-message", "-p", "-t", "lucy-t-size", "#{window_width}x#{window_height}") === "100x30",
      ),
    ).toBe(true);
    await pty.kill();
  });

  test("the generated configuration hides tmux and keeps history", async () => {
    // The server exits when it has no sessions: keep one while reading its options.
    const pty = start("lucy-t-conf", ["/bin/sh", "-c", "exec sleep 600"]);
    expect(await waitFor(() => sh("list-sessions").includes("lucy-t-conf"))).toBe(true);
    expect(sh("show-options", "-g", "-v", "status")).toBe("off");
    expect(sh("show-options", "-g", "-v", "prefix")).toBe("None");
    expect(sh("show-options", "-s", "-v", "escape-time")).toBe("0");
    expect(sh("show-options", "-g", "-v", "history-limit")).toBe("100000");
    expect(sh("list-keys", "-T", "prefix")).toBe("");
    await pty.kill();
  });
});
