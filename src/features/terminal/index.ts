/**
 * Terminal feature: shell sessions in the bottom panel, plus the `TerminalPane` component the
 * AI panel reuses. The first shell is created when the Terminal tab is first shown (never
 * before the first frame); later ones on demand.
 */
import type { AppContext } from "@/app/app-context";
import type { FeatureModule } from "@/app/feature";
import { DisposableStore, toDisposable } from "@/core/events";
import { sessionPersistence } from "./persistence";
import { ShellTerminals } from "./shell-terminals";
import { createTerminalView } from "./terminal-view";

export { type SessionPersistence, sessionPersistence } from "./persistence";
export { describeExit } from "./terminal-exit-bar";
export { TerminalPane, type TerminalPaneProps } from "./terminal-pane";

const TAB_ID = "terminal";

function terminalTabShown(ctx: AppContext): boolean {
  const { bottom } = ctx.layout.state;
  return bottom.visible && (bottom.tab ?? TAB_ID) === TAB_ID;
}

export const terminalFeature: FeatureModule = {
  id: "terminal",
  keybindings: [
    { command: "terminal.new", keys: ["ctrl+k shift+t"] },
    { command: "terminal.kill", keys: ["ctrl+k shift+w"], when: "panelFocus" },
    { command: "terminal.restart", keys: ["ctrl+k shift+r"], when: "panelFocus" },
  ],
  activate(ctx) {
    const store = new DisposableStore();
    const terminals = store.add(new ShellTerminals(ctx));
    let firstCreated = false;
    const show = () => {
      ctx.layout.showBottomTab(TAB_ID);
      ctx.focus.focus("bottom");
    };
    // Lazily: the first time the tab is visible after the first frame.
    const ensureFirst = () => {
      if (firstCreated || !terminalTabShown(ctx)) return;
      firstCreated = true;
      if (terminals.state.terminals.length === 0) terminals.create();
    };
    const persistence = sessionPersistence(ctx);
    void ctx.lifecycle.firstPaint.then(async () => {
      if (store.isDisposed) return;
      // Persistent shells from the last run come back first (reattached or recreated).
      if ((await terminals.restore().catch(() => 0)) > 0) firstCreated = true;
      if (store.isDisposed) return;
      ensureFirst();
      store.add(toDisposable(ctx.layout.store.subscribe(ensureFirst)));
    });
    store.add(persistence.registerCounter(() => terminals.runningPersistent()));
    store.add(persistence.onDidEndAll(() => terminals.forgetAll()));

    store.add(
      ctx.views.registerBottomTab({
        id: TAB_ID,
        title: "Terminal",
        icon: "terminal",
        order: 10,
        component: createTerminalView(terminals),
        actions: [{ command: "terminal.new", icon: "add" }],
      }),
    );

    const hasTerminal = () => terminals.state.terminals.length > 0;
    store.add(
      ctx.commands.register({
        id: "terminal.toggle",
        title: "Toggle Terminal",
        category: "Terminal",
        description: "Shows and focuses the terminal, or hides it when it has focus",
        run: () => {
          if (terminalTabShown(ctx) && ctx.focus.current === "bottom") {
            ctx.layout.setBottomVisible(false);
            ctx.focus.focus("editor");
            return;
          }
          show();
          firstCreated = true;
          if (!hasTerminal()) terminals.create();
        },
      }),
    );
    store.add(
      ctx.commands.register({
        id: "terminal.new",
        title: "New Terminal",
        category: "Terminal",
        description: "Starts another shell in this workspace",
        run: () => {
          firstCreated = true;
          terminals.create();
          show();
        },
      }),
    );
    store.add(
      ctx.commands.register({
        id: "terminal.kill",
        title: "Kill Terminal",
        category: "Terminal",
        description: "Stops the active shell and everything started in it",
        enabled: hasTerminal,
        run: async () => {
          const active = terminals.active;
          if (active) await terminals.kill(active.id);
        },
      }),
    );
    store.add(
      ctx.commands.register({
        id: "terminal.restart",
        title: "Restart Terminal",
        category: "Terminal",
        description: "Stops the active shell if it runs and starts it again",
        enabled: hasTerminal,
        run: async () => {
          const active = terminals.active;
          if (!active) return;
          if (active.session.isRunning) {
            const confirmed = await ctx.dialogs.confirm({
              title: "Restart this terminal?",
              message: "The shell and every program started in it are stopped, then the shell starts again.",
              confirmLabel: "Restart",
              danger: true,
            });
            if (!confirmed) return;
          }
          await terminals.restart(active.id);
          show();
        },
      }),
    );
    store.add(
      ctx.commands.register({
        id: "terminal.endBackgroundSessions",
        title: "End Background Sessions",
        category: "Terminal",
        description: "Stops this workspace's terminals and Claude Code sessions kept running by tmux",
        run: async () => {
          const sessions = await persistence.list();
          if (sessions.length === 0) {
            ctx.notifications.info(
              "No background sessions",
              "Nothing of this workspace runs in the background.",
            );
            return;
          }
          const confirmed = await ctx.dialogs.confirm({
            title: `End ${sessions.length} background ${sessions.length === 1 ? "session" : "sessions"}?`,
            message:
              "Their programs are stopped and they do not come back on the next start. Claude Code keeps conversations in its history.",
            confirmLabel: "End Sessions",
            danger: true,
          });
          if (!confirmed) return;
          const ended = await persistence.endAll();
          ctx.hints.flash({ text: `Ended ${ended} background ${ended === 1 ? "session" : "sessions"}` });
        },
      }),
    );
    return store;
  },
};
