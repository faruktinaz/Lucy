/**
 * Explorer screenshot scenarios against the demo workspace (`bun run screenshots --only ...`).
 */
import { explorerControllerFor } from "@/features/explorer";
import type { ExplorerController } from "@/features/explorer/explorer-controller";
import { defineScenario, type ScenarioContext, SIZES, until } from "../screenshots";

async function prepare(app: ScenarioContext): Promise<ExplorerController> {
  const controller = explorerControllerFor(app.ctx);
  if (!controller) throw new Error("The explorer feature did not activate");
  await app.tui.act(() => controller.load());
  // A few folders open, a file selected and open in the editor.
  await app.tui.act(() => controller.model.reveal("src/server/routes/tasks.ts"));
  await app.tui.act(() => controller.model.reveal("docs/çalışma-notları.md"));
  await app.tui.act(() => app.ctx.editors.open({ kind: "file", resource: "src/server/routes/tasks.ts" }));
  await until(app, () => controller.model.store.get().selectedKey === "src/server/routes/tasks.ts");
  await app.tui.act(() => app.ctx.focus.focus("sidebar"));
  return controller;
}

const sizes = [SIZES.wide, SIZES.medium];

defineScenario(
  "explorer",
  async (app) => {
    await prepare(app);
  },
  { description: "Explorer: folders expanded, a file selected and open, Git letters", sizes },
);

defineScenario(
  "explorer-rename",
  async (app) => {
    const controller = await prepare(app);
    await app.tui.act(() => controller.rename());
    await app.tui.press("end");
    for (let i = 0; i < 8; i++) await app.tui.press("backspace");
    await app.tui.type("task-routes.ts");
    await app.tui.settle();
  },
  { description: "Explorer: inline rename", sizes },
);

defineScenario(
  "explorer-context-menu",
  async (app) => {
    const controller = await prepare(app);
    await app.tui.act(() => controller.showContextMenu());
  },
  { description: "Explorer: context menu from the keyboard", sizes },
);

defineScenario(
  "explorer-delete",
  async (app) => {
    const controller = await prepare(app);
    void controller.deleteSelection("docs");
    await until(app, () => app.tui.frame().includes("Move to Trash"));
  },
  { description: "Explorer: delete confirmation (danger, safe default)", sizes },
);

defineScenario(
  "explorer-filter",
  async (app) => {
    const controller = await prepare(app);
    await app.tui.act(() => controller.openFilter());
    await app.tui.type("task");
    await until(app, () => controller.model.store.get().filter.summary.endsWith("matches"));
  },
  { description: "Explorer: filter with match summary", sizes },
);

defineScenario(
  "explorer-narrow",
  async (app) => {
    await prepare(app);
  },
  { description: "Explorer as a drawer below 80 columns", sizes: [SIZES.narrow] },
);
