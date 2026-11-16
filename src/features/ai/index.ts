/**
 * AI feature: Claude Code (the user's own CLI, auth and permissions) in the auxiliary panel,
 * the "AI Sessions" sidebar view, an AI status item, prompt templates, the panel-close policy
 * and a quit guard for running sessions. Lucy never adds permission flags and never submits a
 * prompt.
 */
import type { AgentLaunchMode } from "@/adapters/agents";
import type { FeatureModule } from "@/app/feature";
import { DisposableStore, toDisposable } from "@/core/events";
import { AI_SESSIONS_VIEW_ID, AI_VIEW_ID, AiController } from "./ai-controller";
import { createAiPanelView } from "./ai-panel-view";
import { createAiSessionsView } from "./ai-sessions-view";
import { ACTIVITY_STATUS_TONE, summarize } from "./presentation";

export { AiController } from "./ai-controller";

const LEADER = "ctrl+\\";
const inPanel = "aiHasSession && auxiliaryFocus";

/** `{ id }` from a menu or view action; anything else means "the active session". */
function sessionId(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const id = (args as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

export const aiFeature: FeatureModule = {
  id: "ai",
  keybindings: [
    // `ai.newSession` has `ctrl+k n` in the defaults; the leader reaches it from inside a terminal.
    { command: "ai.newSession", keys: [`${LEADER} n`], global: true },
    { command: "ai.continueSession", keys: ["ctrl+k ctrl+n"] },
    { command: "ai.resumeSession", keys: ["ctrl+k shift+n"] },
    { command: "ai.restartSession", keys: ["ctrl+k r"], when: inPanel },
    { command: "ai.closeSession", keys: ["ctrl+k w"], when: inPanel },
    { command: "ai.renameSession", keys: ["f2"], when: inPanel },
    { command: "ai.insertPromptTemplate", keys: ["ctrl+k i"] },
    { command: "ai.insertPromptTemplate", keys: [`${LEADER} i`], global: true },
    { command: "ai.showSessions", keys: ["ctrl+k shift+a"] },
  ],
  activate(ctx) {
    const store = new DisposableStore();
    const controller = store.add(new AiController(ctx));
    const hasSession = () => controller.sessions.get().length > 0;
    const launch = (mode: AgentLaunchMode) => controller.launch(mode).then(() => undefined);

    store.add(
      ctx.views.registerAuxiliaryView({
        id: AI_VIEW_ID,
        title: "Claude Code",
        icon: "ai",
        order: 10,
        component: createAiPanelView(controller),
        actions: [{ command: "ai.newSession", icon: "add", title: "New session" }],
      }),
    );
    store.add(
      ctx.views.registerSidebarView({
        id: AI_SESSIONS_VIEW_ID,
        title: "AI Sessions",
        icon: "ai",
        order: 40,
        command: "ai.showSessions",
        actions: [
          { command: "ai.refreshHistory", icon: "refresh", title: "Refresh history" },
          { command: "ai.newSession", icon: "add", title: "New session" },
        ],
        component: createAiSessionsView(controller),
      }),
    );

    const register = (definition: Parameters<typeof ctx.commands.register>[0]) =>
      store.add(ctx.commands.register(definition));
    register({
      id: "ai.newSession",
      title: "New Session",
      category: "AI",
      description: "Starts Claude Code in this workspace, in the AI panel",
      run: () => launch({ kind: "new" }),
    });
    register({
      id: "ai.continueSession",
      title: "Continue Last Session",
      category: "AI",
      description: "Continues the most recent conversation in this folder (claude --continue)",
      run: () => launch({ kind: "continue" }),
    });
    register({
      id: "ai.resumeSession",
      title: "Resume Session…",
      category: "AI",
      description: "Opens Claude Code's own session picker in the panel (claude --resume)",
      run: () => launch({ kind: "resume-picker" }),
    });
    register({
      id: "ai.restartSession",
      title: "Restart Session",
      category: "AI",
      description: "Stops the session and runs the same command again",
      enabled: hasSession,
      run: (args) => controller.restart(sessionId(args)),
    });
    register({
      id: "ai.closeSession",
      title: "Close Session",
      category: "AI",
      description: "Stops the session (after asking while it runs) and closes it",
      enabled: hasSession,
      run: async (args) => {
        await controller.close(sessionId(args));
      },
    });
    register({
      id: "ai.renameSession",
      title: "Rename Session…",
      category: "AI",
      enabled: hasSession,
      run: (args) => controller.rename(sessionId(args)),
    });
    register({
      id: "ai.insertPromptTemplate",
      title: "Insert Prompt Template…",
      category: "AI",
      description: "Pastes a prompt about the current file or your changes; you press Enter",
      keywords: ["explain", "review", "tests", "diagnostics", "prompt"],
      run: () => controller.insertTemplate(),
    });
    register({
      id: "ai.showSessions",
      title: "Show AI Sessions",
      category: "AI",
      description: "Running sessions and this workspace's Claude Code history",
      run: () => {
        ctx.layout.showSidebarView(AI_SESSIONS_VIEW_ID);
        ctx.focus.focus("sidebar");
      },
    });
    register({
      id: "ai.refreshHistory",
      title: "Refresh Session History",
      category: "AI",
      run: () => controller.refreshHistory({ force: true }),
    });

    // Status bar: the provider and its most important state; activating it shows the panel.
    const status = store.add(
      ctx.statusBar.register({
        id: "ai.status",
        alignment: "right",
        priority: 60,
        text: "",
        icon: "ai",
        command: "view.focusAiPanel",
        visible: false,
      }),
    );
    const renderStatus = () => {
      const sessions = controller.sessions.get();
      const summary = summarize(sessions);
      // While the panel is on screen its header already shows the state.
      if (!summary || ctx.layout.effective.get().auxiliary.visible) {
        status.update({ visible: false });
        return;
      }
      const words = { working: "working", idle: "idle", attention: "needs attention", exited: "exited" };
      const word = words[summary.activity];
      const name = controller.providerName();
      status.update({
        visible: true,
        text: summary.count > 1 ? `${name} · ${summary.count} ${word}` : `${name} · ${word}`,
        tone: ACTIVITY_STATUS_TONE[summary.activity],
        tooltip: `${sessions.length} ${sessions.length === 1 ? "session" : "sessions"} · Show the AI panel`,
      });
    };
    store.add(toDisposable(controller.sessions.subscribe(renderStatus)));
    store.add(toDisposable(ctx.layout.effective.subscribe(renderStatus)));

    // Hiding the panel applies `ai.onPanelClose` (the panel footer says which).
    let panelVisible = ctx.layout.state.auxiliary.visible;
    store.add(
      toDisposable(
        ctx.layout.store.subscribe(() => {
          const visible = ctx.layout.state.auxiliary.visible;
          if (panelVisible && !visible) void controller.onPanelHidden();
          panelVisible = visible;
        }),
      ),
    );

    store.add(ctx.lifecycle.addQuitGuard(() => controller.confirmQuit()));
    return store;
  },
};
