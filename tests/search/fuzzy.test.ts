import { describe, expect, test } from "bun:test";
import { foldString } from "@/adapters/filesystem/case-fold";
import { fuzzyFilter, fuzzyFilterBy, fuzzyMatch } from "@/adapters/search/fuzzy";
import { parseQuickOpenQuery } from "@/adapters/search/quick-open-query";
import { isLucyError } from "@/core/errors";

async function rank(query: string, items: string[]): Promise<string[]> {
  return (await fuzzyFilter(query, items)).map((result) => result.item);
}

function highlighted(candidate: string, positions: readonly number[]): string {
  return positions.map((position) => candidate[position]).join("");
}

describe("fuzzyMatch", () => {
  test("matches subsequences, rejects non-matches", () => {
    expect(fuzzyMatch("btn", "src/components/button.tsx")).not.toBeNull();
    expect(fuzzyMatch("xyz", "src/components/button.tsx")).toBeNull();
    expect(fuzzyMatch("nottb", "button")).toBeNull(); // Order matters.
  });

  test("positions point at the matched characters", () => {
    const candidate = "src/components/Button.tsx";
    const match = fuzzyMatch("cbtn", candidate);
    expect(match).not.toBeNull();
    const chars = highlighted(candidate, match?.positions ?? []);
    expect(foldString(chars)).toBe("cbtn");
    expect(match?.positions).toEqual([...(match?.positions ?? [])].sort((a, b) => a - b));
  });

  test("an empty query matches everything with score 0", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
    expect(fuzzyMatch("   ", "anything")).toEqual({ score: 0, positions: [] });
  });

  test("case-insensitive; uppercase in the query is a bonus, never a requirement", () => {
    expect(fuzzyMatch("README", "readme.md")).not.toBeNull();
    const exact = fuzzyMatch("FB", "src/FooBar.ts")?.score ?? 0;
    const lower = fuzzyMatch("FB", "src/foobar.ts")?.score ?? 0;
    expect(exact).toBeGreaterThan(lower);
  });

  test("Unicode folding: Turkish İ/ı and Latin accents match their ASCII letters", () => {
    expect(fuzzyMatch("istanbul", "docs/İstanbul.md")).not.toBeNull();
    expect(fuzzyMatch("isik", "src/ışık.ts")).not.toBeNull();
    expect(fuzzyMatch("cagri", "çağrı.txt")).not.toBeNull();
    expect(fuzzyMatch("çağ", "cag.txt")).not.toBeNull();
    // ASCII matching is unaffected by Turkish rules: "I" still matches "i".
    expect(fuzzyMatch("INDEX", "src/index.ts")).not.toBeNull();
    expect(fuzzyMatch("index", "src/INDEX.TS")).not.toBeNull();
    // NFD (decomposed) names, as created on macOS, match through their base letters.
    expect(fuzzyMatch("cag", "çağ.md".normalize("NFD"))).not.toBeNull();
    // The exact accented spelling ranks above the folded one.
    const accented = fuzzyMatch("şiş", "şiş.txt")?.score ?? 0;
    const plain = fuzzyMatch("şiş", "sis.txt")?.score ?? 0;
    expect(accented).toBeGreaterThan(plain);
  });
});

describe("ranking", () => {
  test("exact basename > stem > basename prefix > other basename matches > path-only matches", async () => {
    const items = [
      "src/btn/index.ts",
      "src/abutton.ts",
      "src/buttons-legacy.ts",
      "src/button.tsx",
      "lib/button",
      "button/other.ts",
    ];
    expect(await rank("button", items)).toEqual([
      "lib/button",
      "src/button.tsx",
      "src/buttons-legacy.ts",
      "src/abutton.ts",
      "button/other.ts",
    ]);
  });

  test("consecutive and word-boundary matches beat scattered ones", async () => {
    expect(await rank("fb", ["a/fxxxb.ts", "a/foo_bar.ts"])).toEqual(["a/foo_bar.ts", "a/fxxxb.ts"]);
    expect(await rank("usst", ["a/u-x-s-x-s-x-t.ts", "a/useState.ts"])).toEqual([
      "a/useState.ts",
      "a/u-x-s-x-s-x-t.ts",
    ]);
    expect(await rank("gc", ["src/garbageCollector.ts", "src/gxxxxc.ts"])).toEqual([
      "src/garbageCollector.ts",
      "src/gxxxxc.ts",
    ]);
  });

  test("shorter paths win ties, then input order", async () => {
    expect(await rank("main", ["deep/nested/dir/main.ts", "src/main.ts", "a/main.ts"])).toEqual([
      "a/main.ts",
      "src/main.ts",
      "deep/nested/dir/main.ts",
    ]);
  });

  test("a query with '/' matches across the path", async () => {
    const items = ["src/components/card.tsx", "src/utils/card.ts", "test/components/card.test.tsx"];
    expect((await rank("comp/card", items))[0]).toBe("src/components/card.tsx");
    expect(await rank("utils/", items)).toEqual(["src/utils/card.ts"]);
  });

  test("terms separated by spaces must all match (AND)", async () => {
    const items = ["src/server/routes.ts", "src/client/routes.ts", "src/server/db.ts"];
    expect(await rank("server routes", items)).toEqual(["src/server/routes.ts"]);
    expect(await rank("routes client", items)).toEqual(["src/client/routes.ts"]);
    expect(await rank("routes nope", items)).toEqual([]);
  });

  test("basename matches are preferred but directory matches are still allowed", async () => {
    expect(await rank("models", ["app/models/user.rb", "app/models.rb"])).toEqual([
      "app/models.rb",
      "app/models/user.rb",
    ]);
  });
});

describe("fuzzyFilter", () => {
  test("an empty query keeps the given order (recent files first) and honors the limit", async () => {
    const items = ["recent.ts", "b.ts", "a.ts"];
    expect(await rank("", items)).toEqual(items);
    expect((await fuzzyFilter("", items, { limit: 2 })).map((result) => result.item)).toEqual([
      "recent.ts",
      "b.ts",
    ]);
  });

  test("limit keeps the best results in order", async () => {
    const items = Array.from({ length: 1000 }, (_, i) => `dir${i}/file${i}.ts`);
    items.push("x/target.ts");
    const results = await fuzzyFilter("target", items, { limit: 3 });
    expect(results[0]?.item).toBe("x/target.ts");
    expect(results.length).toBeLessThanOrEqual(3);
    expect(results[0]?.index).toBe(1000);
  });

  test("works on arbitrary items with a key", async () => {
    const items = [{ path: "a/readme.md" }, { path: "b/main.ts" }];
    const results = await fuzzyFilterBy("main", items, (item) => item.path);
    expect(results.map((result) => result.item.path)).toEqual(["b/main.ts"]);
  });

  test("yields to the event loop while scoring and can be cancelled", async () => {
    const items = Array.from(
      { length: 200_000 },
      (_, i) => `packages/pkg-${i % 300}/src/module-${i}/index.ts`,
    );
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 1);
    await fuzzyFilter("modidx", items, { limit: 50 });
    clearInterval(ticker);
    expect(ticks).toBeGreaterThan(0);

    const controller = new AbortController();
    const pending = fuzzyFilter("modidx", items, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    try {
      await pending;
      throw new Error("expected cancellation");
    } catch (error) {
      expect(isLucyError(error, "CANCELLED")).toBe(true);
    }
  });
});

describe("parseQuickOpenQuery", () => {
  test("parses line and column suffixes", () => {
    expect(parseQuickOpenQuery("src/file.ts:42")).toEqual({ query: "src/file.ts", line: 42 });
    expect(parseQuickOpenQuery("  file.ts:42:7 ")).toEqual({ query: "file.ts", line: 42, column: 7 });
    expect(parseQuickOpenQuery("file.ts:42:")).toEqual({ query: "file.ts", line: 42 });
    expect(parseQuickOpenQuery(":12")).toEqual({ query: "", line: 12 });
  });

  test("leaves other input alone", () => {
    expect(parseQuickOpenQuery("file.ts")).toEqual({ query: "file.ts" });
    expect(parseQuickOpenQuery("file.ts:")).toEqual({ query: "file.ts" });
    expect(parseQuickOpenQuery("file.ts:abc")).toEqual({ query: "file.ts:abc" });
    expect(parseQuickOpenQuery("file.ts:0")).toEqual({ query: "file.ts:0" });
    expect(parseQuickOpenQuery("42")).toEqual({ query: "42" });
  });
});
