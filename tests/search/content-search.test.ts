/**
 * One suite, run against every available engine on the same fixture tree.
 *
 * Case-insensitive behavior is documented by these tests and is the same in all engines:
 * Unicode simple case folding, so "ĞÜŞ" finds "ğüş", while ASCII "istanbul" does NOT find
 * Turkish "İstanbul" (İ has no simple lowercase mapping to "i").
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { foldString } from "@/adapters/filesystem/case-fold";
import { ContentSearch } from "@/adapters/search/content-search";
import {
  isInvalidPatternError,
  type SearchEngineName,
  type SearchMatch,
} from "@/adapters/search/search-types";
import { isLucyError } from "@/core/errors";
import { which } from "@/core/process";
import { commitAll, createTempDirs, GIT_TEST_ENV, initRepo, writeTree } from "../filesystem/helpers";

const tempDir = createTempDirs("lucy-content-");
const ripgrep = which("rg");
const engines: SearchEngineName[] = ["builtin", "git-grep", ...(ripgrep ? (["ripgrep"] as const) : [])];

const LONG_LINE = `${"x".repeat(20_000)}NEEDLE${"y".repeat(20_000)}`;

async function fixture(): Promise<string> {
  const root = await tempDir();
  await writeTree(root, {
    ".gitignore": "*.log\nbuild/\n",
    "tr.txt": "ığüşöç İstanbul\nISTANBUL istanbul\nIĞÜŞÖÇ\n",
    "long.txt": `${LONG_LINE}\n`,
    "bin.dat": new Uint8Array([
      0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01, 0x02, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65,
    ]),
    "crlf.txt": "alpha needle\r\nbeta\r\nneedle gamma\r\n",
    "src/a.ts": "const needle = 1;\nconst needles = 2;\nfunction findNeedle() {}\n",
    "src/tab.ts": "\t\tneedle\twith\ttabs\n",
    "docs/c.ts": "needle docs\n",
    "many.txt": Array.from({ length: 3000 }, (_, i) => `hit ${i}`).join("\n"),
  });
  await initRepo(root);
  await commitAll(root);
  // Untracked but not ignored: must still be searched. Ignored: must not.
  await writeTree(root, {
    "src/b.md": "needle in markdown\n",
    ".hidden/h.txt": "needle hidden\n",
    "app.log": "needle in a log\n",
    "build/out.js": "needle in build output\n",
  });
  return root;
}

interface Run {
  matches: SearchMatch[];
  batches: number;
  summary: Awaited<ReturnType<ContentSearch["search"]>>;
}

function lines(run: Run): string[] {
  return run.matches.map((match) => `${match.path}:${match.line}`).sort();
}

for (const engine of engines) {
  describe(`content search: ${engine}`, () => {
    let root = "";
    let search: ContentSearch;

    beforeAll(async () => {
      root = await fixture();
      search = new ContentSearch({ root, engine, env: GIT_TEST_ENV, ripgrepPath: ripgrep });
    });

    async function find(query: Parameters<ContentSearch["search"]>[0], signal?: AbortSignal): Promise<Run> {
      const matches: SearchMatch[] = [];
      let batches = 0;
      const summary = await search.search(
        query,
        {
          onMatches: (batch) => {
            batches++;
            matches.push(...batch);
          },
        },
        signal,
      );
      return { matches, batches, summary };
    }

    test("literal, smart case: finds tracked and untracked files, skips binaries and ignored files", async () => {
      const run = await find({ pattern: "needle" });
      expect(lines(run)).toEqual([
        ".hidden/h.txt:1",
        "crlf.txt:1",
        "crlf.txt:3",
        "docs/c.ts:1",
        "long.txt:1",
        "src/a.ts:1",
        "src/a.ts:2",
        "src/a.ts:3",
        "src/b.md:1",
        "src/tab.ts:1",
      ]);
      expect(run.summary).toMatchObject({ engine, matchCount: 10, fileCount: 7, truncated: false });
      expect(run.batches).toBeGreaterThan(0);
      for (const match of run.matches) {
        expect(match.ranges.length).toBeGreaterThan(0);
        for (const range of match.ranges) {
          expect(foldString(match.lineText.slice(range.start, range.end))).toBe("needle");
        }
      }
    });

    test("columns are 1-based UTF-16 positions in the original line; CRLF and tabs are display-safe", async () => {
      const run = await find({
        pattern: "needle",
        caseMode: "sensitive",
        include: ["crlf.txt", "src/tab.ts"],
      });
      const byLine = new Map(run.matches.map((match) => [`${match.path}:${match.line}`, match]));
      expect(byLine.get("crlf.txt:1")).toMatchObject({
        column: 7,
        lineText: "alpha needle",
        ranges: [{ start: 6, end: 12 }],
      });
      expect(byLine.get("crlf.txt:3")?.lineText).toBe("needle gamma");
      const tab = byLine.get("src/tab.ts:1");
      expect(tab?.column).toBe(3);
      expect(tab?.lineText.includes("\t")).toBe(false);
      expect(tab?.lineText.startsWith("needle")).toBe(true); // Indentation trimmed.
      const range = tab?.ranges[0];
      expect(tab?.lineText.slice(range?.start, range?.end)).toBe("needle");
    });

    test("smart case turns case-sensitive when the pattern has uppercase", async () => {
      const run = await find({ pattern: "Needle" });
      expect(lines(run)).toEqual(["src/a.ts:3"]);
      const insensitive = await find({ pattern: "Needle", caseMode: "insensitive", include: ["src/a.ts"] });
      expect(lines(insensitive)).toEqual(["src/a.ts:1", "src/a.ts:2", "src/a.ts:3"]);
    });

    test("whole word", async () => {
      const run = await find({ pattern: "needle", wholeWord: true, include: ["src/a.ts"] });
      expect(lines(run)).toEqual(["src/a.ts:1"]);
    });

    test("regex vs literal", async () => {
      const regex = await find({ pattern: "^const \\w+ = [0-9]", isRegex: true });
      expect(lines(regex)).toEqual(["src/a.ts:1", "src/a.ts:2"]);
      expect(
        regex.matches[0]?.lineText.slice(regex.matches[0].ranges[0]?.start, regex.matches[0].ranges[0]?.end),
      ).toBe("const needle = 1");
      const literal = await find({ pattern: "needle|gamma", isRegex: false });
      expect(literal.matches).toEqual([]);
      const alternation = await find({ pattern: "needles|gamma", isRegex: true });
      expect(lines(alternation)).toEqual(["crlf.txt:3", "src/a.ts:2"]);
    });

    test("an invalid regex rejects with a typed error", async () => {
      try {
        await find({ pattern: "a(", isRegex: true });
        throw new Error("expected an invalid pattern error");
      } catch (error) {
        expect(isInvalidPatternError(error)).toBe(true);
        expect(isLucyError(error, "INVALID_ARGUMENT")).toBe(true);
      }
    });

    test("Turkish text: Unicode case folding, but ASCII i does not match İ", async () => {
      const folded = await find({ pattern: "ĞÜŞ", caseMode: "insensitive" });
      expect(lines(folded)).toEqual(["tr.txt:1", "tr.txt:3"]);
      const first = folded.matches.find((match) => match.line === 1);
      expect(first?.column).toBe(2);
      expect(first?.lineText.slice(first.ranges[0]?.start, first.ranges[0]?.end)).toBe("ğüş");
      const ascii = await find({ pattern: "istanbul", caseMode: "insensitive" });
      expect(lines(ascii)).toEqual(["tr.txt:2"]);
      const exact = await find({ pattern: "İstanbul", caseMode: "sensitive" });
      expect(lines(exact)).toEqual(["tr.txt:1"]);
      expect(exact.matches[0]?.column).toBe(8);
    });

    test("very long lines are trimmed to a window around the match", async () => {
      const run = await find({ pattern: "NEEDLE", caseMode: "sensitive" });
      expect(run.matches.length).toBe(1);
      const match = run.matches[0] as SearchMatch;
      expect(match.column).toBe(20_001);
      expect(match.lineText.length).toBeLessThanOrEqual(500);
      expect(match.clippedStart).toBe(true);
      expect(match.clippedEnd).toBe(true);
      expect(match.lineText.slice(match.ranges[0]?.start, match.ranges[0]?.end)).toBe("NEEDLE");
      expect(LONG_LINE.slice(match.lineTextStart, match.lineTextStart + match.lineText.length)).toBe(
        match.lineText,
      );
    });

    test("include and exclude globs", async () => {
      expect(lines(await find({ pattern: "needle", include: ["*.ts"] }))).toEqual([
        "docs/c.ts:1",
        "src/a.ts:1",
        "src/a.ts:2",
        "src/a.ts:3",
        "src/tab.ts:1",
      ]);
      expect(lines(await find({ pattern: "needle", include: ["src"] }))).toEqual([
        "src/a.ts:1",
        "src/a.ts:2",
        "src/a.ts:3",
        "src/b.md:1",
        "src/tab.ts:1",
      ]);
      expect(lines(await find({ pattern: "needle", include: ["src/**/*.ts"], exclude: ["tab.ts"] }))).toEqual(
        ["src/a.ts:1", "src/a.ts:2", "src/a.ts:3"],
      );
      expect(lines(await find({ pattern: "needle", exclude: ["src", "*.txt", ".hidden"] }))).toEqual([
        "docs/c.ts:1",
      ]);
    });

    test("the result cap stops the engine and marks the summary truncated", async () => {
      const capped = await find({ pattern: "hit", maxResults: 100 });
      expect(capped.summary).toMatchObject({ matchCount: 100, truncated: true });
      expect(capped.matches.length).toBe(100);
      const all = await find({ pattern: "hit" });
      expect(all.summary).toMatchObject({ matchCount: 2000, truncated: true }); // Default cap.
      const exact = await find({ pattern: "hit", maxResults: 3000 });
      expect(exact.summary).toMatchObject({ matchCount: 3000, truncated: false });
    });

    test("cancellation rejects with CANCELLED and stops deliveries", async () => {
      const before = new AbortController();
      before.abort();
      await expect(find({ pattern: "needle" }, before.signal)).rejects.toMatchObject({ code: "CANCELLED" });

      const controller = new AbortController();
      let deliveredAfterAbort = 0;
      let aborted = false;
      const pending = search.search(
        { pattern: "hit", maxResults: 100_000 },
        {
          onMatches: () => {
            if (aborted) deliveredAfterAbort++;
            aborted = true;
            controller.abort();
          },
        },
        controller.signal,
      );
      await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
      await Bun.sleep(50);
      expect(deliveredAfterAbort).toBe(0);
    });

    test("an empty pattern finds nothing", async () => {
      const run = await find({ pattern: "" });
      expect(run.summary).toMatchObject({ matchCount: 0, fileCount: 0, truncated: false });
    });
  });
}

describe("engine selection", () => {
  test("auto picks git-grep in a repository and builtin elsewhere when rg is absent", async () => {
    const repo = await tempDir();
    await initRepo(repo);
    const plain = await tempDir();
    expect(
      await new ContentSearch({ root: repo, env: GIT_TEST_ENV, ripgrepPath: null }).resolveEngine(),
    ).toBe("git-grep");
    expect(
      await new ContentSearch({ root: plain, env: GIT_TEST_ENV, ripgrepPath: null }).resolveEngine(),
    ).toBe("builtin");
    expect(await new ContentSearch({ root: plain, ripgrepPath: "/usr/local/bin/rg" }).resolveEngine()).toBe(
      "ripgrep",
    );
  });

  test("forcing an unavailable engine fails with a typed error", async () => {
    const plain = await tempDir();
    await writeTree(plain, { "a.txt": "needle\n" });
    const gitSearch = new ContentSearch({ root: plain, engine: "git-grep", env: GIT_TEST_ENV });
    await expect(gitSearch.search({ pattern: "needle" }, { onMatches: () => {} })).rejects.toMatchObject({
      code: "NOT_A_REPOSITORY",
    });
    const rgSearch = new ContentSearch({ root: plain, engine: "ripgrep", ripgrepPath: null });
    await expect(rgSearch.search({ pattern: "needle" }, { onMatches: () => {} })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });

  test("the builtin engine works outside a repository through the walk", async () => {
    const plain = await tempDir();
    await writeTree(plain, {
      "a.txt": "needle\n",
      "node_modules/x.js": "needle\n",
      "big.txt": "x".repeat(2 * 1024 * 1024),
    });
    const search = new ContentSearch({ root: plain, env: GIT_TEST_ENV, ripgrepPath: null });
    const found: SearchMatch[] = [];
    const summary = await search.search(
      { pattern: "needle" },
      { onMatches: (batch) => found.push(...batch) },
    );
    expect(summary.engine).toBe("builtin");
    expect(found.map((match) => match.path)).toEqual(["a.txt"]);
  });

  test("git-grep handles file names with spaces, Turkish characters and newlines", async () => {
    const root = await tempDir();
    await writeTree(root, { "ığüş dir/İstanbul notes.txt": "needle\n", "odd\nname.txt": "needle\n" });
    await initRepo(root);
    const search = new ContentSearch({ root: join(root), engine: "git-grep", env: GIT_TEST_ENV });
    const found: SearchMatch[] = [];
    await search.search({ pattern: "needle" }, { onMatches: (batch) => found.push(...batch) });
    expect(found.map((match) => match.path).sort()).toEqual(["odd\nname.txt", "ığüş dir/İstanbul notes.txt"]);
  });
});
