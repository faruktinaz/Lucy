/**
 * `bun run screenshots`: renders registered scenarios against the demo workspace and writes
 * `docs/screenshots/<theme>/<scenario>-<cols>x<rows>.{png,svg,txt}`.
 *
 *   bun run screenshots                       every scenario, its themes and sizes
 *   bun run screenshots --only shell,palette  some scenarios
 *   bun run screenshots --theme high-contrast one theme
 *   bun run screenshots --no-png              skip the browser (txt and svg only)
 *
 * Feature engineers add scenarios in `scripts/scenarios/<feature>.ts(x)`; every file there is
 * loaded before the run:
 *
 *   import { defineScenario } from "../screenshots";
 *   defineScenario("explorer-expanded", async ({ ctx, tui }) => {
 *     await ctx.run("view.showExplorer");
 *     await tui.press("down");
 *   });
 *
 * Scenarios use the Nerd Font icon tier (the renderer draws with JetBrainsMono Nerd Font) and
 * a demo workspace whose Git state shows every Source Control situation. Nothing touches the
 * user's directories: config, state, cache and the Tree-sitter data dir are temporary.
 */
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { CodeRenderable, type Renderable } from "@opentui/core";
import { buildDemoWorkspace, type DemoWorkspace } from "@/app/demo";
import { THEME_IDS, type ThemeId } from "@/themes";
import { type MountAppOptions, type MountedApp, mountApp } from "../tests/helpers/app";
import { saveScreenshot } from "./screenshot";

export interface ScreenshotSize {
  readonly cols: number;
  readonly rows: number;
}

export const SIZES = {
  wide: { cols: 120, rows: 35 },
  medium: { cols: 90, rows: 28 },
  narrow: { cols: 70, rows: 24 },
} as const satisfies Record<string, ScreenshotSize>;

export interface ScenarioContext extends MountedApp {
  readonly theme: ThemeId;
  readonly size: ScreenshotSize;
}

export interface ScenarioOptions {
  /** Default: wide, medium and narrow. */
  readonly sizes?: readonly ScreenshotSize[];
  /** Default: Catppuccin Mocha and High Contrast. */
  readonly themes?: readonly ThemeId[];
  /** Extra mount options (settings, a conflict demo, ...). */
  readonly mount?: Partial<MountAppOptions>;
  readonly description?: string;
  /**
   * Also copy the PNG to `docs/images/<readmeImage>.png` (the committed README images; only
   * with the default output folder). Give such a scenario exactly one theme and size.
   */
  readonly readmeImage?: string;
}

interface Scenario {
  readonly name: string;
  readonly run: (context: ScenarioContext) => Promise<void> | void;
  readonly options: ScenarioOptions;
}

const registry: Scenario[] = [];

/** Registers a screenshot scenario. Names are file names: lowercase words joined by dashes. */
export function defineScenario(
  name: string,
  run: (context: ScenarioContext) => Promise<void> | void,
  options: ScenarioOptions = {},
): void {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) throw new Error(`Scenario name "${name}" must be kebab-case`);
  if (registry.some((scenario) => scenario.name === name))
    throw new Error(`Scenario "${name}" is defined twice`);
  registry.push({ name, run, options });
}

export function listScenarios(): readonly { name: string; description?: string }[] {
  return registry.map((s) => ({ name: s.name, description: s.options.description }));
}

const DEFAULT_OUT_DIR = resolve(import.meta.dir, "..", "docs", "screenshots");
const README_IMAGES_DIR = resolve(import.meta.dir, "..", "docs", "images");

const DEFAULT_THEMES: readonly ThemeId[] = ["catppuccin-mocha", "high-contrast"];
const DEFAULT_SIZES: readonly ScreenshotSize[] = [SIZES.wide, SIZES.medium, SIZES.narrow];

/** Polls in real time until `predicate` holds (settling the TUI between checks). */
export async function until(app: MountedApp, predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("Timed out waiting for a scenario condition");
    await app.tui.advance(20);
  }
  await app.tui.settle();
}

/** Visible code views with a language, whose syntax colors come from the highlighter worker. */
function highlightableCodeViews(app: MountedApp): CodeRenderable[] {
  const found: CodeRenderable[] = [];
  const walk = (node: Renderable) => {
    if (!node.visible) return;
    if (node instanceof CodeRenderable) {
      if (node.filetype && node.content.trim() !== "" && node.width > 0 && node.height > 0) found.push(node);
      return;
    }
    for (const child of node.getChildren()) walk(child);
  };
  walk(app.tui.renderer.root);
  return found;
}

/** Distinct foreground colors of the non-blank cells inside a code view. */
function colorsInside(app: MountedApp, view: CodeRenderable): number {
  const frame = app.tui.spans();
  const colors = new Set<string>();
  const left = view.screenX;
  const right = left + view.width;
  for (let y = Math.max(0, view.screenY); y < Math.min(frame.rows, view.screenY + view.height); y++) {
    let x = 0;
    for (const span of frame.lines[y]?.spans ?? []) {
      if (x < right && x + span.width > left && span.text.trim() !== "") colors.add(span.fg.toInts().join());
      x += span.width;
    }
  }
  return colors.size;
}

/**
 * Waits until every visible code view shows its syntax colors. Highlighting runs in a worker
 * (cold start about 250 ms), so a fixed delay is either slow or flaky, and a color count over
 * the whole frame cannot tell (the chrome is colored anyway). This looks at each code view's
 * own cells: done when its highlighter is idle and the code shows at least three colors.
 * Without a code view on screen it returns at once. The runner calls it before every capture.
 */
export async function untilHighlighted(app: MountedApp, timeoutMs = 8000): Promise<void> {
  const done = () =>
    highlightableCodeViews(app).every((view) => !view.isHighlighting && colorsInside(app, view) >= 3);
  const deadline = performance.now() + timeoutMs;
  while (!done()) {
    if (performance.now() > deadline) throw new Error("Timed out waiting for syntax highlighting");
    await app.tui.advance(20);
  }
  await app.tui.settle();
}

/** Mounts the demo workspace for a scenario and waits until Git status is on screen. */
async function mountScenario(
  demo: DemoWorkspace,
  theme: ThemeId,
  size: ScreenshotSize,
  extra: Partial<MountAppOptions>,
): Promise<MountedApp> {
  const app = await mountApp({
    demoWorkspace: demo,
    git: "real",
    width: size.cols,
    height: size.rows,
    startBackground: true,
    ...extra,
    settings: { "ui.icons": "nerd", "workspace.watch": false, ...extra.settings, "ui.theme": theme },
  });
  await until(
    app,
    () => app.ctx.services.git.state.status !== null || app.ctx.services.git.state.error !== null,
  );
  return app;
}

interface RunOptions {
  only?: readonly string[];
  themes?: readonly ThemeId[];
  png: boolean;
  outDir: string;
}

function parseArgs(argv: readonly string[]): RunOptions {
  const options: RunOptions = { png: true, outDir: DEFAULT_OUT_DIR };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--only") options.only = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (arg === "--theme") {
      const theme = argv[++i] ?? "";
      if (!(THEME_IDS as readonly string[]).includes(theme)) throw new Error(`Unknown theme "${theme}"`);
      options.themes = [theme as ThemeId];
    } else if (arg === "--no-png") options.png = false;
    else if (arg === "--out") options.outDir = resolve(argv[++i] ?? options.outDir);
    else throw new Error(`Unknown option "${arg}"`);
  }
  return options;
}

async function loadScenarioFiles(): Promise<void> {
  registerBuiltInScenarios();
  const dir = join(import.meta.dir, "scenarios");
  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((file) => /\.tsx?$/.test(file))
      .sort();
  } catch {
    return;
  }
  for (const file of files) await import(join(dir, file));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  // Same isolation as the test preload: nothing may touch the user's directories.
  const scratch = mkdtempSync(join(tmpdir(), "lucy-screenshots-"));
  process.env.XDG_DATA_HOME = join(scratch, "data");
  process.env.LUCY_TEST_ROOT = scratch;
  for (const name of ["CONFIG", "STATE", "CACHE"])
    process.env[`LUCY_${name}_DIR`] = join(scratch, name.toLowerCase());

  await loadScenarioFiles();
  const selected = registry.filter((s) => !options.only || options.only.includes(s.name));
  if (selected.length === 0) throw new Error("No scenario matched");

  const demo = await buildDemoWorkspace();
  const conflictDemo = selected.some((s) => s.options.mount?.demoConflict)
    ? await buildDemoWorkspace({ withConflict: true })
    : null;
  let written = 0;
  const started = performance.now();
  try {
    for (const scenario of selected) {
      const themes = options.themes ?? scenario.options.themes ?? DEFAULT_THEMES;
      for (const theme of themes) {
        for (const size of scenario.options.sizes ?? DEFAULT_SIZES) {
          const workspace = scenario.options.mount?.demoConflict && conflictDemo ? conflictDemo : demo;
          const app = await mountScenario(workspace, theme, size, scenario.options.mount ?? {});
          try {
            await scenario.run({ ...app, theme, size });
            await untilHighlighted(app);
            const base = join(options.outDir, theme, `${scenario.name}-${size.cols}x${size.rows}`);
            const saved = await saveScreenshot(app.tui.spans(), base, { png: options.png });
            rmSync(saved.html, { force: true });
            written++;
            const readme = scenario.options.readmeImage;
            if (readme && saved.png.status === "written" && options.outDir === DEFAULT_OUT_DIR) {
              copyFileSync(saved.png.path, join(README_IMAGES_DIR, `${readme}.png`));
              console.log(`docs/images/${readme}.png`);
            }
            const png =
              saved.png.status === "written"
                ? "png"
                : `no png (${saved.png.status === "skipped" || saved.png.status === "failed" ? saved.png.reason : ""})`;
            console.log(`${relative(process.cwd(), base)}  ${png}`);
          } finally {
            await app.dispose();
          }
        }
      }
    }
  } finally {
    demo.dispose();
    conflictDemo?.dispose();
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`${written} screenshots in ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

// --------------------------------------------------------------------------- scenarios

/** Opens files as regular (non-preview) tabs; the last one is active. */
async function openFiles(
  app: MountedApp,
  paths: readonly string[],
  options: { preview?: boolean } = {},
): Promise<void> {
  await app.tui.act(() => {
    for (const path of paths)
      app.ctx.editors.open({ kind: "file", resource: path }, { preview: options.preview });
  });
}

/** The workbench's own scenarios. Registered at run time, never on import. */
function registerBuiltInScenarios(): void {
  defineScenario("shell", () => {}, {
    description: "The default shell: Explorer, Welcome, status bar with Git",
    themes: [...THEME_IDS],
  });

  defineScenario("shell-compact", () => {}, {
    description: "Compact density: tighter padding and gaps, same structure",
    sizes: [SIZES.wide],
    mount: { settings: { "ui.density": "compact" } },
  });

  defineScenario("shell-unicode-icons", () => {}, {
    description: "The default icon tier (no Nerd Font required)",
    sizes: [SIZES.wide],
    mount: { settings: { "ui.icons": "unicode" } },
  });

  defineScenario(
    "workbench",
    async (app) => {
      await openFiles(app, ["README.md", "src/main.ts", "package.json"]);
      await openFiles(app, ["CHANGELOG.md"], { preview: true });
      await app.tui.act(() => {
        app.ctx.layout.setBottomVisible(true);
        app.ctx.layout.setAuxiliaryVisible(true);
        app.ctx.layout.showSidebarView("scm");
        app.ctx.focus.focus("editor");
      });
    },
    {
      description:
        "Every region: tabs (one preview), breadcrumb, bottom panel, AI panel, Source Control badge",
    },
  );

  defineScenario(
    "command-palette",
    async (app) => {
      await app.tui.act(() => app.ctx.commands.execute("palette.show"));
      await app.tui.type("toggle");
    },
    { description: "The command palette filtering commands with fuzzy highlights" },
  );

  defineScenario(
    "quick-open",
    async (app) => {
      await app.tui.act(() => app.ctx.commands.execute("file.quickOpen"));
      await app.tui.type("conf");
      await until(app, () => app.ctx.quickPick.state.items.length > 0);
    },
    { description: "Go to File with fuzzy file matches", sizes: [SIZES.wide, SIZES.medium] },
  );

  defineScenario(
    "theme-picker",
    async (app) => {
      void app.ctx.commands.execute("theme.select");
      await app.tui.settle();
      await app.tui.press("down");
    },
    { description: "The theme picker live-previewing the next theme", sizes: [SIZES.wide, SIZES.medium] },
  );

  defineScenario(
    "confirm-dialog",
    async (app) => {
      await openFiles(app, ["src/main.ts"]);
      void app.ctx.dialogs.confirm({
        title: "Discard changes in 3 files?",
        message:
          "Your edits to these files will be lost. Untracked files are deleted. This cannot be undone.",
        confirmLabel: "Discard Changes",
        danger: true,
      });
      await app.tui.settle();
    },
    { description: "A destructive confirm with the safe action focused" },
  );

  defineScenario(
    "toast",
    async (app) => {
      await app.tui.act(() => {
        app.ctx.notifications.success("Committed 3 files", "feature/command-palette is 2 commits ahead.");
        app.ctx.notifications.show({
          severity: "error",
          title: "Push failed",
          message: "The remote rejected the update: fetch first, then try again.",
          actions: [
            { label: "Fetch now", run: () => {} },
            { label: "Show log", run: () => {} },
          ],
        });
      });
    },
    { description: "Toasts above the status bar" },
  );

  defineScenario(
    "context-menu",
    async (app) => {
      await openFiles(app, ["README.md", "src/main.ts"]);
      const tab = app.tui.findText("README.md");
      if (!tab) throw new Error("The README.md tab is not on screen");
      await app.tui.click(tab.x, tab.y, { button: "right" });
      await app.tui.press("down");
    },
    {
      description: "A tab's context menu at the pointer, keyboard highlighted",
      sizes: [SIZES.wide, SIZES.medium],
    },
  );

  defineScenario(
    "zen",
    async (app) => {
      await openFiles(app, ["src/main.ts"]);
      await app.tui.act(() => app.ctx.commands.execute("view.toggleZenMode"));
      await app.tui.act(() => app.ctx.notifications.dismissAll());
    },
    { description: "Zen mode: only the editor", sizes: [SIZES.wide] },
  );

  defineScenario(
    "narrow-drawer",
    async (app) => {
      await app.tui.act(() => app.ctx.commands.execute("view.showSourceControl"));
    },
    { description: "Below 80 columns a side view opens as a drawer over the editor", sizes: [SIZES.narrow] },
  );

  defineScenario(
    "gallery",
    async (app) => {
      await app.tui.act(() => app.ctx.commands.execute("developer.showComponentGallery"));
      await app.tui.act(() => app.ctx.layout.setZen(true));
    },
    {
      description: "Every primitive in every state",
      sizes: [{ cols: 124, rows: 62 }],
      themes: [...THEME_IDS],
    },
  );
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
