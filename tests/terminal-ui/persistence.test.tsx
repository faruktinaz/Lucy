/**
 * Session persistence through the whole app: terminals restored from a real private tmux
 * server (temporary TMUX_TMPDIR, killed afterwards), agent sessions coming back as ended
 * entries after a "reboot", and the fallback when tmux is missing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectTmux, spawnPty, type TmuxBackend } from "@/adapters/pty";
import { sessionPersistence } from "@/features/terminal";
import {
  DEMO_AGENT_TRANSCRIPT,
  fakeProvider,
  scriptedSpawn,
  shellScript,
} from "../ai-ui/support/scripted-pty";
import { createTestDirs, mountApp } from "../helpers/app";

const tmux = detectTmux();
let tmuxDir = "";
let previous: string | undefined;
const servers: TmuxBackend[] = [];

beforeAll(() => {
  tmuxDir = mkdtempSync(join(tmpdir(), "lucy-persist-"));
  previous = process.env.TMUX_TMPDIR;
  // Every tmux command and client in these tests uses a socket under this directory.
  process.env.TMUX_TMPDIR = tmuxDir;
});

afterAll(() => {
  for (const backend of servers) {
    Bun.spawnSync(backend.argv("kill-server"), {
      env: { ...process.env },
      stdout: "ignore",
      stderr: "ignore",
    });
  }
  if (previous === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = previous;
  rmSync(tmuxDir, { recursive: true, force: true });
});

async function waitFor(
  tui: { advance(ms: number): Promise<void> },
  predicate: () => boolean | Promise<boolean>,
  ms = 8000,
) {
  const deadline = performance.now() + ms;
  while (!(await predicate())) {
    if (performance.now() > deadline) throw new Error("Timed out waiting for a condition");
    await tui.advance(20);
  }
}

describe.skipIf(!tmux.ok)("terminals in a private tmux server", () => {
  test("two terminals survive quitting Lucy and are reattached in order on the next start", async () => {
    const root = mkdtempSync(join(process.env.LUCY_TEST_ROOT ?? tmpdir(), "persist-ws-"));
    const dirs = createTestDirs();
    const settings = {
      "terminal.persistence": "tmux" as const,
      "terminal.shell": "/bin/sh",
      "terminal.args": ["-c", "echo ready-$TMUX_PANE; exec sleep 600"],
    };
    const first = await mountApp({ workspace: { root }, dirs, ptySpawn: spawnPty, settings });
    const backend = sessionPersistence(first.ctx).backend();
    expect(backend).not.toBeNull();
    if (backend) servers.push(backend);
    await first.tui.act(() => first.ctx.commands.execute("terminal.toggle"));
    await first.tui.act(() => first.ctx.commands.execute("terminal.new"));
    await waitFor(first.tui, async () => (await sessionPersistence(first.ctx).list()).length === 2);
    await first.tui.waitForText("persistent");
    await first.dispose(); // quit: detaches, the sessions keep running

    const alive = await backend?.list("lucy-");
    expect(alive?.map((session) => [session.meta.number, session.dead])).toEqual([
      ["1", false],
      ["2", false],
    ]);

    const second = await mountApp({ workspace: { root }, dirs, ptySpawn: spawnPty, settings });
    await second.tui.waitForText("ready-%", { timeoutMs: 8000 });
    const frame = second.tui.frame();
    expect(frame).toContain("sh 2");
    expect(frame).toContain("persistent");
    // Killing a terminal in the UI ends its tmux session.
    void second.ctx.commands.execute("terminal.kill");
    await waitFor(second.tui, () => second.ctx.dialogs.request !== null);
    await second.tui.press("tab");
    await second.tui.press("enter");
    await waitFor(second.tui, async () => ((await backend?.list("lucy-")) ?? []).length === 1);
    await second.dispose();
  }, 40_000);
});

describe("agent sessions and fallback", () => {
  test("after a reboot an agent session comes back ended, offering Continue session", async () => {
    if (!tmux.ok) return;
    const root = mkdtempSync(join(process.env.LUCY_TEST_ROOT ?? tmpdir(), "persist-ai-"));
    const dirs = createTestDirs();
    const mount = () => {
      const spawn = scriptedSpawn(() => ({ start: DEMO_AGENT_TRANSCRIPT }));
      const provider = fakeProvider();
      return mountApp({
        workspace: { root },
        dirs,
        ptySpawn: spawn.spawn,
        agentProviders: [provider],
        settings: { "terminal.persistence": "tmux" },
        width: 140,
        height: 40,
      }).then((app) => ({ ...app, spawn, provider }));
    };
    // The scripted client never starts a real server: on the next start tmux has nothing,
    // exactly as after a reboot.
    const first = await mount();
    await first.tui.act(() => first.ctx.commands.execute("ai.newSession"));
    await first.tui.waitForText("Apply the change");
    expect(first.ctx.persisted.state.sessions.agents.map((agent) => agent.name)).toEqual([
      expect.stringMatching(/^lucy-.*-a1$/),
    ]);
    await first.dispose();

    const second = await mount();
    await second.tui.act(() => second.ctx.commands.execute("view.focusAiPanel"));
    await second.tui.waitForText("Claude Code ended");
    expect(second.tui.frame()).toContain("Continue session");
    await second.tui.press("enter");
    await waitFor(second.tui, () => second.spawn.ptys.length === 1);
    expect(second.provider.launches.at(-1)).toEqual({ kind: "continue" });
    await second.tui.waitForText("Apply the change");
  }, 30_000);

  test("tmux missing: a one-time notice, and sessions run without persistence", async () => {
    const savedPath = process.env.PATH;
    const emptyBin = mkdtempSync(join(tmpdir(), "lucy-no-tmux-"));
    process.env.PATH = emptyBin;
    try {
      const dirs = createTestDirs();
      const spawn = scriptedSpawn(() => shellScript("zsh"));
      const options = {
        dirs,
        ptySpawn: spawn.spawn,
        settings: { "terminal.persistence": "tmux" as const, "terminal.shell": "/bin/zsh" },
      };
      const first = await mountApp(options);
      await first.tui.act(() => first.ctx.commands.execute("terminal.toggle"));
      await first.tui.waitForText("Sessions end when Lucy quits");
      await first.tui.waitForText("12 pass");
      expect(spawn.last()?.argv).toEqual(["/bin/zsh"]);
      expect(first.tui.frame()).not.toContain("persistent");
      expect(existsSync(join(dirs.state, "notices", "tmux-unavailable"))).toBe(true);
      await first.dispose();

      const second = await mountApp(options);
      await second.tui.act(() => second.ctx.commands.execute("terminal.toggle"));
      await second.tui.waitForText("12 pass");
      expect(second.tui.frame()).not.toContain("Sessions end when Lucy quits");
      await second.dispose();
    } finally {
      process.env.PATH = savedPath;
      rmSync(emptyBin, { recursive: true, force: true });
    }
  });
});
