import { afterEach, describe, expect, test } from "bun:test";
import { EmbeddedTerminalRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { connectEmbeddedTerminal, TerminalSession } from "@/adapters/pty";
import type { Disposable } from "@/core/events";
import { which } from "@/core/process";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Rig {
  setup: TestRendererSetup;
  term: EmbeddedTerminalRenderable;
  session: TerminalSession;
  connection: Disposable;
  lines(): Promise<string[]>;
  waitForLine(predicate: (line: string) => boolean, timeoutMs?: number): Promise<boolean>;
}

async function rig(argv: string[], env: Record<string, string> = {}): Promise<Rig> {
  const setup = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false });
  const term = new EmbeddedTerminalRenderable(setup.renderer, {
    cols: 80,
    rows: 24,
    width: "100%",
    height: "100%",
    maxScrollback: 1_000_000,
  });
  setup.renderer.root.add(term);
  await setup.renderOnce();
  const session = new TerminalSession({ argv, env, cols: 80, rows: 24 });
  const connection = connectEmbeddedTerminal(session, term);
  cleanups.push(async () => {
    connection.dispose();
    session.dispose();
    term.destroy();
    await setup.dispose();
  });
  const lines = async () => {
    await setup.renderOnce();
    return term.screen().lines;
  };
  const waitForLine = async (predicate: (line: string) => boolean, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await lines()).some(predicate)) return true;
      await Bun.sleep(15);
    }
    return false;
  };
  return { setup, term, session, connection, lines, waitForLine };
}

const shell = ["/bin/sh", "-i"];
const prompt = { PS1: "$ ", ENV: "" };

describe("EmbeddedTerminalRenderable + TerminalSession", () => {
  test("program output renders; keys typed into the focused renderable reach the PTY", async () => {
    const r = await rig(shell, prompt);
    expect(await r.waitForLine((line) => line.startsWith("$"))).toBe(true);
    r.term.focus();
    await r.setup.mockInput.typeText("echo lucy-$((40+2))");
    r.setup.mockInput.pressEnter();
    expect(await r.waitForLine((line) => line === "lucy-42")).toBe(true);
    expect(r.session.state.get().lastInputAt).not.toBeNull();
  });

  test("Ctrl+C reaches the program, not the host, when exitOnCtrlC is false", async () => {
    const r = await rig(shell, prompt);
    expect(await r.waitForLine((line) => line.startsWith("$"))).toBe(true);
    r.term.focus();
    const started = Date.now();
    await r.setup.mockInput.typeText("sleep 30");
    r.setup.mockInput.pressEnter();
    await Bun.sleep(200);
    r.setup.mockInput.pressCtrlC();
    await r.setup.mockInput.typeText("echo after-ctrl-c");
    r.setup.mockInput.pressEnter();
    // Only an interrupted sleep lets the next command run this soon.
    expect(await r.waitForLine((line) => line === "after-ctrl-c", 5000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.setup.renderer.isDestroyed).toBe(false);
  });

  test("terminal query responses are written back to the PTY and are not user input", async () => {
    const script =
      'process.stdin.setRawMode(true);process.stdout.write("\\x1b[6n");' +
      'process.stdin.once("data",(d)=>{process.stdout.write("\\r\\nGOT:"+JSON.stringify(d.toString()).slice(7)+"\\r\\n");process.exit(0);});';
    const r = await rig([process.execPath, "-e", script]);
    expect(await r.waitForLine((line) => line.startsWith("GOT:"))).toBe(true);
    const got = (await r.lines()).find((line) => line.startsWith("GOT:"));
    expect(got).toMatch(/^GOT:\[\d+;\d+R"$/);
    expect(r.session.state.get().lastInputAt).toBeNull();
  });

  test("renderer resize -> onTerminalResize -> PTY resize, observed with stty size", async () => {
    const r = await rig(shell, prompt);
    expect(await r.waitForLine((line) => line.startsWith("$"))).toBe(true);
    r.setup.resize(100, 30);
    await r.setup.renderOnce();
    expect(r.session.state.get()).toMatchObject({ cols: 100, rows: 30 });
    r.session.sendInput("stty size\r");
    expect(await r.waitForLine((line) => line === "30 100")).toBe(true);
  });

  test("a hidden renderable keeps consuming output; a new renderable gets a replay", async () => {
    const r = await rig(shell, prompt);
    expect(await r.waitForLine((line) => line.startsWith("$"))).toBe(true);
    r.term.visible = false;
    r.session.sendInput("echo while-hidden-çğış\r");
    await Bun.sleep(300);
    r.term.visible = true;
    expect(await r.waitForLine((line) => line === "while-hidden-çğış")).toBe(true);

    // Replace the renderable entirely (as if React unmounted it): the new one replays the buffer.
    r.connection.dispose();
    r.session.sendInput("echo after-detach\r");
    await Bun.sleep(300);
    const fresh = new EmbeddedTerminalRenderable(r.setup.renderer, {
      cols: 80,
      rows: 24,
      width: "100%",
      height: "100%",
    });
    r.setup.renderer.root.remove(r.term);
    r.setup.renderer.root.add(fresh);
    await r.setup.renderOnce();
    const connection = connectEmbeddedTerminal(r.session, fresh);
    cleanups.push(() => {
      connection.dispose();
      fresh.destroy();
    });
    await r.setup.renderOnce();
    const lines = fresh.screen().lines;
    expect(lines).toContain("while-hidden-çğış");
    expect(lines).toContain("after-detach");
  });

  test("session.paste is bracketed for zsh and never executes", async () => {
    const zsh = which("zsh");
    if (!zsh) return;
    const r = await rig([zsh, "-f", "-i"], { PS1: "%% " });
    expect(await r.waitForLine((line) => line.startsWith("%"))).toBe(true);
    expect(await waitForMode(r.session)).toBe(true);
    const result = r.session.paste("echo pasted-not-run\n");
    expect(result).toEqual({ sent: true, bracketed: true, multiline: true });
    expect(await r.waitForLine((line) => line.includes("echo pasted-not-run"))).toBe(true);
    await Bun.sleep(300);
    expect((await r.lines()).includes("pasted-not-run")).toBe(false);
  });
});

async function waitForMode(session: TerminalSession): Promise<boolean> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (session.modes.bracketedPaste) return true;
    await Bun.sleep(10);
  }
  return false;
}
