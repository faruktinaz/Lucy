/**
 * AI panel scenarios. A scripted PTY plays a neutral "demo agent" transcript: the real
 * `claude` never runs here, and its interface is not imitated.
 */
import { DEMO_AGENT_TRANSCRIPT, fakeProvider, scriptedSpawn } from "../../tests/ai-ui/support/scripted-pty";
import { defineScenario, SIZES, until } from "../screenshots";

const sizes = [SIZES.wide, SIZES.medium];
const DAY = 24 * 60 * 60 * 1000;

export function agentMount(options: Parameters<typeof fakeProvider>[0] = {}) {
  const spawn = scriptedSpawn(() => ({ start: DEMO_AGENT_TRANSCRIPT }));
  return {
    ptySpawn: spawn.spawn,
    agentProviders: [fakeProvider(options)],
    settings: { "terminal.persistence": "off" as const },
  };
}

defineScenario(
  "ai-start",
  async ({ ctx, tui }) => {
    await tui.act(() => ctx.commands.execute("view.focusAiPanel"));
    await until({ ctx, tui } as never, () => tui.frame().includes("Version"));
  },
  {
    description: "The AI panel before a session: what will run, where, and how to start",
    sizes,
    mount: agentMount({ executable: "/usr/local/bin/claude" }),
  },
);

defineScenario(
  "ai-session",
  async ({ ctx, tui }) => {
    await tui.act(() => {
      ctx.editors.open({ kind: "file", resource: "src/server/middleware/rate-limit.ts" });
      ctx.layout.setSidebarVisible(false);
    });
    await tui.act(() => ctx.commands.execute("ai.newSession"));
    await until({ ctx, tui } as never, () => tui.frame().includes("Apply the change"));
  },
  {
    description: "A running session in the AI panel beside the editor",
    sizes,
    mount: agentMount(),
  },
);

defineScenario(
  "ai-missing-cli",
  async ({ ctx, tui }) => {
    await tui.act(() => ctx.commands.execute("view.focusAiPanel"));
    await until({ ctx, tui } as never, () => tui.frame().includes("Install"));
  },
  {
    description: "Claude Code is not installed: what to do, as text only",
    sizes,
    mount: agentMount({ available: false }),
  },
);

defineScenario(
  "ai-warning",
  async ({ ctx, tui }) => {
    await tui.act(() => ctx.commands.execute("view.focusAiPanel"));
    await until({ ctx, tui } as never, () => tui.frame().includes("extra arguments"));
    void ctx.commands.execute("ai.newSession");
    await until({ ctx, tui } as never, () => ctx.dialogs.request !== null);
  },
  {
    description: "A permission-bypass flag in ai.args: a prominent warning and an explicit confirmation",
    sizes,
    mount: agentMount({ extraArgs: ["--dangerously-skip-permissions"] }),
  },
);

defineScenario(
  "ai-sessions-view",
  async ({ ctx, tui }) => {
    await tui.act(() => ctx.commands.execute("ai.newSession"));
    await until({ ctx, tui } as never, () => tui.frame().includes("Apply the change"));
    await tui.act(() => ctx.commands.execute("ai.showSessions"));
    await until({ ctx, tui } as never, () => tui.frame().includes("Parser"));
  },
  {
    description: "Running sessions and this workspace's Claude Code history in the sidebar",
    sizes,
    mount: agentMount({
      history: {
        problem: null,
        sessions: [
          { id: "1b7c", title: "Parser refactor for the notes import", updatedAt: Date.now() - 2 * 3600_000 },
          { id: "2c8d", title: "/review PR 12", updatedAt: Date.now() - DAY - 3600_000 },
          { id: "3d9e", title: "Rate limit tests flaky on CI", updatedAt: Date.now() - 4 * DAY },
          { id: "4eaf", title: "çalışma notları: İçerik sayfası", updatedAt: Date.now() - 9 * DAY },
        ],
      },
    }),
  },
);
