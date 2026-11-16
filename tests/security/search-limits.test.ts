/**
 * Item: search engine limits.
 *
 * - ripgrep gets `--max-filesize`; its `--json` records are read with a line-length cap, and a
 *   record cut by that cap is reported (`long-line`), never silently dropped.
 * - git grep: long output lines are cut while streaming (the match is kept and reported), files
 *   above the size limit are dropped.
 * - The builtin engine runs regexes in a worker: a catastrophic pattern ends at the budget, the
 *   event loop keeps ticking meanwhile, and the summary says the budget was hit.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileQuery } from "@/adapters/search/compile-query";
import { ContentSearch } from "@/adapters/search/content-search";
import { ripgrepArgs } from "@/adapters/search/ripgrep-engine";
import type { ContentSearchQuery, SearchMatch, SearchSummary } from "@/adapters/search/search-types";
import { which } from "@/core/process";
import { commitAll, GIT_TEST_ENV, initRepo, writeTree } from "../filesystem/helpers";

setDefaultTimeout(30_000);

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lucy-limits-")));
  dirs.push(dir);
  return dir;
}

async function collect(
  search: ContentSearch,
  query: ContentSearchQuery,
): Promise<{ matches: SearchMatch[]; summary: SearchSummary }> {
  const matches: SearchMatch[] = [];
  const summary = await search.search(query, { onMatches: (batch) => matches.push(...batch) });
  return { matches, summary };
}

describe("ripgrep", () => {
  test("arguments cap the file size", () => {
    const args = ripgrepArgs("/usr/bin/rg", compileQuery({ pattern: "x" }), { maxFileBytes: 1234 });
    const at = args.indexOf("--max-filesize");
    expect(at).toBeGreaterThan(0);
    expect(args[at + 1]).toBe("1234");
    expect(args.slice(-3)).toEqual(["x", "--", "."]);
  });

  test("a JSON record longer than maxLineBytes is reported as a long-line limit, others still arrive", async () => {
    const root = tempDir();
    const argsFile = join(root, "rg-args.json");
    // A stand-in for rg that records its arguments and prints one huge and one normal match.
    const emitter = join(root, "emit.js");
    await writeFile(
      emitter,
      `require("node:fs").writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
const match = (path, text, line) => JSON.stringify({ type: "match", data: { path: { text: path }, lines: { text },
  line_number: line, absolute_offset: 0, submatches: [{ match: { text: "needle" }, start: 0, end: 6 }] } });
process.stdout.write(match("./huge.min.js", "needle" + "x".repeat(3 * 1024 * 1024) + "\\n", 1) + "\\n");
process.stdout.write(match("./small.txt", "needle here\\n", 7) + "\\n");`,
    );
    const fakeRg = join(root, "fake-rg");
    await writeFile(fakeRg, `#!/bin/sh\nexec "${process.execPath}" "${emitter}" "$@"\n`);
    await chmod(fakeRg, 0o755);

    const search = new ContentSearch({
      root,
      engine: "ripgrep",
      ripgrepPath: fakeRg,
      limits: { maxLineBytes: 1024 * 1024 },
    });
    const { matches, summary } = await collect(search, { pattern: "needle" });
    expect(matches.map((m) => [m.path, m.line])).toEqual([["small.txt", 7]]);
    expect(summary.truncated).toBe(true);
    expect(summary.limitsHit).toEqual(["long-line"]);
    const args = JSON.parse(await readFile(argsFile, "utf8")) as string[];
    expect(args).toContain("--max-filesize");
    expect(args[args.indexOf("--max-filesize") + 1]).toBe(String(16 * 1024 * 1024));
  });

  const rg = which("rg");
  test.skipIf(rg === null)("real ripgrep skips files above maxFileBytes", async () => {
    const root = tempDir();
    await writeTree(root, { "small.txt": "needle\n", "big.txt": `needle\n${"y".repeat(200_000)}\n` });
    const search = new ContentSearch({
      root,
      engine: "ripgrep",
      ripgrepPath: rg,
      limits: { maxFileBytes: 100_000 },
    });
    const { matches } = await collect(search, { pattern: "needle" });
    expect(matches.map((m) => m.path)).toEqual(["small.txt"]);
  });
});

describe("git grep", () => {
  test("a line above maxLineBytes is cut while streaming: the match is kept and the limit reported", async () => {
    const root = tempDir();
    await writeTree(root, {
      "bundle.min.js": `var a="needle";${"x".repeat(3 * 1024 * 1024)}\n`,
      "plain.txt": "a needle\n",
    });
    await initRepo(root);
    await commitAll(root);
    const search = new ContentSearch({
      root,
      engine: "git-grep",
      env: GIT_TEST_ENV,
      ripgrepPath: null,
      limits: { maxLineBytes: 64 * 1024 },
    });
    const { matches, summary } = await collect(search, { pattern: "needle" });
    expect(matches.map((m) => m.path).sort()).toEqual(["bundle.min.js", "plain.txt"]);
    const bundle = matches.find((m) => m.path === "bundle.min.js");
    expect(bundle?.column).toBe(8);
    expect(bundle?.ranges.length).toBe(1);
    expect(bundle?.clippedEnd).toBe(true);
    expect(summary.truncated).toBe(true);
    expect(summary.limitsHit).toEqual(["long-line"]);
  });

  test("files above maxFileBytes are dropped; smaller files still match", async () => {
    const root = tempDir();
    await writeTree(root, {
      "big.txt": `needle\n${"y\n".repeat(100_000)}`,
      "small.txt": "needle\n",
    });
    await initRepo(root);
    await commitAll(root);
    const search = new ContentSearch({
      root,
      engine: "git-grep",
      env: GIT_TEST_ENV,
      ripgrepPath: null,
      limits: { maxFileBytes: 100_000 },
    });
    const { matches, summary } = await collect(search, { pattern: "needle" });
    expect(matches.map((m) => m.path)).toEqual(["small.txt"]);
    expect(summary.truncated).toBe(false);
  });
});

describe("builtin engine: regexes run in a worker with a hard budget", () => {
  test("a catastrophic pattern ends at the budget while the event loop keeps ticking", async () => {
    const root = tempDir();
    const evil = `${"a".repeat(48)}!`;
    await writeTree(root, {
      "a-evil.txt": `${evil}\n${evil}\n`,
      "b-fine.txt": "aaaa\nzzz\n",
    });
    const search = new ContentSearch({
      root,
      engine: "builtin",
      ripgrepPath: null,
      builtinLimits: { perFileBudgetMs: 300, concurrency: 1 },
    });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const started = performance.now();
    let result: Awaited<ReturnType<typeof collect>>;
    try {
      result = await collect(search, { pattern: "(a+)+$", isRegex: true });
    } finally {
      clearInterval(timer);
    }
    const elapsed = performance.now() - started;
    console.log(
      `[timing] catastrophic builtin regex: ${elapsed.toFixed(0)} ms, ${ticks} ticks (budget 300 ms)`,
    );
    // The budget plus worker start-up and a fresh worker for the next file; never minutes.
    expect(elapsed).toBeLessThan(3000);
    expect(elapsed).toBeGreaterThanOrEqual(290);
    // On a blocked main thread the interval could not fire at all during the scan.
    expect(ticks).toBeGreaterThanOrEqual(15);
    expect(result.summary.truncated).toBe(true);
    expect(result.summary.limitsHit).toContain("time-budget");
    // The next file is still searched by a fresh worker.
    expect(result.matches.map((m) => [m.path, m.line])).toEqual([["b-fine.txt", 1]]);
  });

  test("cancelling during a catastrophic scan rejects promptly", async () => {
    const root = tempDir();
    await writeTree(root, { "evil.txt": `${"a".repeat(48)}!\n` });
    const search = new ContentSearch({
      root,
      engine: "builtin",
      ripgrepPath: null,
      builtinLimits: { perFileBudgetMs: 60_000 },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const started = performance.now();
    const error = await search
      .search({ pattern: "(a+)+$", isRegex: true }, { onMatches: () => {} }, controller.signal)
      .catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("CANCELLED");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("regex results keep the shared match shape (ranges, columns, capped per line)", async () => {
    const root = tempDir();
    await writeTree(root, { "x.txt": "foo bar foo\r\n\tfoo\n", "many.txt": `${"ab".repeat(300)}\n` });
    const search = new ContentSearch({ root, engine: "builtin", ripgrepPath: null });
    const { matches } = await collect(search, { pattern: "fo+", isRegex: true });
    expect(matches.map((m) => [m.line, m.column, m.ranges.length])).toEqual([
      [1, 1, 2],
      [2, 2, 1],
    ]);
    const many = await collect(search, { pattern: "b", isRegex: true, include: ["many.txt"] });
    expect(many.matches[0]?.ranges.length).toBeLessThanOrEqual(100);
  });
});
