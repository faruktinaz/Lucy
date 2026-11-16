/**
 * The README images (`docs/images/*.png`): one theme, one size each, copied there by the
 * runner (`readmeImage`). Regenerate them all with
 *
 *   bun run screenshots --only readme-hero,readme-source-control,readme-editor,readme-search,readme-ai-panel,readme-settings
 */
import { defineScenario, until } from "../screenshots";
import { agentMount } from "./ai";
import { findScenario } from "./editor";
import { prepare } from "./explorer";
import { search } from "./search";
import { openDiff, showSourceControl } from "./source-control";

const THEMES = ["catppuccin-mocha"] as const;
const WIDE = [{ cols: 120, rows: 35 }];

defineScenario(
  "readme-hero",
  async (app) => {
    await prepare(app);
    await app.tui.act(() => app.ctx.commands.execute("ai.newSession"));
    await until(app, () => app.tui.frame().includes("Apply the change"));
    await app.tui.act(() => app.ctx.focus.focus("editor"));
  },
  {
    description: "README hero: explorer, a highlighted file and a Claude Code session",
    themes: THEMES,
    sizes: [{ cols: 150, rows: 42 }],
    mount: agentMount(),
    readmeImage: "hero",
  },
);

defineScenario(
  "readme-source-control",
  async (app) => {
    await showSourceControl(app);
    await openDiff(app, "src/server/routes/tasks.ts");
    await app.tui.act(() => app.ctx.focus.focus("editor"));
    await app.tui.press("f7");
  },
  {
    description: "README: Source Control with a unified diff",
    themes: THEMES,
    sizes: WIDE,
    readmeImage: "source-control",
  },
);

defineScenario("readme-editor", findScenario, {
  description: "README: the code viewer with the find bar",
  themes: THEMES,
  sizes: WIDE,
  readmeImage: "editor",
});

defineScenario(
  "readme-search",
  async (app) => {
    await search(app, "TaskStore");
    for (let i = 0; i < 4; i++) await app.tui.press("down");
    await app.tui.press("enter");
    await app.tui.act(() => app.ctx.focus.focus("sidebar"));
  },
  {
    description: "README: project search with a match open",
    themes: THEMES,
    sizes: WIDE,
    readmeImage: "search",
  },
);

defineScenario(
  "readme-ai-panel",
  async (app) => {
    await app.tui.act(() => {
      app.ctx.editors.open({ kind: "file", resource: "src/server/middleware/rate-limit.ts" });
      app.ctx.layout.setSidebarVisible(false);
    });
    await app.tui.act(() => app.ctx.commands.execute("ai.newSession"));
    await until(app, () => app.tui.frame().includes("Apply the change"));
  },
  {
    description: "README: a Claude Code session beside the file it talks about",
    themes: THEMES,
    sizes: WIDE,
    mount: agentMount(),
    readmeImage: "ai-panel",
  },
);

defineScenario(
  "readme-settings",
  async (app) => {
    await app.tui.act(async () => {
      await app.ctx.config.set("ui.animations", false, { persist: false });
      await app.ctx.config.set("editor.wrap", true, { persist: false });
    });
    await app.tui.act(() => app.ctx.commands.execute("settings.open"));
    for (let i = 0; i < 5; i++) await app.tui.press("down");
  },
  { description: "README: the Settings editor", themes: THEMES, sizes: WIDE, readmeImage: "settings" },
);
