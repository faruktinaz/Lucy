/**
 * The README images (`docs/images/*.png`): one theme, one size each, copied there by the
 * runner (`readmeImage`). Regenerate them all with
 *
 *   bun run screenshots --only readme-hero,readme-source-control,readme-editor,readme-search,readme-ai-panel,readme-settings
 */
import { defineScenario, type ScenarioContext, until } from "../screenshots";
import { agentMount } from "./ai";
import { editedScenario } from "./editor";
import { prepare } from "./explorer";
import { search } from "./search";
import { multiRepoDemo } from "./source-control";

const THEMES = ["catppuccin-mocha"] as const;
const WIDE = [{ cols: 120, rows: 35 }];

/** The editor, search and settings images show their view without the agent panel. */
async function withoutAgentPanel(app: ScenarioContext): Promise<void> {
  await app.tui.act(() => app.ctx.layout.setAuxiliaryVisible(false));
}

defineScenario(
  "readme-hero",
  async (app) => {
    await prepare(app);
    await app.tui.act(() => app.ctx.commands.execute("ai.newSession"));
    await until(app, () => app.tui.frame().includes("Apply the change"));
    await app.tui.act(() => app.ctx.focus.focus("editor"));
  },
  {
    description: "README hero: Files, a highlighted file and a Claude Code session",
    themes: THEMES,
    sizes: [{ cols: 150, rows: 42 }],
    mount: agentMount(),
    readmeImage: "hero",
  },
);

defineScenario(
  "readme-source-control",
  async (app) => {
    await withoutAgentPanel(app);
    await app.tui.act(() => app.ctx.commands.execute("view.showSourceControl"));
    await until(app, () => app.tui.frame().includes("terraform"), 8000);
    await app.tui.act(() => app.ctx.focus.focus("sidebar"));
    // A modified file: its diff shows a removed and two added lines.
    await app.tui.clickText("server.ts");
    await until(app, () => app.tui.frame().includes("9090"), 8000);
  },
  {
    description: "README: Source Control over a folder with three repositories, with a diff",
    themes: THEMES,
    sizes: WIDE,
    mount: { demoWorkspace: multiRepoDemo, settings: { "git.repositoryScanDepth": 3 } },
    readmeImage: "source-control",
  },
);

defineScenario(
  "readme-editor",
  async (app) => {
    await withoutAgentPanel(app);
    await editedScenario(app);
  },
  {
    description: "README: a file edited in place, not yet saved",
    themes: THEMES,
    sizes: WIDE,
    // Auto save is off so the unsaved state stays on screen.
    mount: { settings: { "editor.autosave": "off" } },
    readmeImage: "editor",
  },
);

defineScenario(
  "readme-search",
  async (app) => {
    await withoutAgentPanel(app);
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
    await withoutAgentPanel(app);
    await app.tui.act(async () => {
      await app.ctx.config.set("ui.animations", false, { persist: false });
      await app.ctx.config.set("editor.wrap", true, { persist: false });
    });
    await app.tui.act(() => app.ctx.commands.execute("settings.open"));
    for (let i = 0; i < 5; i++) await app.tui.press("down");
  },
  { description: "README: the Settings editor", themes: THEMES, sizes: WIDE, readmeImage: "settings" },
);
