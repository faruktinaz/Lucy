/**
 * Acceptance tests for the workspaces and configurations real users bring on day one, through
 * the whole app (`mountApp`): empty and non-Git folders, non-ASCII and very long paths, broken
 * and empty config files, a workspace opened below a repository root, a large tree, and the
 * first-run onboarding path.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configFilePath } from "@/core/config/load";
import { createTestDirs, type MountedApp, mountApp } from "../helpers/app";
import { createFixtureRepo, createTempDir } from "../helpers/git-fixture";
import { withSettings } from "../settings/helpers";

setDefaultTimeout(60_000);

const SIZE = { width: 120, height: 35 } as const;

async function until(
  app: MountedApp,
  label: string,
  predicate: () => boolean,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline)
      throw new Error(`Timed out waiting for ${label}. Frame:\n${app.tui.frame()}`);
    await app.tui.advance(10);
  }
}

const has = (app: MountedApp, text: string) => () => app.tui.frame().includes(text);

/** Opens Quick Open, types `query` and waits until `expected` is listed. */
async function quickOpen(app: MountedApp, query: string, expected: string): Promise<void> {
  await app.tui.press("p", { ctrl: true });
  await until(app, "quick open", has(app, "Search files by name"));
  await app.tui.type(query);
  await until(app, `quick open lists ${expected}`, has(app, expected));
}

describe("unusual workspaces", () => {
  test("an empty folder: explorer, quick open and search explain themselves", async () => {
    const app = await mountApp(SIZE);
    expect(app.tui.frame()).toContain("This folder is empty");
    await app.tui.press("p", { ctrl: true });
    await until(app, "quick open empty state", has(app, "No files in this workspace"));
    await app.tui.press("escape");
    await app.tui.act(() => app.ctx.commands.execute("view.showSearch"));
    await app.tui.type("anything");
    await until(app, "search empty state", has(app, "No results"));
  });

  test("a folder that is not a Git repository: Source Control says so and offers a way on", async () => {
    const dir = createTempDir();
    const isolation = await createFixtureRepo({ init: false });
    try {
      writeFileSync(join(dir.path, "notes.txt"), "plain folder\n");
      const app = await mountApp({
        ...SIZE,
        workspace: { root: dir.path },
        git: "real",
        gitEnv: isolation.env,
        startBackground: true,
      });
      await app.tui.act(() => app.ctx.commands.execute("view.showSourceControl"));
      await until(app, "no-repository state", has(app, "No Git repository"));
      expect(app.tui.frame()).toContain("Run `git");
      // Everything else keeps working.
      await quickOpen(app, "notes", "notes.txt");
      await app.tui.press("enter");
      await until(app, "file content", has(app, "plain folder"));
      await app.dispose();
    } finally {
      isolation.dispose();
      dir.dispose();
    }
  });

  test("Turkish file names and a very long path: open, search, quick open", async () => {
    const deep = `${Array.from({ length: 16 }, (_, i) => `çok-uzun-klasör-adı-${i}`).join("/")}/ğüşiöç-dosyası.ts`;
    const app = await mountApp({
      ...SIZE,
      files: {
        "belgeler/çalışma-notları.md": "# Çalışma notları\n\nMerhaba dünya, ışık ve gölge.\n",
        [deep]: "export const selam = 'İstanbul';\n",
      },
    });
    expect(deep.length).toBeGreaterThan(300);
    await quickOpen(app, "çalış", "çalışma-notları.md");
    await app.tui.press("enter");
    await until(app, "Turkish content", has(app, "Merhaba dünya, ışık ve gölge."));

    await quickOpen(app, "ğüşiöç", "ğüşiöç-dosyası.ts");
    await app.tui.press("enter");
    await until(app, "deep file content", has(app, "İstanbul"));

    await app.tui.act(() => app.ctx.commands.execute("view.showSearch"));
    await app.tui.type("İstanbul");
    await until(app, "search result in the deep file", has(app, "1 result in 1 file"));
    expect(app.tui.frame()).toContain("ğüşiöç-dosyası.ts");
  });

  test("a workspace opened in a subdirectory of a repository", async () => {
    const repo = await createFixtureRepo({
      files: { "README.md": "root\n", "packages/app/src/main.ts": "export const a = 1;\n" },
      commit: "Initial",
    });
    try {
      await repo.write("packages/app/src/main.ts", "export const a = 2;\n");
      await repo.write("packages/app/new-file.ts", "export {};\n");
      const app = await mountApp({
        ...SIZE,
        workspace: { root: join(repo.root, "packages", "app") },
        git: "real",
        gitEnv: repo.env,
        startBackground: true,
      });
      // The explorer shows the subdirectory, not the repository root.
      await until(app, "explorer", has(app, "src"));
      expect(app.tui.frame()).not.toContain("README.md");
      await app.tui.act(() => app.ctx.commands.execute("view.showSourceControl"));
      await until(
        app,
        "changes",
        () => app.tui.frame().includes("main.ts") && app.tui.frame().includes("new-file.ts"),
      );
      // Open the diff from the list, as a user would: the group header, then its file.
      await app.tui.press("down");
      await app.tui.press("down");
      await app.tui.press("enter");
      await until(app, "diff of a file below the repository root", has(app, "export const a = 2;"));
      await app.dispose();
    } finally {
      repo.dispose();
    }
  });

  test("20,000 files: Quick Open stays responsive", async () => {
    const files: Record<string, string> = {};
    for (let dir = 0; dir < 200; dir++) {
      for (let file = 0; file < 100; file++) files[`pkg-${dir}/module-${dir}-${file}.ts`] = "";
    }
    const created = performance.now();
    const app = await mountApp({ ...SIZE, files });
    const mounted = performance.now();

    await app.tui.press("p", { ctrl: true });
    await until(app, "index ready", has(app, "module-0-0.ts"), 20_000);
    const indexed = performance.now();
    await app.tui.type("module-199-99");
    await until(app, "match", has(app, "module-199-99.ts"));
    const firstQuery = performance.now();
    await app.tui.press("backspace");
    await app.tui.press("backspace");
    await app.tui.type("42");
    await until(app, "refined match", has(app, "module-199-42.ts"));
    const refined = performance.now();
    console.log(
      `[20k files] mount ${Math.round(mounted - created)} ms, first list ${Math.round(indexed - mounted)} ms, ` +
        `query ${Math.round(firstQuery - indexed)} ms, refine ${Math.round(refined - firstQuery)} ms`,
    );
    expect(refined - indexed).toBeLessThan(3000);
  });
});

describe("configuration files", () => {
  test("a config.toml with a syntax error: the app starts on defaults and says so calmly", async () => {
    const dirs = createTestDirs();
    writeFileSync(configFilePath(dirs), "[ui\ntheme = 'unterminated\n");
    const app = await mountApp({ ...SIZE, dirs, files: { "a.txt": "content\n" } });
    await until(app, "notice", has(app, "config.toml has a syntax error"));
    expect(app.tui.frame()).toContain("Using the default");
    expect(app.tui.frame()).toContain("Show Problems");
    expect(app.ctx.config.get("ui.theme")).toBeDefined();
    await quickOpen(app, "a.txt", "a.txt");
  });

  test("an empty config.toml is simply the defaults", async () => {
    const dirs = createTestDirs();
    writeFileSync(configFilePath(dirs), "");
    const app = await mountApp({ ...SIZE, dirs });
    await app.tui.advance(100);
    expect(app.ctx.config.problems).toEqual([]);
    expect(app.ctx.notifications.store.get().toasts).toEqual([]);
    expect(app.tui.frame()).toContain("This folder is empty");
  });
});

describe("first run", () => {
  test("the onboarding overlay shows, and Escape skips it without writing a config file", async () => {
    const app = await mountApp({ ...SIZE, features: withSettings({ onboarding: "always" }) });
    await until(app, "onboarding", () => app.ctx.overlays.layers.some((layer) => layer.id === "onboarding"));
    await until(app, "first step", has(app, "Pick a color theme"));
    await app.tui.press("escape");
    await until(app, "skipped", () => app.ctx.overlays.layers.length === 0);
    expect(existsSync(configFilePath(app.dirs))).toBe(false);
  });

  for (const [label, keys] of [
    ["Ctrl+Q", [["q", { ctrl: true }]]],
    [
      "the leader form Ctrl+\\ Q",
      [
        ["\\", { ctrl: true }],
        ["q", {}],
      ],
    ],
  ] as const) {
    test(`${label} quits from the onboarding overlay`, async () => {
      let quits = 0;
      const app = await mountApp({
        ...SIZE,
        features: withSettings({ onboarding: "always" }),
        onQuit: () => {
          quits++;
        },
      });
      await until(app, "first step", has(app, "Pick a color theme"));
      for (const [key, modifiers] of keys) await app.tui.press(key, modifiers);
      await until(app, "quit", () => quits === 1);
    });
  }

  test("the shortcut recorder keeps Ctrl+Q as a key to record", async () => {
    let quits = 0;
    const app = await mountApp({
      ...SIZE,
      onQuit: () => {
        quits++;
      },
    });
    await app.tui.act(() => app.ctx.commands.execute("keybindings.open"));
    await until(app, "shortcuts editor", has(app, "Search by command"));
    await app.tui.type("app.quit");
    await app.tui.press("down");
    await app.tui.press("enter");
    const capturing = () => app.ctx.overlays.layers.some((layer) => layer.id === "keybindingCapture");
    await until(app, "capture overlay", capturing);
    await app.tui.press("q", { ctrl: true });
    await app.tui.advance(50);
    expect(quits).toBe(0);
    expect(capturing()).toBe(true);
    expect(app.tui.frame()).toContain("Ctrl+Q");
  });
});

describe("status bar", () => {
  test("an ambient hint is shown in full; lower-priority items make room", async () => {
    const app = await mountApp({ width: 90, height: 28 });
    for (let i = 0; i < 6; i++) {
      app.ctx.statusBar.register({
        id: `test.item${i}`,
        alignment: "right",
        priority: i,
        text: `item-${i}-wide`,
      });
    }
    await app.tui.act(() => app.ctx.hints.setAmbient(app, { text: "Leave the terminal", keys: "ctrl+\\" }));
    const bar = app.tui.frame().split("\n").at(-2) ?? "";
    expect(bar).toContain("Leave the terminal  Ctrl+\\");
    // The highest-priority item still shows; the lowest one made room.
    expect(bar).toContain("item-5-wide");
    expect(bar).not.toContain("item-0-wide");
  });
});
