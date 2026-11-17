/**
 * The AI panel through the whole app (`mountApp`) with a scripted PTY and a fake provider:
 * the real `claude` never runs here.
 */
import { describe, expect, test } from "bun:test";
import { mountApp } from "../helpers/app";
import { DEMO_AGENT_TRANSCRIPT, fakeProvider, type ScriptedPty, scriptedSpawn } from "./support/scripted-pty";

async function waitFor(tui: { advance(ms: number): Promise<void> }, predicate: () => boolean, ms = 3000) {
  const deadline = performance.now() + ms;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("Timed out waiting for a condition");
    await tui.advance(10);
  }
}

async function mountAgent(options: Parameters<typeof fakeProvider>[0] = {}, settings = {}) {
  const spawn = scriptedSpawn(() => ({ start: DEMO_AGENT_TRANSCRIPT }));
  const provider = fakeProvider(options);
  const app = await mountApp({
    ptySpawn: spawn.spawn,
    agentProviders: [provider],
    // The scripted PTY stands in for the real process; persistence has its own tests.
    settings: { "terminal.persistence": "off", ...settings },
    width: 140,
    height: 40,
  });
  const start = async () => {
    await app.tui.act(() => app.ctx.commands.execute("ai.newSession"));
    await waitFor(app.tui, () => spawn.ptys.length > 0 && app.tui.frame().includes("Apply the change"));
    return spawn.last() as ScriptedPty;
  };
  return { ...app, spawn, provider, start };
}

/** Text the program received, without the emulator's focus reports and query answers. */
function typed(pty: ScriptedPty): string {
  return pty.writtenText().split("\x1b[I").join("").split("\x1b[O").join("");
}

describe("AI panel", () => {
  test("start screen shows the resolved executable, version and folder", async () => {
    const { tui, ctx } = await mountAgent({ executable: "/opt/tools/bin/claude", version: "2.1.325" });
    await tui.act(() => ctx.commands.execute("view.focusAiPanel"));
    await tui.waitForText("Version 2.1.325");
    const frame = tui.frame();
    expect(frame).toContain("/opt/tools/bin/claude");
    expect(frame).toContain("Start Claude Code");
    expect(frame).toContain("Continue last session");
    expect(frame).toContain("Resume a session");
    expect(frame).toContain("never adds permission flags");
  });

  test("a missing CLI is explained with install text and the ai.executable setting", async () => {
    const { tui, ctx, spawn } = await mountAgent({ available: false });
    await tui.act(() => ctx.commands.execute("view.focusAiPanel"));
    await tui.waitForText("Claude Code was not found");
    expect(tui.frame()).not.toContain("`");
    expect(tui.frame()).toContain("npm install -g @anthropic-ai/claude-code");
    expect(tui.frame()).toContain("ai.executable");
    await tui.act(() => ctx.commands.execute("ai.newSession"));
    expect(spawn.ptys).toEqual([]);
  });

  test("starting runs the session in the panel; keys reach the PTY", async () => {
    const { tui, ctx, start, provider } = await mountAgent();
    const pty = await start();
    expect(provider.launches.at(-1)).toEqual({ kind: "new" });
    expect(ctx.focus.current).toBe("auxiliary");
    expect(ctx.layout.state.auxiliary.visible).toBe(true);
    await tui.type("yes");
    await tui.press("enter");
    await waitFor(tui, () => typed(pty).includes("yes\r"));
  });

  test("terminal-focus policy: Ctrl+R, Ctrl+P, Ctrl+C, Escape and Tab reach the PTY; the leader works", async () => {
    const { tui, ctx, start } = await mountAgent();
    const pty = await start();
    const before = pty.writes.length;
    await tui.press("ctrl+r");
    await tui.press("ctrl+p");
    await tui.press("ctrl+c");
    await tui.press("escape");
    await tui.press("tab");
    const received = typed(pty);
    expect(pty.writes.length).toBeGreaterThan(before);
    for (const bytes of ["\x12", "\x10", "\x03", "\x1b", "\t"]) expect(received).toContain(bytes);
    expect(ctx.quickPick.state.open).toBe(false);

    // Leader then P opens the palette instead of reaching the terminal.
    await tui.press("ctrl+\\");
    await tui.press("p");
    expect(ctx.quickPick.state.open).toBe(true);
    await tui.press("escape");
    expect(typed(pty)).not.toContain("\x1c");

    // Leader twice: the second press reaches the program as a literal Ctrl+\.
    await tui.act(() => ctx.focus.focus("auxiliary"));
    await tui.press("ctrl+\\");
    await tui.press("ctrl+\\");
    await waitFor(tui, () => typed(pty).includes("\x1c"));
  });

  test("hiding and showing the panel keeps the session and its screen", async () => {
    const { tui, ctx, start } = await mountAgent();
    const pty = await start();
    await tui.act(() => ctx.commands.execute("view.toggleAiPanel"));
    expect(ctx.layout.state.auxiliary.visible).toBe(false);
    await tui.act(() => pty.emit("\r\nwritten while hidden\r\n"));
    await tui.act(() => ctx.commands.execute("view.focusAiPanel"));
    await tui.waitForText("written while hidden");
    expect(tui.frame()).toContain("Apply the change");
    expect(pty.killed).toBe(false);
  });

  test("ai.onPanelClose = terminate stops running sessions when the panel is hidden", async () => {
    const { tui, ctx, start } = await mountAgent({}, { "ai.onPanelClose": "terminate" });
    await tui.act(() => ctx.commands.execute("view.focusAiPanel"));
    const pty = await start();
    expect(tui.frame()).toContain("Hide panel: sessions are stopped");
    await tui.act(() => ctx.commands.execute("view.toggleAiPanel"));
    await waitFor(tui, () => pty.killed);
  });

  test("ai.onPanelClose = ask stops only after confirmation", async () => {
    const { tui, ctx, start } = await mountAgent({}, { "ai.onPanelClose": "ask" });
    const pty = await start();
    await tui.act(() => ctx.commands.execute("view.toggleAiPanel"));
    await waitFor(tui, () => ctx.dialogs.request !== null);
    expect(ctx.dialogs.request?.title).toContain("Stop the running Claude Code session");
    await tui.press("escape");
    expect(pty.killed).toBe(false);
    await tui.act(() => ctx.commands.execute("view.focusAiPanel"));
    await tui.act(() => ctx.commands.execute("view.toggleAiPanel"));
    await waitFor(tui, () => ctx.dialogs.request !== null);
    await tui.press("tab");
    await tui.press("enter");
    await waitFor(tui, () => pty.killed);
  });

  test("keep-running (default) leaves the session alone and says so", async () => {
    const { tui, ctx, start } = await mountAgent();
    const pty = await start();
    expect(tui.frame()).toContain("Hide panel: sessions keep running");
    await tui.act(() => ctx.commands.execute("view.toggleAiPanel"));
    expect(ctx.hints.current?.text).toContain("keeps running in the background");
    expect(pty.killed).toBe(false);
  });

  test("quitting with a running session asks first", async () => {
    let quit = 0;
    const spawn = scriptedSpawn(() => ({ start: DEMO_AGENT_TRANSCRIPT }));
    const { tui, ctx } = await mountApp({
      ptySpawn: spawn.spawn,
      agentProviders: [fakeProvider()],
      settings: { "terminal.persistence": "off" },
      onQuit: () => {
        quit++;
      },
    });
    await tui.act(() => ctx.commands.execute("ai.newSession"));
    await waitFor(tui, () => spawn.ptys.length === 1);
    void ctx.commands.execute("app.quit");
    await waitFor(tui, () => ctx.dialogs.request !== null);
    expect(ctx.dialogs.request?.title).toBe("Quit while Claude Code is running?");
    await tui.press("escape");
    await tui.settle();
    expect(quit).toBe(0);
    void ctx.commands.execute("app.quit");
    await waitFor(tui, () => ctx.dialogs.request !== null);
    await tui.press("tab");
    await tui.press("enter");
    await waitFor(tui, () => quit === 1);
  });

  test("a risky configured argument shows a warning and needs an explicit confirmation", async () => {
    const { tui, ctx, spawn } = await mountAgent({ extraArgs: ["--dangerously-skip-permissions"] });
    await tui.act(() => ctx.commands.execute("view.focusAiPanel"));
    await tui.waitForText("Check your extra arguments");
    expect(tui.frame()).toContain("--dangerously-skip-permissions");
    expect(tui.frame()).toContain("turns off permission prompts");
    void ctx.commands.execute("ai.newSession");
    await waitFor(tui, () => ctx.dialogs.request !== null);
    expect(ctx.dialogs.request?.danger).toBe(true);
    await tui.press("escape");
    await tui.settle();
    expect(spawn.ptys).toEqual([]);
    void ctx.commands.execute("ai.newSession");
    await waitFor(tui, () => ctx.dialogs.request !== null);
    await tui.press("tab");
    await tui.press("enter");
    await waitFor(tui, () => spawn.ptys.length === 1);
  });

  test("prompt templates are pasted (bracketed) and never submitted", async () => {
    const { tui, ctx, start } = await mountAgent();
    await tui.act(() => {
      ctx.editors.open({ kind: "file", resource: "src/app.ts" });
    });
    const pty = await start();
    void ctx.commands.execute("ai.insertPromptTemplate");
    await tui.waitForText("Fix Diagnostics");
    await tui.type("explain");
    await tui.press("enter");
    await waitFor(tui, () => typed(pty).includes("\x1b[201~"));
    const text = typed(pty);
    expect(text).toContain("\x1b[200~Explain what @src/app.ts does");
    expect(text.endsWith("\x1b[201~")).toBe(true);
    expect(text).not.toContain("\x1b[201~\r");
  });

  test("restart and close: exit shows the overlay, Enter restarts, close removes the session", async () => {
    const { tui, ctx, start, spawn } = await mountAgent();
    const pty = await start();
    await tui.act(() => pty.exit({ code: 1, signal: null }));
    await tui.waitForText("Claude Code exited with code 1");
    await tui.press("enter");
    await waitFor(tui, () => spawn.ptys.length === 2);
    await waitFor(tui, () => !tui.frame().includes("exited with code 1"));
    await tui.act(() => (spawn.last() as ScriptedPty).exit({ code: 0, signal: null }));
    await tui.waitForText("Claude Code exited");
    await tui.press("ctrl+w");
    await tui.waitForText("Start Claude Code");
    expect(ctx.services.agents.list()).toEqual([]);
  });

  test("theme changes restyle the terminal's default colors", async () => {
    const { tui, ctx, start } = await mountAgent();
    const pty = await start();
    const answer = async () => {
      const before = pty.writtenText().length;
      await tui.act(() => pty.emit("\x1b]11;?\x07"));
      await waitFor(tui, () => pty.writtenText().length > before);
      return pty.writtenText().slice(before);
    };
    const hex = (value: string) =>
      `rgb:${value.slice(1, 3)}${value.slice(1, 3)}/${value.slice(3, 5)}${value.slice(3, 5)}/${value.slice(5, 7)}${value.slice(5, 7)}`;
    expect(await answer()).toContain(hex(ctx.themes.current.terminal.background).toLowerCase());
    await tui.act(() => ctx.config.set("ui.theme", "high-contrast", { persist: false }));
    expect(await answer()).toContain(hex(ctx.themes.current.terminal.background).toLowerCase());
  });
});
