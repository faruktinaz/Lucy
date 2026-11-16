/**
 * Source Control screenshots against the demo workspace (real, isolated Git state): the panel
 * with every group, unified and split diffs, the commit box, the discard confirmation, the
 * branch picker, the merge-conflict variant and the no-repository state.
 */
import { defineScenario, type ScenarioContext, SIZES, until } from "../screenshots";

const PANEL_SIZES = [SIZES.wide, SIZES.medium];
const MULTI_HUNK_FILE = "src/server/routes/tasks.ts";

export async function showSourceControl(app: ScenarioContext): Promise<void> {
  await app.tui.act(() => app.ctx.commands.execute("view.showSourceControl"));
  await until(
    app,
    () => app.tui.frame().includes("STAGED CHANGES") || app.tui.frame().includes("No changes"),
  );
}

export async function openDiff(app: ScenarioContext, path: string, staged = false): Promise<void> {
  await app.tui.act(() => {
    app.ctx.editors.open({ kind: "diff", resource: path, params: staged ? { staged: true } : undefined });
  });
  await until(app, () => app.tui.frame().includes("@@"), 8000);
  // Syntax colors arrive from the highlighter worker a moment later.
  await app.tui.advance(400);
}

defineScenario(
  "scm-panel",
  async (app) => {
    await showSourceControl(app);
    await app.tui.press("down");
    await app.tui.press("down");
  },
  { description: "Source Control with staged, unstaged and untracked groups", sizes: PANEL_SIZES },
);

defineScenario(
  "scm-diff-unified",
  async (app) => {
    await showSourceControl(app);
    await openDiff(app, MULTI_HUNK_FILE);
    await app.tui.act(() => app.ctx.focus.focus("editor"));
    await app.tui.press("f7");
  },
  { description: "A multi-hunk working-tree diff in the unified layout", sizes: PANEL_SIZES },
);

defineScenario(
  "scm-diff-split",
  async (app) => {
    await showSourceControl(app);
    await openDiff(app, MULTI_HUNK_FILE);
    await app.tui.act(() => app.ctx.focus.focus("editor"));
    await app.tui.press("f7");
  },
  {
    description: "The same diff side by side at a wide size",
    sizes: [{ cols: 180, rows: 45 }],
  },
);

defineScenario(
  "scm-commit-box",
  async (app) => {
    await showSourceControl(app);
    await app.tui.act(() => app.ctx.commands.execute("git.focusCommitInput"));
    await app.tui.type("Add fuzzy matching to the command palette");
  },
  { description: "The commit box with a message, focused", sizes: PANEL_SIZES },
);

defineScenario(
  "scm-discard-confirm",
  async (app) => {
    await showSourceControl(app);
    await until(app, () => app.tui.frame().includes("tasks.ts"));
    await app.tui.act(() => app.ctx.focus.focus("sidebar"));
    await app.tui.clickText("tasks.ts");
    await app.tui.act(() => app.ctx.commands.execute("git.discard"));
    await until(app, () => app.tui.frame().includes("Cancel"));
  },
  { description: "Discarding asks first, with what would be lost", sizes: PANEL_SIZES },
);

defineScenario(
  "scm-branch-picker",
  async (app) => {
    await showSourceControl(app);
    await app.tui.act(() => {
      void app.ctx.commands.execute("git.checkout");
    });
    await until(app, () => app.tui.frame().includes("Create new branch"));
  },
  { description: "Switch Branch: create, local and remote branches", sizes: PANEL_SIZES },
);

defineScenario(
  "scm-conflict",
  async (app) => {
    await showSourceControl(app);
    await until(app, () => app.tui.frame().includes("MERGE CHANGES"));
  },
  {
    description: "A merge in progress with a conflicted file",
    sizes: PANEL_SIZES,
    mount: { demoConflict: true },
  },
);

defineScenario(
  "scm-no-repository",
  async (app) => {
    await app.tui.act(() => app.ctx.commands.execute("view.showSourceControl"));
    await until(app, () => app.tui.frame().includes("No Git repository"));
  },
  {
    description: "A folder that is not a Git repository",
    sizes: PANEL_SIZES,
    mount: {
      demoWorkspace: undefined,
      workspace: "temp",
      files: { "notes.md": "# Notes\n" },
      git: "real",
    },
  },
);
