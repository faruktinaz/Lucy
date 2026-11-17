/**
 * The bottom Terminal panel through the whole app, with a scripted PTY (and one real,
 * short-lived `sh -c` PTY).
 */
import { describe, expect, test } from "bun:test";
import { spawnPty } from "@/adapters/pty";
import { type ScriptedPty, scriptedSpawn, shellScript } from "../ai-ui/support/scripted-pty";
import { mountApp } from "../helpers/app";

async function waitFor(tui: { advance(ms: number): Promise<void> }, predicate: () => boolean, ms = 3000) {
  const deadline = performance.now() + ms;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("Timed out waiting for a condition");
    await tui.advance(10);
  }
}

async function mountShell() {
  const spawn = scriptedSpawn(() => shellScript("zsh"));
  const app = await mountApp({
    ptySpawn: spawn.spawn,
    settings: { "terminal.shell": "/bin/zsh", "terminal.persistence": "off" },
  });
  const open = async () => {
    await app.tui.act(() => app.ctx.commands.execute("terminal.toggle"));
    await waitFor(app.tui, () => app.tui.frame().includes("12 pass"));
    return spawn.last() as ScriptedPty;
  };
  return { ...app, spawn, open };
}

const typed = (pty: ScriptedPty) => pty.writtenText().split("\x1b[I").join("").split("\x1b[O").join("");

describe("Terminal panel", () => {
  test("toggle creates a shell lazily, focuses it, and hides it when it has focus", async () => {
    const { tui, ctx, spawn, open } = await mountShell();
    expect(spawn.ptys).toEqual([]);
    const pty = await open();
    expect(pty.argv).toEqual(["/bin/zsh"]);
    expect(ctx.focus.current).toBe("bottom");
    await tui.type("ls");
    await tui.press("enter");
    await waitFor(tui, () => typed(pty).includes("ls\r"));
    await tui.act(() => ctx.commands.execute("terminal.toggle"));
    expect(ctx.layout.state.bottom.visible).toBe(false);
    await tui.act(() => ctx.commands.execute("terminal.toggle"));
    expect(spawn.ptys.length).toBe(1);
    await tui.waitForText("12 pass");
  });

  test("new terminal adds a tab; kill asks while the shell runs", async () => {
    const { tui, ctx, spawn, open } = await mountShell();
    await open();
    await tui.act(() => ctx.commands.execute("terminal.new"));
    await waitFor(tui, () => spawn.ptys.length === 2);
    await tui.waitForText("zsh 2");
    void ctx.commands.execute("terminal.kill");
    await waitFor(tui, () => ctx.dialogs.request !== null);
    expect(ctx.dialogs.request?.title).toBe("Kill zsh 2?");
    await tui.press("escape");
    expect(spawn.ptys[1]?.disposed).toBe(false);
    void ctx.commands.execute("terminal.kill");
    await waitFor(tui, () => ctx.dialogs.request !== null);
    await tui.press("tab");
    await tui.press("enter");
    await waitFor(tui, () => spawn.ptys[1]?.disposed === true);
    expect(tui.frame()).not.toContain("zsh 2");
  });

  test("multi-line paste without bracketed paste asks first; a single line is pasted without Enter", async () => {
    const { tui, ctx, open } = await mountShell();
    const pty = await open();
    await tui.paste("echo one\n");
    await waitFor(tui, () => typed(pty).includes("echo one"));
    expect(typed(pty)).not.toContain("echo one\r");
    expect(ctx.dialogs.request).toBeNull();

    await tui.paste("echo a\necho b\n");
    await waitFor(tui, () => ctx.dialogs.request !== null);
    expect(ctx.dialogs.request?.title).toBe("Paste 2 lines into zsh?");
    await tui.press("escape");
    expect(typed(pty)).not.toContain("echo a");
    await tui.paste("echo a\necho b\n");
    await waitFor(tui, () => ctx.dialogs.request !== null);
    await tui.press("tab");
    await tui.press("enter");
    await waitFor(tui, () => typed(pty).includes("echo a\recho b"));
    expect(typed(pty).endsWith("echo b")).toBe(true);
  });

  test("an exited shell shows the exit bar; Enter restarts it", async () => {
    const { tui, spawn, open } = await mountShell();
    const pty = await open();
    await tui.act(() => pty.exit({ code: 2, signal: null }));
    await tui.waitForText("zsh exited with code 2");
    await tui.press("enter");
    await waitFor(tui, () => spawn.ptys.length === 2);
    await waitFor(tui, () => !tui.frame().includes("exited with code 2"));
  });

  test("a real short-lived PTY runs through the real component", async () => {
    const { tui, ctx } = await mountApp({
      ptySpawn: spawnPty,
      settings: {
        "terminal.persistence": "off",
        "terminal.shell": "/bin/sh",
        "terminal.args": ["-c", "printf 'real-pty-ok\\n'; exit 3"],
      },
    });
    await tui.act(() => ctx.commands.execute("terminal.toggle"));
    await tui.waitForText("real-pty-ok", { timeoutMs: 5000 });
    await tui.waitForText("sh exited with code 3", { timeoutMs: 5000 });
  });
});
