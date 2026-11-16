import { describe, expect, test } from "bun:test";
import { FileIndex, type MatchRange } from "@/adapters/search";
import { isLucyError } from "@/core/errors";
import { positionsToRanges, QuickOpenModel, sanitizeWithRanges } from "@/features/search/model";
import { createTempDirs, GIT_TEST_ENV, writeTree } from "../filesystem/helpers";
import { FakeIndex } from "./helpers";

const tempDir = createTempDirs("lucy-quick-open-");

function cut(text: string, ranges: readonly MatchRange[]): string[] {
  return ranges.map((range) => text.slice(range.start, range.end));
}

describe("highlight helpers", () => {
  test("positions become merged ranges inside a window", () => {
    expect(positionsToRanges([0, 1, 2, 5, 9, 10], 0, 10)).toEqual([
      { start: 0, end: 3 },
      { start: 5, end: 6 },
      { start: 9, end: 10 },
    ]);
    expect(positionsToRanges([3, 4, 8], 4, 5)).toEqual([
      { start: 0, end: 1 },
      { start: 4, end: 5 },
    ]);
  });

  test("sanitizing keeps ranges on the same characters", () => {
    const result = sanitizeWithRanges("a\tb\u0007c", [
      { start: 2, end: 3 },
      { start: 4, end: 5 },
    ]);
    expect(result.text).toBe("a  b�c");
    expect(cut(result.text, result.ranges)).toEqual(["b", "c"]);
  });
});

describe("QuickOpenModel", () => {
  test("splits highlights between the file name and its folder", async () => {
    const index = new FakeIndex(["src/components/Button.tsx", "README.md", "docs/button-guide.md"]);
    const model = new QuickOpenModel({ fileIndex: index, iconTier: "ascii" });
    const result = await model.query("compbtn");
    const item = result.items[0];
    expect(item).toMatchObject({
      path: "src/components/Button.tsx",
      label: "Button.tsx",
      description: "src/components",
    });
    expect(cut(item?.label ?? "", item?.labelHighlights ?? []).join("")).toBe("Btn");
    expect(cut(item?.description ?? "", item?.descriptionHighlights ?? []).join("")).toBe("comp");
    expect(item?.icon.glyph).toBeDefined();

    const slash = await model.query("components/button");
    const top = slash.items[0];
    expect(top?.path).toBe("src/components/Button.tsx");
    expect(cut(top?.description ?? "", top?.descriptionHighlights ?? []).join("")).toBe("components");
    expect(cut(top?.label ?? "", top?.labelHighlights ?? []).join("")).toBe("Button");

    const root = await model.query("readme");
    expect(root.items[0]).toMatchObject({ label: "README.md", description: "", descriptionHighlights: [] });
  });

  test("display-unsafe names are sanitized with highlights still aligned", async () => {
    const model = new QuickOpenModel({ fileIndex: new FakeIndex(["dir\u0007x/a\tb.ts"]), iconTier: "ascii" });
    const [item] = (await model.query("ab")).items;
    expect(item?.label).toBe("a  b.ts");
    expect(item?.description).toBe("dir�x");
    expect(cut(item?.label ?? "", item?.labelHighlights ?? [])).toEqual(["a", "b"]);
  });

  test("an empty query lists recent files first (only existing ones), then the index", async () => {
    const index = new FakeIndex(["a.ts", "b.ts", "c.ts", "d.ts"]);
    const model = new QuickOpenModel({
      fileIndex: index,
      iconTier: "ascii",
      recentFiles: ["c.ts", "deleted.ts", "a.ts"],
      limit: 3,
    });
    const result = await model.query("");
    expect(result.items.map((item) => [item.path, item.recent])).toEqual([
      ["c.ts", true],
      ["a.ts", true],
      ["b.ts", false],
    ]);
    model.setRecentFiles([]);
    expect((await model.query("  ")).items.map((item) => item.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    const marked = new QuickOpenModel({ fileIndex: index, iconTier: "ascii", recentFiles: ["b.ts"] });
    expect((await marked.query("b")).items[0]).toMatchObject({ path: "b.ts", recent: true });
  });

  test("parses the :line and :line:column suffix", async () => {
    const model = new QuickOpenModel({
      fileIndex: new FakeIndex(["src/button.ts", "src/main.ts"]),
      iconTier: "ascii",
    });
    const withColumn = await model.query("button:42:7");
    expect(withColumn).toMatchObject({ query: "button", line: 42, column: 7 });
    expect(withColumn.items[0]?.path).toBe("src/button.ts");
    expect(await model.query("main.ts:12")).toMatchObject({ query: "main.ts", line: 12 });
    expect(await model.query(":30")).toMatchObject({ query: "", line: 30, items: [] });
  });

  test("the first query builds the index (loading state, truncated notice); later ones reuse it", async () => {
    const index = new FakeIndex(["a.ts", "b.ts"], true);
    index.hold();
    const model = new QuickOpenModel({ fileIndex: index, iconTier: "ascii" });
    const pending = model.query("a");
    await Bun.sleep(5);
    expect(model.store.get().loading).toBe(true);
    index.open();
    const result = await pending;
    expect(result).toMatchObject({ truncated: true, total: 2 });
    expect(model.store.get()).toMatchObject({
      loading: false,
      truncated: true,
      truncatedNotice: "Only the first 2 files are searchable.",
      strategy: "walk",
      fileCount: 2,
    });
    await model.query("b");
    expect(index.listCalls).toBe(1);
    model.invalidate();
    expect(index.invalidations).toBe(1);
    await model.query("b");
    expect(index.listCalls).toBe(2);
  });

  test("cancellation while the index loads and while matching", async () => {
    const index = new FakeIndex(
      Array.from({ length: 200_000 }, (_, i) => `pkg-${i % 400}/src/module-${i}/index.ts`),
    );
    index.hold();
    const model = new QuickOpenModel({ fileIndex: index, iconTier: "ascii" });
    const loading = new AbortController();
    const first = model.query("mod", loading.signal);
    await Bun.sleep(5);
    loading.abort();
    await expect(first).rejects.toMatchObject({ code: "CANCELLED" });
    expect(model.store.get()).toMatchObject({ loading: false, error: null });

    index.open();
    await model.query(""); // Builds the index.
    const typing = new AbortController();
    const slow = model.query("modidx", typing.signal);
    setTimeout(() => typing.abort(), 2);
    try {
      await slow;
      throw new Error("expected cancellation");
    } catch (error) {
      expect(isLucyError(error, "CANCELLED")).toBe(true);
    }
  });

  test("end to end over a real FileIndex", async () => {
    const root = await tempDir();
    await writeTree(root, { "src/components/Button.tsx": "", "src/util.ts": "", "ığüş/İstanbul.md": "" });
    const model = new QuickOpenModel({
      fileIndex: new FileIndex({ root, env: GIT_TEST_ENV, ripgrepPath: null }),
      iconTier: "unicode",
    });
    expect((await model.query("btn")).items[0]?.path).toBe("src/components/Button.tsx");
    expect((await model.query("istanbul")).items[0]).toMatchObject({
      label: "İstanbul.md",
      description: "ığüş",
    });
    expect(model.store.get()).toMatchObject({ strategy: "walk", fileCount: 3, truncated: false });
  });
});
