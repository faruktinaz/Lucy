import { afterEach, describe, expect, test } from "bun:test";
import {
  compileFindQuery,
  DEFAULT_FIND_OPTIONS,
  FindModel,
  type FindOptions,
  formatFindLabel,
  matchesOnLine,
  splitLines,
} from "@/features/editor/model";
import { scanLines } from "@/features/editor/model/find-scanner";
import { generateLines, ms } from "./helpers";

const models: FindModel[] = [];
afterEach(() => {
  for (const model of models.splice(0)) model.dispose();
});

function model(lines: readonly string[], options?: ConstructorParameters<typeof FindModel>[0]): FindModel {
  const find = new FindModel(options);
  models.push(find);
  find.setDocument(lines);
  return find;
}

async function search(
  lines: readonly string[],
  query: string,
  options: Partial<FindOptions> = {},
): Promise<Array<[number, number, number]>> {
  const find = model(lines);
  find.setOptions(options);
  find.setQuery(query);
  await find.whenIdle();
  return find.store.get().matches.map((m) => [m.line, m.start, m.end]);
}

describe("compileFindQuery", () => {
  test("empty, literal, regex, invalid regex", () => {
    expect(compileFindQuery("", DEFAULT_FIND_OPTIONS)).toEqual({ kind: "empty" });
    expect(compileFindQuery("a.b", DEFAULT_FIND_OPTIONS)).toMatchObject({
      kind: "ok",
      source: "a\\.b",
      untrusted: false,
    });
    expect(compileFindQuery("a.b", { ...DEFAULT_FIND_OPTIONS, regex: true })).toMatchObject({
      kind: "ok",
      source: "a.b",
      untrusted: true,
    });
    const invalid = compileFindQuery("foo(", { ...DEFAULT_FIND_OPTIONS, regex: true });
    expect(invalid.kind).toBe("invalid");
    expect(invalid.kind === "invalid" && invalid.message.startsWith("Invalid regular expression: ")).toBe(
      true,
    );
    expect(invalid.kind === "invalid" && invalid.message).not.toContain("/foo(/");
  });

  test("legacy-only regex syntax falls back instead of failing", () => {
    // `\-` outside a class is an error with the u flag but fine without it.
    expect(compileFindQuery("a\\-b", { ...DEFAULT_FIND_OPTIONS, regex: true })).toMatchObject({
      kind: "ok",
      flags: "gi",
    });
  });
});

describe("matching", () => {
  const lines = ["const foo = foo();", "Foo bar FOO", "food", "no match here"];

  test("case-insensitive by default, UTF-16 columns per line", async () => {
    expect(await search(lines, "foo")).toEqual([
      [0, 6, 9],
      [0, 12, 15],
      [1, 0, 3],
      [1, 8, 11],
      [2, 0, 3],
    ]);
  });

  test("case sensitive", async () => {
    expect(await search(lines, "Foo", { caseSensitive: true })).toEqual([[1, 0, 3]]);
  });

  test("whole word", async () => {
    expect(await search(lines, "foo", { wholeWord: true })).toEqual([
      [0, 6, 9],
      [0, 12, 15],
      [1, 0, 3],
      [1, 8, 11],
    ]);
    // Unicode letters are word characters: "ış" inside "ışık" is not a whole word.
    expect(await search(["ışık ış"], "ış", { wholeWord: true })).toEqual([[0, 5, 7]]);
    // A decomposed "ş" (s + U+0327) is not a whole-word "s".
    expect(await search(["ş s"], "s", { wholeWord: true })).toEqual([[0, 3, 4]]);
  });

  test("regex with groups and zero-length matches", async () => {
    expect(await search(lines, "fo+(d)?", { regex: true, caseSensitive: true })).toEqual([
      [0, 6, 9],
      [0, 12, 15],
      [2, 0, 4],
    ]);
    // `^` matches once per line (zero-length), as in VS Code.
    expect(await search(["a", "b", ""], "^", { regex: true })).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ]);
  });

  test("never matches across lines", async () => {
    expect(await search(["foo", "bar"], "foo\\nbar", { regex: true })).toEqual([]);
  });

  test("CRLF documents: the CR is not part of the line", async () => {
    const crlf = splitLines("alpha end\r\nbeta end\r\n");
    expect(await search(crlf, "end$", { regex: true })).toEqual([
      [0, 6, 9],
      [1, 5, 8],
    ]);
  });

  test("columns are UTF-16 and surrogate pairs are never split", async () => {
    expect(await search(["😀 x 😀x"], "x")).toEqual([
      [0, 3, 4],
      [0, 7, 8],
    ]);
    // Zero-length matches step over the emoji as a whole.
    expect(await search(["😀"], "", { regex: true })).toEqual([]);
    expect(await search(["😀a"], "(?:)", { regex: true })).toEqual([
      [0, 0, 0],
      [0, 2, 2],
      [0, 3, 3],
    ]);
  });
});

describe("Turkish text (case-insensitive)", () => {
  const tr = ["İstanbul ve istanbul", "ISPARTA Isparta ısparta", "IŞIK ışık Işık", "ŞEHİR şehir"];

  test("plain text: i, I, İ and ı are one letter when case is ignored", async () => {
    expect(await search(tr, "istanbul")).toEqual([
      [0, 0, 8],
      [0, 12, 20],
    ]);
    expect(await search(tr, "ışık")).toEqual([
      [2, 0, 4],
      [2, 5, 9],
      [2, 10, 14],
    ]);
    expect(await search(tr, "ŞEHİR")).toEqual([
      [3, 0, 5],
      [3, 6, 11],
    ]);
    expect((await search(tr, "isparta")).length).toBe(3);
  });

  test("case-sensitive search keeps the letters distinct", async () => {
    expect(await search(tr, "İstanbul", { caseSensitive: true })).toEqual([[0, 0, 8]]);
    expect(await search(tr, "ışık", { caseSensitive: true })).toEqual([[2, 5, 9]]);
  });

  test("accents are never ignored", async () => {
    expect(await search(tr, "sehir")).toEqual([]);
  });

  test("regex mode keeps JavaScript's rules: İ only matches itself", async () => {
    expect(await search(tr, "istanbul", { regex: true })).toEqual([[0, 12, 20]]);
    expect(await search(tr, "ş", { regex: true })).toHaveLength(5);
  });
});

describe("FindModel state", () => {
  const lines = ["a x", "x", "b", "x x"];

  test("labels", () => {
    const base = { query: "x", status: "done" as const, matches: [], current: -1, limitHit: false };
    expect(formatFindLabel({ ...base, query: "" })).toBe("");
    expect(formatFindLabel(base)).toBe("No results");
    expect(formatFindLabel({ ...base, status: "searching" })).toBe("Searching…");
    expect(formatFindLabel({ ...base, status: "invalid" })).toBe("No results");
    const three = [
      { line: 0, start: 0, end: 1 },
      { line: 1, start: 0, end: 1 },
      { line: 2, start: 0, end: 1 },
    ];
    expect(formatFindLabel({ ...base, matches: three, current: 2 })).toBe("3 of 3");
    expect(formatFindLabel({ ...base, matches: three, limitHit: true })).toBe("3+");
    expect(formatFindLabel({ ...base, matches: three, status: "searching" })).toBe("3…");
  });

  test("current match starts at the anchor; next/previous wrap around", async () => {
    const find = model(lines);
    find.setQuery("x", { line: 1, column: 0 });
    await find.whenIdle();
    const state = find.store.get();
    expect(state.status).toBe("done");
    expect(state.matches).toHaveLength(4);
    expect(state.current).toBe(1);
    expect(state.label).toBe("2 of 4");
    expect(find.next()).toEqual({ line: 3, start: 0, end: 1 });
    expect(find.next()).toEqual({ line: 3, start: 2, end: 3 });
    expect(find.next()).toEqual({ line: 0, start: 2, end: 3 });
    expect(find.store.get().label).toBe("1 of 4");
    expect(find.previous()).toEqual({ line: 3, start: 2, end: 3 });
    expect(find.store.get().label).toBe("4 of 4");
  });

  test("anchor after the last match wraps to the first", async () => {
    const find = model(lines);
    find.setQuery("a", { line: 3, column: 0 });
    await find.whenIdle();
    expect(find.store.get().current).toBe(0);
  });

  test("No results, invalid regex message, clearing", async () => {
    const find = model(lines);
    find.setQuery("zzz");
    await find.whenIdle();
    expect(find.store.get()).toMatchObject({ status: "done", label: "No results", current: -1 });
    expect(find.next()).toBeNull();

    find.setOptions({ regex: true });
    find.setQuery("x(");
    await find.whenIdle();
    const invalid = find.store.get();
    expect(invalid.status).toBe("invalid");
    expect(invalid.error).toMatch(/^Invalid regular expression: /);
    expect(invalid.label).toBe("No results");

    find.clear();
    expect(find.store.get()).toMatchObject({ status: "idle", label: "", error: null, matches: [] });
  });

  test("toggling an option re-runs the query", async () => {
    const find = model(["Foo foo"]);
    find.setQuery("foo");
    await find.whenIdle();
    expect(find.store.get().matches).toHaveLength(2);
    find.toggleOption("caseSensitive");
    await find.whenIdle();
    expect(find.store.get().matches).toHaveLength(1);
    expect(find.store.get().options.caseSensitive).toBe(true);
  });

  test("matchesOnLine is a cheap per-line lookup", async () => {
    const find = model(lines);
    find.setQuery("x");
    await find.whenIdle();
    expect(find.matchesOnLine(3)).toEqual([
      { line: 3, start: 0, end: 1 },
      { line: 3, start: 2, end: 3 },
    ]);
    expect(find.matchesOnLine(2)).toEqual([]);
    expect(find.lineMatchRange(1)).toEqual([1, 2]);
    expect(matchesOnLine([], 5)).toEqual([]);
  });

  test("a document reload re-runs the query and stays near the current match", async () => {
    const find = model(lines);
    find.setQuery("x");
    await find.whenIdle();
    find.select(2);
    find.setDocument(["x", "", "", "x", "x"]);
    await find.whenIdle();
    const state = find.store.get();
    expect(state.matches).toHaveLength(3);
    expect(state.matches[state.current]).toEqual({ line: 3, start: 0, end: 1 });
  });

  test("cap: label 10000+ and the scan stops", async () => {
    const many = Array.from({ length: 6000 }, () => "a a");
    const find = model(many);
    find.setQuery("a");
    await find.whenIdle();
    const state = find.store.get();
    expect(state.matches).toHaveLength(10_000);
    expect(state.limitHit).toBe(true);
    expect(state.label).toBe("1 of 10000+");

    const exact = model(Array.from({ length: 5000 }, () => "a a"));
    exact.setQuery("a");
    await exact.whenIdle();
    expect(exact.store.get()).toMatchObject({ limitHit: false, label: "1 of 10000" });
  });

  test("a new query cancels the running scan (large document, small slices)", async () => {
    const big = splitLines(generateLines(50_000));
    const find = model(big, { sliceMs: 1 });
    let notifications = 0;
    find.store.subscribe(() => notifications++);
    find.setQuery("value");
    expect(find.store.get().status).toBe("searching");
    find.setQuery("section 49990");
    await find.whenIdle();
    const state = find.store.get();
    expect(state.query).toBe("section 49990");
    expect(state.matches).toEqual([{ line: 49_990, start: 3, end: 16 }]);
    expect(notifications).toBeGreaterThan(1);
  });

  test("scanLines yields to the event loop between slices", async () => {
    const big = splitLines(generateLines(50_000));
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    let batches = 0;
    const outcome = await scanLines(big, /needle/g, {
      maxMatches: 100_000,
      sliceMs: 1,
      onBatch: () => batches++,
    });
    clearInterval(timer);
    expect(outcome).toEqual({ limitHit: false, timedOut: false });
    expect(batches).toBeGreaterThan(1);
    expect(ticks).toBeGreaterThan(0);
  });

  test("timing: 50k-line document, literal and regex", async () => {
    const big = splitLines(generateLines(50_000));
    const literal = model(big);
    let started = performance.now();
    literal.setQuery("needle-3");
    await literal.whenIdle();
    const literalTime = ms(started);
    const literalState = literal.store.get();
    expect(literalState.status).toBe("done");
    expect(literalState.matches.length).toBe(6428);

    const turkish = model(big);
    started = performance.now();
    turkish.setQuery("istanbul");
    await turkish.whenIdle();
    const turkishTime = ms(started);
    expect(turkish.store.get().matches.length).toBe(5000);

    const regex = model(big);
    regex.setOptions({ regex: true });
    started = performance.now();
    regex.setQuery("value\\d+5 =");
    await regex.whenIdle();
    const regexTime = ms(started);
    expect(regex.store.get().status).toBe("done");
    expect(regex.store.get().matches.length).toBe(4999);

    const capped = model(big);
    started = performance.now();
    capped.setQuery("e");
    await capped.whenIdle();
    const cappedTime = ms(started);
    expect(capped.store.get().label).toBe("1 of 10000+");
    console.log(
      `[timing] find in 50k lines: literal ${literalTime} (6428 matches), Turkish i ${turkishTime} (5000), ` +
        `regex via worker ${regexTime} (4999), cap reached ${cappedTime}`,
    );
  });
});

describe("catastrophic regular expressions", () => {
  const evil = [`${"a".repeat(40)}!`, "aaa"];

  test("worker engine: stopped by the time budget, UI thread stays responsive", async () => {
    const find = model(evil, { regexBudgetMs: 300 });
    find.setOptions({ regex: true });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const started = performance.now();
    find.setQuery("^(a+)+$");
    await find.whenIdle();
    const elapsed = performance.now() - started;
    clearInterval(timer);
    const state = find.store.get();
    expect(state.status).toBe("stopped");
    expect(state.error).toBe(
      "The regular expression took longer than 0.3 s and was stopped; results may be incomplete.",
    );
    expect(elapsed).toBeLessThan(2000);
    expect(ticks).toBeGreaterThan(5); // timers kept firing while the regex ran
    console.log(`[timing] catastrophic regex stopped after ${elapsed.toFixed(0)} ms (budget 300 ms)`);

    // The model recovers: the next query spawns a fresh worker.
    find.setQuery("a{3}");
    await find.whenIdle();
    expect(find.store.get()).toMatchObject({ status: "done" });
    expect(find.store.get().matches.length).toBe(14);
  });

  test("changing the query while a regex is stuck terminates it", async () => {
    const find = model(evil, { regexBudgetMs: 10_000 });
    find.setOptions({ regex: true });
    find.setQuery("^(a+)+$");
    await Bun.sleep(50);
    const started = performance.now();
    find.setQuery("aaa");
    await find.whenIdle();
    expect(performance.now() - started).toBeLessThan(2000);
    expect(find.store.get()).toMatchObject({ status: "done", query: "aaa" });
  });

  test("inline engine: the soft budget stops slow-but-finite scans between lines", async () => {
    // Each line takes a few ms; together they exceed the budget.
    const slow = Array.from({ length: 400 }, () => `${"a".repeat(18)}!`);
    const find = model(slow, { regexEngine: "inline", regexBudgetMs: 50, sliceMs: 5 });
    find.setOptions({ regex: true });
    const started = performance.now();
    find.setQuery("^(a+)+$");
    await find.whenIdle();
    const elapsed = performance.now() - started;
    expect(find.store.get().status).toBe("stopped");
    expect(elapsed).toBeLessThan(1500);
  });
});
