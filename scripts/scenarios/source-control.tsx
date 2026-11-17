/**
 * Source Control screenshots against the demo workspace (real, isolated Git state): the panel
 * with every group, unified and split diffs, the commit box, the discard confirmation, the
 * branch picker, the merge-conflict variant and the no-repository state.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type DemoWorkspace, isolatedGitEnv } from "@/app/demo";
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

/**
 * A folder holding three projects (not a repository itself), built on first use and removed
 * when the screenshot run exits. Git runs with the demo's isolated environment.
 */
let multiRepoBuilt: { root: string; containerDir: string } | null = null;

function buildMultiRepo(): { root: string; containerDir: string } {
  if (multiRepoBuilt) return multiRepoBuilt;
  const containerDir = realpathSync(mkdtempSync(join(tmpdir(), "lucy-scm-multi-")));
  process.on("exit", () => rmSync(containerDir, { recursive: true, force: true }));
  const root = join(containerDir, "Documents");
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...isolatedGitEnv(containerDir) }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, env });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  };
  const repo = (path: string, files: Record<string, string>) => {
    const dir = join(root, path);
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "--template=", "--initial-branch=main");
    git(dir, "config", "user.name", "Ayşe Yılmaz");
    git(dir, "config", "user.email", "ayse@example.invalid");
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "Initial commit");
    return dir;
  };
  const api = repo("orbit-api", {
    "src/server.ts": "export const port = 8080;\n",
    "README.md": "# Orbit API\n",
  });
  writeFileSync(join(api, "src/server.ts"), 'export const port = 9090;\nexport const host = "0.0.0.0";\n');
  writeFileSync(join(api, "src/routes.ts"), "export const routes = [];\n");
  git(api, "add", "src/routes.ts");
  const web = repo("orbit-web", { "src/App.tsx": "export function App() {}\n" });
  writeFileSync(join(web, "src/theme.css"), ":root { color-scheme: dark; }\n");
  const infra = repo("work/infra/terraform", { "main.tf": "terraform {}\n" });
  writeFileSync(join(infra, "main.tf"), 'terraform {\n  required_version = ">= 1.6"\n}\n');
  mkdirSync(join(root, "notes"));
  writeFileSync(join(root, "notes", "todo.md"), "- review\n");
  multiRepoBuilt = { root, containerDir };
  return multiRepoBuilt;
}

export const multiRepoDemo = {
  get root() {
    return buildMultiRepo().root;
  },
  get containerDir() {
    return buildMultiRepo().containerDir;
  },
  originDir: "",
  description: {},
  dispose: () => {},
} as unknown as DemoWorkspace;

export async function multiRepoScenario(app: ScenarioContext): Promise<void> {
  await app.tui.act(() => app.ctx.commands.execute("view.showSourceControl"));
  await until(app, () => app.tui.frame().includes("terraform"), 8000);
  await app.tui.act(() => app.ctx.focus.focus("sidebar"));
  await app.tui.clickText("theme.css");
  await until(app, () => app.tui.frame().includes("color-scheme"), 8000);
}

defineScenario("scm-multi-repo", multiRepoScenario, {
  description: "A folder with three repositories, each shown separately",
  sizes: PANEL_SIZES,
  mount: { demoWorkspace: multiRepoDemo, settings: { "git.repositoryScanDepth": 3 } },
});
