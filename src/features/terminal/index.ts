/**
 * Terminal feature: shell sessions in the bottom panel, plus the `TerminalPane` component the
 * AI panel reuses. The first shell is created when the Terminal tab is first shown (never
 * before the first frame); later ones on demand.
 */
import type { AppContext } from "@/app/app-context";
import type { FeatureModule } from "@/app/feature";
import { DisposableStore, toDisposable } from "@/core/events";
import { ShellTerminals } from "./shell-terminals";
import { createTerminalView } from "./terminal-view";

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
    void ctx.lifecycle.firstPaint.then(() => {
      if (store.isDisposed) return;
      ensureFirst();
      store.add(toDisposable(ctx.layout.store.subscribe(ensureFirst)));
    });

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
    return store;
  },
};
