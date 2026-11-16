/** Mounting the whole app with the explorer loaded, for UI tests. */
import { explorerControllerFor } from "@/features/explorer";
import type { ExplorerController } from "@/features/explorer/explorer-controller";
import { type MountAppOptions, type MountedApp, mountApp } from "../helpers/app";

export interface ExplorerApp extends MountedApp {
  controller: ExplorerController;
}

export async function mountExplorer(options: MountAppOptions = {}): Promise<ExplorerApp> {
  const mounted = await mountApp({ width: 120, height: 35, ...options });
  const controller = explorerControllerFor(mounted.ctx);
  if (!controller) throw new Error("The explorer feature did not activate");
  await mounted.tui.act(() => controller.load());
  await mounted.tui.settle();
  return { ...mounted, controller };
}

/** Polls (settling the UI between checks) until `predicate` holds. */
export async function waitUntil(app: MountedApp, predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("Condition not met in time");
    await Bun.sleep(10);
    await app.tui.settle();
  }
}

export async function focusExplorer(app: ExplorerApp): Promise<void> {
  await app.tui.act(() => app.ctx.focus.focus("sidebar"));
}

export function selectedKey(app: ExplorerApp): string | null {
  return app.controller.model.store.get().selectedKey;
}

/** The explorer's column range of the frame (header and tree), without the editor's content. */
export function sidebarFrame(app: ExplorerApp): string {
  // The activity bar (other features' icons and badges) is left out so this only shows the explorer.
  const layout = app.ctx.layout.effective.get();
  const start = layout.activityBar.width;
  return app.tui
    .frame()
    .split("\n")
    .map((line) => line.slice(start, start + layout.sidebar.width).trimEnd())
    .join("\n");
}

/** Clicks the first cell of `text` on screen. */
export async function clickText(app: MountedApp, text: string, options?: { button?: "left" | "right" }) {
  const at = app.tui.findText(text);
  if (!at) throw new Error(`"${text}" is not on screen`);
  await app.tui.click(at.x, at.y, options);
}
