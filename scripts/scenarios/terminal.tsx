/**
 * Terminal panel scenarios with a scripted shell (no real process runs).
 */
import { type ScriptedPty, scriptedSpawn, shellScript } from "../../tests/ai-ui/support/scripted-pty";
import { defineScenario, SIZES, until } from "../screenshots";

const sizes = [SIZES.wide, SIZES.medium];

function shellMount() {
  const spawn = scriptedSpawn(() => shellScript("zsh"));
  return { spawn, mount: { ptySpawn: spawn.spawn, settings: { "terminal.shell": "/bin/zsh" } } };
}

const panel = shellMount();
defineScenario(
  "terminal-panel",
  async ({ ctx, tui }) => {
    await tui.act(() => ctx.editors.open({ kind: "file", resource: "src/server/middleware/rate-limit.ts" }));
    await tui.act(() => ctx.commands.execute("terminal.toggle"));
    await until({ ctx, tui } as never, () => tui.frame().includes("12 pass"));
  },
  { description: "A shell in the bottom panel below the editor", sizes, mount: panel.mount },
);

const exited = shellMount();
defineScenario(
  "terminal-exited",
  async ({ ctx, tui }) => {
    await tui.act(() => ctx.commands.execute("terminal.toggle"));
    await until({ ctx, tui } as never, () => tui.frame().includes("12 pass"));
    await tui.act(() => (exited.spawn.last() as ScriptedPty).exit({ code: 1, signal: null }));
    await until({ ctx, tui } as never, () => tui.frame().includes("exited with code 1"));
  },
  { description: "The calm exit bar over a terminal whose shell ended", sizes, mount: exited.mount },
);
