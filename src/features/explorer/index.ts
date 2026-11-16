/**
 * The Explorer: a VS Code-like file tree in the sidebar, on top of `ExplorerViewModel`
 * (`./model`). Commands, keybindings and the view are registered here; the controller does
 * the wiring to the workbench.
 */
import type { AppContext } from "@/app/app-context";
import type { FeatureModule } from "@/app/feature";
import { DisposableStore, toDisposable } from "@/core/events";
import { registerExplorerCommands } from "./explorer-commands";
import { ExplorerController } from "./explorer-controller";
import { EXPLORER_KEYBINDINGS } from "./explorer-keybindings";
import { createExplorerView } from "./explorer-view";

const controllers = new WeakMap<AppContext, ExplorerController>();

/** The explorer controller of an app (tests and screenshot scenarios drive the model through it). */
export function explorerControllerFor(ctx: AppContext): ExplorerController | undefined {
  return controllers.get(ctx);
}

export { ExplorerController } from "./explorer-controller";
export { EXPLORER_FOCUS, EXPLORER_KEYBINDINGS, EXPLORER_VISIBLE } from "./explorer-keybindings";

export const explorerFeature: FeatureModule = {
  id: "explorer",
  keybindings: EXPLORER_KEYBINDINGS,
  activate(ctx) {
    const store = new DisposableStore();
    const controller = store.add(new ExplorerController(ctx));
    controllers.set(ctx, controller);
    store.add(toDisposable(() => controllers.delete(ctx)));
    store.add(registerExplorerCommands(ctx, controller));
    store.add(
      ctx.views.registerSidebarView({
        id: "explorer",
        title: "Explorer",
        icon: "explorer",
        order: 10,
        command: "view.showExplorer",
        // Three actions plus "more" fit a 30-column sidebar beside the title; New Folder and
        // Refresh live in the more menu (the watcher refreshes on its own).
        actions: [
          { command: "explorer.newFile", icon: "add", title: "New File" },
          { command: "explorer.filter", icon: "search", title: "Filter Files" },
          { command: "explorer.collapseAll", icon: "collapseAll", title: "Collapse Folders" },
          { command: "explorer.moreActions", icon: "more", title: "More Actions" },
        ],
        component: createExplorerView(controller),
      }),
    );
    return store;
  },
};
