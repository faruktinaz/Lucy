import { describe, expect, test } from "bun:test";
import { ContentSearch } from "@/adapters/search";
import {
  RIPGREP_HINT,
  type SearchFileRow,
  type SearchOpenIntent,
  type SearchRow,
  SearchViewModel,
} from "@/features/search/model";
import { createTempDirs, GIT_TEST_ENV, writeTree } from "../filesystem/helpers";
import { FakeSearch, match } from "./helpers";

const tempDir = createTempDirs("lucy-search-model-");

function rows(model: SearchViewModel): SearchRow[] {
  return model.getRows(0, model.store.get().rowCount);
}

function labels(model: SearchViewModel): string[] {
  return rows(model).map((row) =>
    row.type === "file"
      ? `${row.collapsed ? "+" : "-"}${row.path} (${row.matchCount})`
      : `  ${row.path}:${row.line}`,
  );
}

async function realModel(files: Record<string, string>, maxResults?: number) {
  const root = await tempDir();
  await writeTree(root, files);
  const opened: SearchOpenIntent[] = [];
  const model = new SearchViewModel({
    search: new ContentSearch({ root, env: GIT_TEST_ENV, ripgrepPath: null }),
    iconTier: "ascii",
    debounceMs: 10,
    maxResults,
    onOpen: (intent) => opened.push(intent),
  });
  return { model, opened };
}

function fakeModel(options: { debounceMs?: number; flushIntervalMs?: number } = {}) {
  const backend = new FakeSearch();
  const opened: SearchOpenIntent[] = [];
  const model = new SearchViewModel({
    search: backend,
    iconTier: "ascii",
    debounceMs: options.debounceMs ?? 10,
    flushIntervalMs: options.flushIntervalMs ?? 5,
    onOpen: (intent) => opened.push(intent),
  });
  return { backend, model, opened };
}

describe("with a real engine", () => {
  test("groups streamed results by file with previews, ranges and an honest engine report", async () => {
    const { model } = await realModel({
      "a.ts": "const needle = 1;\nno match\nfoo(needle);\n",
      "dir/b.md": "\tneedle in markdown\n",
      "c.txt": "nothing here\n",
    });
    expect(await model.detectEngine()).toBe("builtin");
    expect(model.store.get()).toMatchObject({ engineLabel: "built-in search", engineHint: RIPGREP_HINT });
    model.setPattern("needle");
    const summary = await model.run();
    expect(summary?.matchCount).toBe(3);
    const state = model.store.get();
    expect(state).toMatchObject({
      status: "done",
      engine: "builtin",
      matchCount: 3,
      fileCount: 2,
      summary: "3 results in 2 files",
      truncated: false,
      truncatedNotice: null,
      error: null,
      rowCount: 5,
    });
    expect([...labels(model)].sort()).toEqual([
      "  a.ts:1",
      "  a.ts:3",
      "  dir/b.md:1",
      "-a.ts (2)",
      "-dir/b.md (1)",
    ]);
    const file = rows(model).find(
      (row): row is SearchFileRow => row.type === "file" && row.path === "dir/b.md",
    );
    expect(file).toMatchObject({ name: "b.md", directory: "dir", matchCount: 1 });
    const markdown = rows(model).find((row) => row.type === "match" && row.path === "dir/b.md");
    if (markdown?.type !== "match") throw new Error("missing match row");
    expect(markdown.preview.slice(markdown.ranges[0]?.start, markdown.ranges[0]?.end)).toBe("needle");
    expect(markdown.column).toBe(2);
  });

  test("invalid pattern, empty result and truncation states", async () => {
    const { model } = await realModel({ "a.txt": "x\nx\nx\nx\n" }, 2);
    model.setQuery({ pattern: "a(", isRegex: true });
    await model.run();
    expect(model.store.get()).toMatchObject({ status: "error", summary: "", rowCount: 0 });
    expect(model.store.get().error?.kind).toBe("invalid-pattern");
    expect(model.store.get().error?.message).toContain("Invalid regular expression");

    model.setQuery({ pattern: "zzz-not-there", isRegex: false });
    await model.run();
    expect(model.store.get()).toMatchObject({
      status: "done",
      summary: "No results",
      error: null,
      rowCount: 0,
    });

    model.setPattern("x");
    await model.run();
    expect(model.store.get()).toMatchObject({
      matchCount: 2,
      truncated: true,
      truncatedNotice: "Showing the first 2 results. Narrow the search to see more.",
    });
    model.dispose();
  });
});

describe("query editing and runs", () => {
  test("query edits are debounced into one run with parsed globs", async () => {
    const { backend, model } = fakeModel({ debounceMs: 20 });
    model.setPattern("n");
    model.setPattern("ne");
    model.setQuery({ pattern: "needle", include: "src, *.ts ,", exclude: " node_modules " });
    model.cycleCaseMode();
    model.toggleWholeWord();
    model.toggleRegex();
    expect(backend.calls.length).toBe(0);
    await Bun.sleep(60);
    expect(backend.calls.length).toBe(1);
    expect(backend.last().query).toMatchObject({
      pattern: "needle",
      include: ["src", "*.ts"],
      exclude: ["node_modules"],
      caseMode: "sensitive",
      wholeWord: true,
      isRegex: true,
      maxResults: 2000,
    });
    expect(model.store.get().status).toBe("searching");
    expect(model.store.get().summary).toBe("Searching…");
    backend.last().finish();
    await Bun.sleep(0);
    expect(model.store.get().status).toBe("done");
    model.dispose();
  });

  test("changing the query mid-search cancels the old run and ignores its late results", async () => {
    const { backend, model } = fakeModel();
    model.setPattern("first");
    await Bun.sleep(30);
    const first = backend.last();
    first.emit([match("old.ts", 1)]);
    model.setPattern("second");
    expect(first.signal?.aborted).toBe(true);
    first.emit([match("late.ts", 1)]); // A batch already in flight when the abort landed.
    await Bun.sleep(30);
    const second = backend.last();
    expect(second).not.toBe(first);
    second.emit([match("new.ts", 1), match("new.ts", 2)]);
    second.finish();
    await Bun.sleep(10);
    expect(labels(model)).toEqual(["-new.ts (2)", "  new.ts:1", "  new.ts:2"]);
    expect(model.store.get()).toMatchObject({ status: "done", summary: "2 results in 1 file" });
    model.dispose();
  });

  test("streaming keeps the selection stable and coalesces state updates", async () => {
    const { backend, model } = fakeModel({ flushIntervalMs: 20 });
    model.setPattern("needle");
    const running = model.run();
    const call = backend.last();
    call.emit([match("a.ts", 1), match("a.ts", 2)]);
    await Bun.sleep(30);
    expect(labels(model)).toEqual(["-a.ts (2)", "  a.ts:1", "  a.ts:2"]);
    model.select(rows(model)[2]?.key ?? null);
    expect(model.store.get().selectedIndex).toBe(2);

    let updates = 0;
    const unsubscribe = model.store.subscribe(() => updates++);
    for (let i = 0; i < 10; i++) call.emit([match(`file-${i}.ts`, 1)]);
    call.emit([match("a.ts", 7)]);
    await Bun.sleep(40);
    expect(updates).toBeLessThanOrEqual(2);
    unsubscribe();
    expect(model.store.get()).toMatchObject({ selectedIndex: 2, matchCount: 13, fileCount: 11 });
    expect(rows(model)[2]).toMatchObject({ type: "match", path: "a.ts", line: 2, selected: true });
    call.finish();
    await running;
    expect(model.store.get().summary).toBe("13 results in 11 files");
    model.dispose();
  });

  test("cancel keeps partial results; clear resets everything", async () => {
    const { backend, model } = fakeModel();
    model.setPattern("needle");
    const running = model.run();
    backend.last().emit([match("a.ts", 1)]);
    model.cancel();
    expect(await running).toBeNull();
    expect(model.store.get()).toMatchObject({
      status: "cancelled",
      matchCount: 1,
      summary: "1 result in 1 file",
    });
    model.clear();
    expect(model.store.get()).toMatchObject({ status: "idle", matchCount: 0, rowCount: 0, summary: "" });
    expect(model.store.get().query.pattern).toBe("");
    model.dispose();
  });

  test("an engine failure is reported", async () => {
    const { backend, model } = fakeModel();
    model.setPattern("needle");
    const running = model.run();
    backend.last().fail(new Error("disk on fire"));
    await running;
    expect(model.store.get()).toMatchObject({
      status: "error",
      error: { kind: "failed", message: "disk on fire" },
    });
    model.dispose();
  });
});

describe("navigation", () => {
  async function populated() {
    const fixture = fakeModel();
    fixture.model.setPattern("needle");
    const running = fixture.model.run();
    const call = fixture.backend.last();
    call.emit([match("a.ts", 1), match("a.ts", 5)]);
    call.emit([match("b.ts", 2), match("b.ts", 9)]);
    call.finish();
    await running;
    return fixture;
  }

  test("next / previous match across files, wrapping and expanding collapsed files", async () => {
    const { model } = await populated();
    const visit = (step: () => unknown) => {
      step();
      return model.store.get().selectedKey?.replace("\0", ":");
    };
    expect(visit(() => model.nextMatch())).toBe("a.ts:1");
    expect(visit(() => model.nextMatch())).toBe("a.ts:5");
    expect(visit(() => model.nextMatch())).toBe("b.ts:2");
    expect(visit(() => model.nextMatch())).toBe("b.ts:9");
    expect(visit(() => model.nextMatch())).toBe("a.ts:1");
    expect(visit(() => model.previousMatch())).toBe("b.ts:9");
    model.toggleFile("a.ts");
    expect(labels(model)).toEqual(["+a.ts (2)", "-b.ts (2)", "  b.ts:2", "  b.ts:9"]);
    expect(visit(() => model.nextMatch())).toBe("a.ts:1");
    expect(labels(model)[0]).toBe("-a.ts (2)");
    model.select("b.ts");
    expect(visit(() => model.previousMatch())).toBe("a.ts:5");
    model.dispose();
  });

  test("arrow keys, left/right on files and matches, enter opens or toggles", async () => {
    const { model, opened } = await populated();
    model.moveDown();
    expect(model.store.get().selectedKey).toBe("a.ts");
    model.right();
    expect(model.store.get().selectedKey).toBe("a.ts\x001");
    model.moveDown();
    model.enter();
    expect(opened).toEqual([{ path: "a.ts", line: 5, column: 1 }]);
    model.left();
    expect(model.store.get().selectedKey).toBe("a.ts");
    model.left();
    expect(labels(model)[0]).toBe("+a.ts (2)");
    model.right();
    expect(labels(model)[0]).toBe("-a.ts (2)");
    model.enter();
    expect(labels(model)[0]).toBe("+a.ts (2)");
    model.end();
    expect(model.store.get().selectedKey).toBe("b.ts\x009");
    model.pageUp(3);
    expect(model.store.get().selectedKey).toBe("b.ts");
    model.home();
    expect(model.store.get().selectedIndex).toBe(0);
    model.pageDown(10);
    expect(model.store.get().selectedIndex).toBe(model.store.get().rowCount - 1);
    model.dispose();
  });

  test("collapsing all moves a selected match to its file header", async () => {
    const { model } = await populated();
    model.select("b.ts\x009");
    model.collapseAll();
    expect(labels(model)).toEqual(["+a.ts (2)", "+b.ts (2)"]);
    expect(model.store.get()).toMatchObject({ selectedKey: "b.ts", selectedIndex: 1 });
    model.expandAll();
    expect(model.store.get().rowCount).toBe(6);
    model.dispose();
  });
});

describe("recent queries", () => {
  test("are remembered after completed runs, deduplicated, exported and restored", async () => {
    const { backend, model } = fakeModel();
    for (const pattern of ["one", "two", "one"]) {
      model.setPattern(pattern);
      const running = model.run();
      backend.last().finish();
      await running;
    }
    expect(model.store.get().recentQueries).toEqual(["one", "two"]);
    const snapshot = model.exportSnapshot();
    expect(snapshot.query.pattern).toBe("one");
    model.dispose();

    const restored = fakeModel();
    restored.model.restoreSnapshot(snapshot);
    expect(restored.model.store.get()).toMatchObject({
      recentQueries: ["one", "two"],
      query: { pattern: "one" },
      status: "idle",
    });
    expect(restored.backend.calls.length).toBe(0); // Restoring never searches by itself.
    restored.model.useRecentQuery(1);
    await Bun.sleep(30);
    expect(restored.backend.last().query.pattern).toBe("two");
    restored.model.dispose();
  });
});
