import { describe, expect, test } from "bun:test";
import { FEATURES } from "@/app/features";
import type { RevealRequest } from "@/app/workbench/editors";
import { createSearchFeature, type SearchController } from "@/features/search";
import { mountApp } from "../helpers/app";
import { FakeSearch, match } from "../search-model/helpers";
import { stableWorkspace } from "../ui/support";

const FILES = {
  "a.ts": "const needle = 1;\nno match\nfoo(needle);\n",
  "dir/b.md": "\tNeedle in markdown\n",
  "c.txt": "nothing here\n",
};

/** The app with the Search feature built from `options` (to reach its controller or fake engine). */
function features(options: Parameters<typeof createSearchFeature>[0] = {}) {
  const holder: { controller?: SearchController } = {};
  const search = createSearchFeature({
    ...options,
    onController: (controller) => {
      holder.controller = controller;
    },
  });
  const list = FEATURES.map((feature) => (feature.id === "search" ? search : feature));
  return {
    list,
    get controller(): SearchController {
      if (!holder.controller) throw new Error("search feature not activated");
      return holder.controller;
    },
  };
}

/** The sidebar columns below the command bar (stable: no workspace name or path). */
function sidebar(frame: string, width: number): string {
  return frame
    .split("\n")
    .slice(1)
    .map((line) => [...line].slice(0, width).join("").trimEnd())
    .join("\n");
}

/** Polls in real time (settling between checks) until `predicate` holds. */
async function until(app: Awaited<ReturnType<typeof mountApp>>, predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out. Last frame:\n${app.tui.frame()}`);
    await app.tui.advance(10);
  }
}

async function openSearch(app: Awaited<ReturnType<typeof mountApp>>) {
  await app.tui.act(() => app.ctx.commands.execute("view.showSearch"));
}

describe("Search view with the real engine", () => {
  test("typing streams grouped results with the engine named and opens a match at its line", async () => {
    const f = features({ debounceMs: 20 });
    const app = await mountApp({ files: FILES, features: f.list });
    const reveals: RevealRequest[] = [];
    app.ctx.editors.onDidRequestReveal((request) => reveals.push(request));
    await openSearch(app);
    await app.tui.type("needle");
    await app.tui.waitForText("3 results in 2 files", { timeoutMs: 5000 });
    expect(f.controller.state.engine).toBe("builtin");
    const frame = app.tui.frame();
    expect(frame).toContain("a.ts");
    expect(frame).toContain("b.md");
    expect(frame).toContain("foo(needle);");

    // Down moves from the field into the results; Enter on a match opens a preview at its line.
    await app.tui.press("down");
    expect(f.controller.ui.get().focus).toBe("results");
    await app.tui.press("down");
    const selected = f.controller.model.getRow(f.controller.state.selectedIndex);
    expect(selected?.type).toBe("match");
    await app.tui.press("enter");
    const tab = app.ctx.editors.active;
    expect(tab?.kind).toBe("file");
    expect(tab?.preview).toBe(true);
    expect(reveals.at(-1)).toEqual({
      tabId: tab?.id ?? "",
      line: selected?.type === "match" ? selected.line : -1,
      column: selected?.type === "match" ? selected.column : -1,
    });

    // Left collapses the file, Escape returns to the field.
    await app.tui.press("left");
    await app.tui.press("left");
    expect(f.controller.model.getRows(0, 1)[0]).toMatchObject({ type: "file", collapsed: true });
    await app.tui.press("escape");
    expect(f.controller.ui.get().focus).toBe("pattern");
  }, 20_000);

  test("the toggles change the search, and keys typed after them reach the field", async () => {
    const f = features({ debounceMs: 20 });
    const app = await mountApp({ files: FILES, features: f.list });
    await openSearch(app);
    await app.tui.act(() => app.ctx.commands.execute("search.toggleMatchCase"));
    await app.tui.act(() => app.ctx.commands.execute("search.toggleWholeWord"));
    await app.tui.type("needle");
    expect(f.controller.state.query).toMatchObject({
      pattern: "needle",
      caseMode: "sensitive",
      wholeWord: true,
    });
    await app.tui.waitForText("2 results in 1 file", { timeoutMs: 5000 });

    await app.tui.press("ctrl+k");
    await app.tui.press("c");
    expect(f.controller.state.query.caseMode).toBe("smart");
    await app.tui.waitForText("3 results in 2 files", { timeoutMs: 5000 });

    // Clicking the regex toggle; "needle(" is then an invalid pattern, reported by the field.
    await app.tui.clickText(".*");
    expect(f.controller.state.query.isRegex).toBe(true);
    await app.tui.press("(");
    await app.tui.waitForText(/Invalid regular/, { timeoutMs: 5000 });
  }, 20_000);

  test("files to include and exclude narrow the search", async () => {
    const f = features({ debounceMs: 20 });
    const app = await mountApp({ files: FILES, features: f.list });
    await openSearch(app);
    await app.tui.type("needle");
    await app.tui.waitForText("3 results in 2 files", { timeoutMs: 5000 });
    await app.tui.act(() => app.ctx.commands.execute("search.toggleDetails"));
    await app.tui.press("tab");
    expect(f.controller.ui.get().focus).toBe("include");
    await app.tui.type("dir");
    await app.tui.waitForText("1 result in 1 file", { timeoutMs: 5000 });
    expect(app.tui.frame()).toContain("b.md");
    await app.tui.press("tab");
    await app.tui.type("*.md");
    await app.tui.waitForText("No results", { timeoutMs: 5000 });
    expect(app.tui.frame()).toContain("Turn off filters");
  }, 20_000);

  test("F4 and Shift+F4 step through matches across files, wrapping", async () => {
    const f = features({ debounceMs: 20 });
    const app = await mountApp({ files: FILES, features: f.list });
    const reveals: RevealRequest[] = [];
    app.ctx.editors.onDidRequestReveal((request) => reveals.push(request));
    await openSearch(app);
    await app.tui.type("needle");
    await app.tui.waitForText("3 results in 2 files", { timeoutMs: 5000 });
    const order = f.controller.model
      .getRows(0, f.controller.state.rowCount)
      .filter((row) => row.type === "match")
      .map((row) => `${row.path}:${row.line}`);
    const visited: string[] = [];
    for (let i = 0; i < 4; i++) {
      await app.tui.press("f4");
      visited.push(`${app.ctx.editors.active?.resource}:${reveals.at(-1)?.line}`);
    }
    expect(visited).toEqual([...order, order[0] as string]);
    await app.tui.press("shift+f4");
    expect(`${app.ctx.editors.active?.resource}:${reveals.at(-1)?.line}`).toBe(order.at(-1) as string);
  }, 20_000);
});

describe("Search view with a scripted engine", () => {
  test("a new query cancels the running search and ignores its late results", async () => {
    const backend = new FakeSearch();
    const f = features({ backend: () => backend, debounceMs: 10, flushIntervalMs: 5 });
    const app = await mountApp({ features: f.list });
    await openSearch(app);
    await app.tui.type("one");
    await app.tui.advance(40);
    const first = backend.last();
    first.emit([match("a.ts", 1)]);
    await app.tui.advance(20);
    expect(app.tui.frame()).toContain("1 result in 1 file");
    await app.tui.type("x");
    await app.tui.advance(40);
    expect(first.signal?.aborted).toBe(true);
    const second = backend.last();
    expect(second.query.pattern).toBe("onex");
    second.emit([match("b.ts", 2), match("b.ts", 3)]);
    second.finish();
    await app.tui.advance(20);
    expect(app.tui.frame()).toContain("2 results in 1 file");
    expect(app.tui.frame()).not.toContain("a.ts");
  }, 20_000);

  test("a failure says so and Retry searches again; Escape stops a running search", async () => {
    const backend = new FakeSearch();
    const f = features({ backend: () => backend, debounceMs: 10, flushIntervalMs: 5 });
    const app = await mountApp({ features: f.list });
    await openSearch(app);
    await app.tui.type("boom");
    await app.tui.advance(40);
    backend.last().fail(new Error("git grep exited with code 2"));
    await app.tui.waitForText("Search failed");
    expect(app.tui.frame()).toContain("git grep exited with code 2");
    const calls = backend.calls.length;
    await app.tui.clickText("Retry");
    await app.tui.advance(20);
    expect(backend.calls.length).toBe(calls + 1);
    backend.last().emit([match("a.ts", 1)]);
    await app.tui.advance(20);
    await app.tui.press("escape");
    expect(backend.last().signal?.aborted).toBe(true);
    await app.tui.waitForText("Stopped");
  }, 20_000);

  test("the query and recent queries persist; restoring never searches and Up recalls", async () => {
    const backend = new FakeSearch();
    const first = features({ backend: () => backend, debounceMs: 10, flushIntervalMs: 5 });
    const root = stableWorkspace();
    const app = await mountApp({ features: first.list, workspace: { root } });
    await openSearch(app);
    await app.tui.type("alpha");
    await app.tui.advance(40);
    backend.last().finish();
    await app.tui.advance(20);
    await app.tui.act(() => first.controller.toggleRegex());
    await app.tui.act(() => first.controller.clear());
    await app.tui.type("beta");
    await app.tui.advance(40);
    backend.last().finish();
    await app.tui.advance(20);
    const calls = backend.calls.length;
    await app.dispose();

    const second = features({ backend: () => backend, debounceMs: 10, flushIntervalMs: 5 });
    const again = await mountApp({ features: second.list, dirs: app.dirs, workspace: { root } });
    await openSearch(again);
    await again.tui.advance(50);
    expect(second.controller.state.query).toMatchObject({ pattern: "beta", isRegex: true });
    expect(second.controller.state.recentQueries).toEqual(["beta", "alpha"]);
    expect(second.controller.state.status).toBe("idle");
    expect(backend.calls.length).toBe(calls);
    expect(again.tui.frame()).toContain("beta");

    await again.tui.act(() => second.controller.clear());
    await again.tui.press("up");
    expect(second.controller.state.query.pattern).toBe("beta");
    await again.tui.press("up");
    expect(second.controller.state.query.pattern).toBe("alpha");
    await again.tui.press("down");
    await again.tui.press("down");
    expect(second.controller.state.query.pattern).toBe("");
  }, 20_000);

  test("text frames of the view at 120x35 and 90x28", async () => {
    for (const [width, height] of [
      [120, 35],
      [90, 28],
    ] as const) {
      const backend = new FakeSearch();
      backend.engine = "git-grep";
      const f = features({ backend: () => backend, debounceMs: 10, flushIntervalMs: 5 });
      const app = await mountApp({ features: f.list, width, height });
      await openSearch(app);
      await app.tui.type("needle");
      await app.tui.advance(40);
      backend
        .last()
        .emit([
          match("src/server/task-store.ts", 11, "export class needle {"),
          match(
            "src/server/task-store.ts",
            124,
            "  const store = new needle(clock); // a long line that keeps going",
          ),
          match("docs/çalışma-notları.md", 3, "Turkish: İçerik and needle"),
        ]);
      backend.last().finish();
      await app.tui.advance(30);
      await app.tui.press("down");
      await app.tui.press("down");
      const sidebarWidth = app.ctx.layout.effective.get().sidebar.width + 4;
      expect(sidebar(app.tui.frame(), sidebarWidth)).toMatchSnapshot(`search view ${width}x${height}`);
      await app.dispose();
    }
  }, 20_000);
});

describe("Quick Open", () => {
  const QUICK_FILES = {
    "src/server/routes/tasks.ts": "line 1\nline 2\n",
    "src/server/store/task-store.ts": "export class TaskStore {}\n",
    "docs/çalışma-notları.md": "# Notlar\n",
    "README.md": "# Readme\n",
  };

  test("lists recently opened files first, then highlights fuzzy matches in name and folder", async () => {
    const app = await mountApp({ files: QUICK_FILES });
    await app.tui.act(() => app.ctx.persisted.noteRecentFile("README.md"));
    await app.tui.press("ctrl+p");
    await until(app, () => app.ctx.quickPick.state.items.length > 0);
    const recent = app.ctx.quickPick.state.items;
    expect(recent[0]).toMatchObject({ id: "README.md", group: "recently opened", fileIcon: "README.md" });
    expect(recent[1]?.group).toBe("files");

    await app.tui.type("calis");
    await until(app, () => app.ctx.quickPick.state.items[0]?.id === "docs/çalışma-notları.md");
    const item = app.ctx.quickPick.state.items[0];
    expect(item).toMatchObject({
      id: "docs/çalışma-notları.md",
      label: "çalışma-notları.md",
      description: "docs",
    });
    expect(item?.highlights?.length).toBeGreaterThan(0);

    await app.tui.press("backspace");
    for (let i = 0; i < 4; i++) await app.tui.press("backspace");
    await app.tui.type("srvtask");
    await until(app, () => !app.ctx.quickPick.state.loading && app.ctx.quickPick.state.value === "srvtask");
    const both = app.ctx.quickPick.state.items.find(
      (candidate) => candidate.id === "src/server/store/task-store.ts",
    );
    expect(both?.highlights?.length).toBeGreaterThan(0);
    expect(both?.descriptionHighlights?.length).toBeGreaterThan(0);
    await app.tui.press("enter");
    expect(app.ctx.editors.active).toMatchObject({ resource: expect.any(String), preview: false });
    expect(app.ctx.focus.current).toBe("editor");
  }, 20_000);

  test("name:line:column opens the file at that position", async () => {
    const app = await mountApp({ files: QUICK_FILES });
    const reveals: RevealRequest[] = [];
    app.ctx.editors.onDidRequestReveal((request) => reveals.push(request));
    await app.tui.press("ctrl+p");
    await app.tui.type("routes/tasks:2:4");
    await app.tui.waitForText("line 2, column 4");
    await app.tui.press("enter");
    const tab = app.ctx.editors.active;
    expect(tab?.resource).toBe("src/server/routes/tasks.ts");
    expect(reveals.at(-1)).toEqual({ tabId: tab?.id ?? "", line: 2, column: 4 });
  }, 20_000);

  test("a truncated index says so in a disabled row", async () => {
    const files = Array.from({ length: 5 }, (_, i) => `file-${i}.ts`);
    const index = {
      peek: () => ({ files, truncated: true, strategy: "walk" as const, durationMs: 1 }),
      list: async () => ({ files, truncated: true, strategy: "walk" as const, durationMs: 1 }),
      invalidate: () => {},
    };
    const f = features({ fileIndex: () => index });
    const app = await mountApp({ features: f.list });
    // `peek` reports a cached listing, but the model learns about truncation on its first list.
    index.peek = () => null as never;
    await app.tui.press("ctrl+p");
    await app.tui.type("file");
    await until(app, () => app.ctx.quickPick.state.items.length > 0);
    const last = app.ctx.quickPick.state.items.at(-1);
    expect(last).toMatchObject({ disabled: true });
    expect(last?.label).toContain("Only the first 5 files are searchable.");
  }, 20_000);
});
