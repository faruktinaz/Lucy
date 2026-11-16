import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestDirs } from "../helpers/app";
import { clickText, focusExplorer, mountExplorer, selectedKey, sidebarFrame, waitUntil } from "./helpers-ui";

const FILES = {
  "src/main.ts": "export {}\n",
  "src/components/Button.tsx": "",
  "src/çalışma-notları.md": "",
  "docs/İçerik.md": "",
  "a-very-long-file-name-that-will-certainly-not-fit-in-the-sidebar.ts": "",
  ".env": "SECRET=1\n",
  "README.md": "# hi\n",
};

describe("tree rendering", () => {
  for (const size of [
    { cols: 120, rows: 35 },
    { cols: 90, rows: 28 },
  ]) {
    test(`text snapshot ${size.cols}x${size.rows}`, async () => {
      const app = await mountExplorer({ files: FILES, width: size.cols, height: size.rows });
      await focusExplorer(app);
      await app.tui.act(() => app.controller.model.reveal("src/components/Button.tsx"));
      await app.tui.settle();
      // Row 0 is the command bar (random workspace name); the explorer starts at its header.
      expect(sidebarFrame(app).split("\n").slice(1).join("\n")).toMatchSnapshot();
    });
  }

  test("long and Turkish names are truncated to the row; nothing overflows the sidebar", async () => {
    const app = await mountExplorer({ files: FILES });
    await app.tui.act(() => app.controller.model.reveal("docs/İçerik.md"));
    const frame = sidebarFrame(app);
    expect(frame).toContain("İçerik.md");
    expect(frame).toContain("a-very-long-file-name");
    expect(frame).toContain("…");
    const width = app.ctx.layout.effective.get().sidebar.width + 4;
    for (const line of app.tui.frame().split("\n").slice(2, 10)) {
      // The row ends inside the sidebar: the next column belongs to the editor.
      expect(line.slice(width, width + 2).trim()).not.toBe("…");
    }
  });
});

describe("keyboard", () => {
  test("arrows, home/end, left/right, enter keeps a file open, space previews, type-ahead", async () => {
    const app = await mountExplorer({ files: FILES });
    await focusExplorer(app);
    await app.tui.press("down");
    expect(selectedKey(app)).toBe("docs");
    await app.tui.press("right");
    await waitUntil(app, () => sidebarFrame(app).includes("İçerik.md"));
    await app.tui.press("right");
    expect(selectedKey(app)).toBe("docs/İçerik.md");
    await app.tui.press("left");
    expect(selectedKey(app)).toBe("docs");
    await app.tui.press("left");
    expect(sidebarFrame(app)).not.toContain("İçerik.md");
    await app.tui.press("end");
    expect(selectedKey(app)).toBe("README.md");
    await app.tui.press("space");
    expect(app.ctx.editors.active).toMatchObject({ resource: "README.md", preview: true });
    expect(app.ctx.focus.current).toBe("sidebar");
    await app.tui.press("home");
    expect(selectedKey(app)).toBe("docs");
    await app.tui.press("m"); // No top-level name starts with m: nothing changes.
    expect(selectedKey(app)).toBe("docs");
    await app.tui.advance(1100); // Past the type-ahead pause: "s" starts a new prefix.
    await app.tui.press("s");
    expect(selectedKey(app)).toBe("src");
    await app.tui.press("end");
    await app.tui.press("enter");
    expect(app.ctx.editors.active).toMatchObject({ resource: "README.md", preview: false });
    expect(app.ctx.focus.current).toBe("editor");
  });

  test("page keys move by a viewport in a large folder, which stays responsive", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20_000; i++) files[`big/file-${String(i).padStart(5, "0")}.ts`] = "";
    const app = await mountExplorer({ files });
    await focusExplorer(app);
    await app.tui.press("down");
    const started = performance.now();
    await app.tui.press("right");
    await waitUntil(app, () => sidebarFrame(app).includes("file-00000.ts"), 10_000);
    const expandMs = performance.now() - started;
    const keyStarted = performance.now();
    await app.tui.press("pagedown");
    await app.tui.press("pagedown");
    await app.tui.press("end");
    const keyMs = performance.now() - keyStarted;
    console.log(
      `[explorer-ui] 20k folder: expand ${expandMs.toFixed(0)} ms, 3 navigation keys ${keyMs.toFixed(0)} ms`,
    );
    expect(sidebarFrame(app)).toContain("Show 19,000 more…");
    await app.tui.press("enter");
    await waitUntil(app, () => sidebarFrame(app).includes("Show 18,000 more…"));
    expect(keyMs).toBeLessThan(2000);
  }, 60_000);
});

describe("mouse", () => {
  test("click previews, double-click keeps, clicking a folder toggles it, right click opens the menu", async () => {
    const app = await mountExplorer({ files: FILES });
    await clickText(app, "README.md");
    expect(app.ctx.editors.active).toMatchObject({ resource: "README.md", preview: true });
    expect(selectedKey(app)).toBe("README.md");
    const at = app.tui.findText("README.md");
    if (!at) throw new Error("README.md missing");
    await app.tui.doubleClick(at.x, at.y);
    expect(app.ctx.editors.active).toMatchObject({ resource: "README.md", preview: false });

    await clickText(app, "docs");
    await waitUntil(app, () => sidebarFrame(app).includes("İçerik.md"));
    await app.tui.advance(450); // A second click within 400 ms is a double-click, which keeps it open.
    await clickText(app, "docs");
    await waitUntil(app, () => !sidebarFrame(app).includes("İçerik.md"));

    await clickText(app, "src", { button: "right" });
    await app.tui.waitForText("Copy Relative Path");
    expect(app.tui.frame()).toContain("Rename…");
    expect(selectedKey(app)).toBe("src");
    await app.tui.press("escape");
  });
});

describe("create, rename, delete, undo", () => {
  test("create a nested file through the inline input with live validation", async () => {
    const app = await mountExplorer({ files: FILES });
    await focusExplorer(app);
    await app.tui.act(() => app.controller.model.reveal("src/main.ts"));
    await app.tui.press("ctrl+k");
    await app.tui.press("shift+f");
    await waitUntil(app, () => app.controller.model.store.get().edit !== null);
    await app.tui.type("main.ts");
    await waitUntil(app, () => sidebarFrame(app).includes("already"));
    for (let i = 0; i < "main.ts".length; i++) await app.tui.press("backspace");
    await app.tui.waitForText("Enter a name.");
    await app.tui.type("lib/util.ts");
    await waitUntil(app, () => !sidebarFrame(app).includes("already"));
    await app.tui.press("enter");
    await waitUntil(app, () => selectedKey(app) === "src/lib/util.ts");
    expect(await readFile(join(app.root, "src/lib/util.ts"), "utf8")).toBe("");
    expect(app.ctx.editors.active?.resource).toBe("src/lib/util.ts");
  });

  test("escape cancels; a failure from the file system stays visible in place", async () => {
    const app = await mountExplorer({ files: { "locked/a.txt": "", "b.txt": "" } });
    await chmod(join(app.root, "locked"), 0o500);
    try {
      await focusExplorer(app);
      await app.tui.act(() => app.controller.newEntry("folder"));
      await app.tui.type("x");
      await app.tui.press("escape");
      expect(app.controller.model.store.get().edit).toBeNull();
      await app.tui.act(() => app.controller.model.select("locked"));
      await app.tui.act(() => app.controller.newEntry("file"));
      await app.tui.type("new.txt");
      await app.tui.press("enter");
      await app.tui.waitForText("Permission denied");
      expect(app.controller.model.store.get().edit).not.toBeNull();
      await app.tui.press("escape");
    } finally {
      await chmod(join(app.root, "locked"), 0o755);
    }
  });

  test("F2 renames in place", async () => {
    const app = await mountExplorer({ files: FILES });
    await focusExplorer(app);
    await app.tui.act(() => app.controller.model.select("README.md"));
    await app.tui.press("f2");
    await waitUntil(app, () => app.controller.model.store.get().edit?.mode === "rename");
    for (let i = 0; i < "README.md".length; i++) await app.tui.press("backspace");
    await app.tui.type("İçindekiler.md");
    await app.tui.press("enter");
    await waitUntil(app, () => selectedKey(app) === "İçindekiler.md");
    expect(await readdir(app.root)).toContain("İçindekiler.md");
    expect(app.controller.model.store.get().edit).toBeNull();
  });

  test("Delete confirms in a danger dialog, moves to the undo trash, and the toast's Undo restores", async () => {
    const app = await mountExplorer({ files: FILES });
    await focusExplorer(app);
    await app.tui.act(() => app.controller.model.select("src"));
    await app.tui.press("delete");
    await app.tui.waitForText("Delete the folder “src” and the 4 items inside it?");
    expect(app.tui.frame()).toContain("undo trash");
    await app.tui.press("enter"); // The safe action has focus: nothing is deleted.
    await waitUntil(app, () => !app.tui.frame().includes("Delete the folder"));
    expect(await readdir(app.root)).toContain("src");

    await app.tui.press("delete");
    await app.tui.waitForText("Move to Trash");
    await app.tui.clickText("Move to Trash");
    await app.tui.waitForText("to Lucy's undo trash");
    expect(await readdir(app.root)).not.toContain("src");
    expect(sidebarFrame(app)).not.toContain("src");

    await app.tui.clickText("Undo");
    await waitUntil(app, () => sidebarFrame(app).includes("src"));
    expect(await readFile(join(app.root, "src/main.ts"), "utf8")).toBe("export {}\n");
    await app.tui.waitForText("Undone");
  });

  test("explorer.confirmDelete = false deletes without asking; explorer.undo restores", async () => {
    const app = await mountExplorer({ files: FILES, settings: { "explorer.confirmDelete": false } });
    await focusExplorer(app);
    await app.tui.act(() => app.controller.model.select("README.md"));
    await app.tui.press("delete");
    await waitUntil(app, () => !sidebarFrame(app).includes("README.md"));
    expect(app.tui.frame()).not.toContain("Move to Trash");
    await app.tui.press("ctrl+k");
    await app.tui.press("u");
    await waitUntil(app, () => sidebarFrame(app).includes("README.md"));
  });
});

describe("menus, filter, settings", () => {
  test("keyboard context menu, Copy Relative Path reports honestly when OSC 52 is unavailable", async () => {
    const app = await mountExplorer({ files: FILES });
    await focusExplorer(app);
    await app.tui.act(() => app.controller.model.select("README.md"));
    await app.tui.press("shift+f10");
    await app.tui.waitForText("Copy Relative Path");
    await app.tui.clickText("Copy Relative Path");
    // The test renderer has no clipboard: the user is told, with the path to copy by hand.
    await app.tui.waitForText("did not accept the copy");
  });

  test("the more menu toggles hidden files, persisted as a setting", async () => {
    const app = await mountExplorer({ files: FILES });
    expect(sidebarFrame(app)).toContain(".env");
    await app.tui.act(() => app.controller.showMoreMenu());
    await app.tui.waitForText("Show Ignored Files");
    await app.tui.clickText("Show Hidden Files");
    await waitUntil(app, () => !sidebarFrame(app).includes(".env"));
    expect(app.ctx.config.get("explorer.showHidden")).toBe(false);
    await app.tui.press("ctrl+k");
    await app.tui.press(".");
    await waitUntil(app, () => sidebarFrame(app).includes(".env"));
  });

  test("filter with / shows matches with a summary; escape clears", async () => {
    const app = await mountExplorer({ files: FILES });
    await focusExplorer(app);
    await app.tui.press("/");
    await waitUntil(app, () => app.controller.ui.get().filterOpen);
    await app.tui.type("button");
    await app.tui.waitForText("1 match");
    const frame = sidebarFrame(app);
    expect(frame).toContain("Button.tsx");
    expect(frame).not.toContain("README.md");
    await app.tui.press("escape");
    await waitUntil(app, () => sidebarFrame(app).includes("README.md"));
    expect(app.controller.ui.get().filterOpen).toBe(false);
  });

  test("explorer chords never collide with an unscoped binding", async () => {
    const app = await mountExplorer({});
    const rules = app.ctx.keybindings.all();
    const scoped = (rule: (typeof rules)[number]) => Boolean((rule as { when?: string }).when);
    const collisions = rules
      .filter((rule) => rule.command.startsWith("explorer."))
      .flatMap((mine) =>
        rules
          .filter((other) => !other.command.startsWith("explorer.") && other.key === mine.key)
          .filter((other) => !(scoped(mine) && scoped(other)))
          .map((other) => `${mine.key}: ${mine.command} vs ${other.command}`),
      );
    expect(collisions).toEqual([]);
    const { commandsWithoutLegacySafeBinding } = await import("@/core/keybindings");
    const { EXPLORER_KEYBINDINGS } = await import("@/features/explorer");
    expect(commandsWithoutLegacySafeBinding(EXPLORER_KEYBINDINGS)).toEqual([]);
  });

  test("palette lists the explorer commands", async () => {
    const app = await mountExplorer({ files: FILES });
    const listed = app.ctx.commands
      .list()
      .filter((command) => command.id.startsWith("explorer."))
      .map((command) => command.id);
    for (const id of [
      "explorer.newFile",
      "explorer.newFolder",
      "explorer.rename",
      "explorer.delete",
      "explorer.refresh",
      "explorer.collapseAll",
      "explorer.toggleHidden",
      "explorer.toggleIgnored",
      "explorer.revealActiveFile",
      "explorer.copyPath",
      "explorer.copyRelativePath",
      "explorer.undo",
      "explorer.filter",
    ]) {
      expect(listed).toContain(id);
    }
  });
});

describe("integration", () => {
  test("Git decorations from the Git service: letters and folder markers", async () => {
    const app = await mountExplorer({
      files: FILES,
      git: {
        changes: [
          { path: "src/main.ts", worktree: "modified", conflicted: false },
          { path: "README.md", worktree: "untracked", conflicted: false },
        ],
      },
    });
    await app.tui.act(() => app.ctx.services.git.refresh());
    await app.tui.act(() => app.controller.model.reveal("src/main.ts"));
    await app.tui.settle();
    const lines = sidebarFrame(app).split("\n");
    expect(
      lines
        .find((line) => line.includes("main.ts"))
        ?.trimEnd()
        .endsWith("M"),
    ).toBe(true);
    expect(
      lines
        .find((line) => line.includes("README.md"))
        ?.trimEnd()
        .endsWith("?"),
    ).toBe(true);
    expect(
      lines
        .find((line) => line.includes(" src"))
        ?.trimEnd()
        .endsWith("◉"),
    ).toBe(true);
  });

  test("follows the active editor tab: reveals and marks the file", async () => {
    const app = await mountExplorer({ files: FILES });
    await app.tui.act(() => app.ctx.editors.open({ kind: "file", resource: "src/components/Button.tsx" }));
    await waitUntil(app, () => selectedKey(app) === "src/components/Button.tsx");
    const row = app.controller.model
      .getRows(0, app.controller.model.store.get().rowCount)
      .find((candidate) => candidate.type === "entry" && candidate.path === "src/components/Button.tsx");
    expect(row).toMatchObject({ active: true });
  });

  test("watcher batches refresh the tree", async () => {
    const app = await mountExplorer({
      files: FILES,
      startBackground: true,
      settings: { "workspace.watch": true },
    });
    await writeFile(join(app.root, "fresh-from-disk.md"), "");
    await app.tui.waitForText("fresh-from-disk.md", { timeoutMs: 5000 });
    await rm(join(app.root, "fresh-from-disk.md"));
    await waitUntil(app, () => !sidebarFrame(app).includes("fresh-from-disk.md"), 5000);
  });

  test("expanded folders and the selection are restored in the next session", async () => {
    const dirs = createTestDirs();
    const first = await mountExplorer({ files: FILES, dirs });
    await first.tui.act(() => first.controller.model.reveal("src/components/Button.tsx"));
    await first.tui.advance(400); // Past the persistence debounce.
    const root = first.root;
    await first.app.dispose();

    const second = await mountExplorer({ workspace: { root }, dirs });
    expect(selectedKey(second)).toBe("src/components/Button.tsx");
    expect(sidebarFrame(second)).toContain("Button.tsx");
  });

  test("states: empty folder, unreadable root with retry", async () => {
    const empty = await mountExplorer({});
    expect(sidebarFrame(empty)).toContain("This folder is empty");
    expect(sidebarFrame(empty)).toContain("New File");

    const app = await mountExplorer({ files: { "a.txt": "" } });
    const moved = `${app.root}-moved`;
    await rm(moved, { recursive: true, force: true });
    await mkdir(moved);
    await rm(app.root, { recursive: true });
    await app.tui.act(() => app.controller.refresh());
    await app.tui.waitForText("Cannot read the workspace");
    expect(sidebarFrame(app)).toContain("The folder no longer exists");
    await mkdir(app.root);
    await writeFile(join(app.root, "back.txt"), "");
    await app.tui.clickText("Retry");
    await app.tui.waitForText("back.txt");
  });
});
