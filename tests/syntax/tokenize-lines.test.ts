import { describe, expect, test } from "bun:test";
import { type HighlightRange, tokenizeLines } from "../../src/adapters/syntax";

const r = (start: number, end: number, group: string): HighlightRange => ({ start, end, group });

describe("tokenizeLines", () => {
  test("returns one array per line, including empty and trailing lines", () => {
    expect(tokenizeLines("", [])).toEqual([[]]);
    expect(tokenizeLines("a\n\nb\n", [])).toEqual([[], [], [], []]);
  });

  test("splits a multi-line range at line ends and never includes line terminators", () => {
    const content = "/* a\r\nbb */ x";
    const lines = tokenizeLines(content, [r(0, 11, "comment")]);
    expect(lines).toEqual([
      [{ start: 0, end: 4, group: "comment" }],
      [{ start: 0, end: 5, group: "comment" }],
    ]);
  });

  test("the more specific group wins an overlap, the outer group resumes after it", () => {
    const content = 'x = "a\\nb"';
    const lines = tokenizeLines(content, [r(4, 10, "string"), r(6, 8, "string.escape")]);
    expect(lines[0]).toEqual([
      { start: 4, end: 6, group: "string" },
      { start: 6, end: 8, group: "string.escape" },
      { start: 8, end: 10, group: "string" },
    ]);
  });

  test("on a specificity tie the later range wins, as in OpenTUI", () => {
    const lines = tokenizeLines("main", [r(0, 4, "function"), r(0, 4, "variable")]);
    expect(lines[0]).toEqual([{ start: 0, end: 4, group: "variable" }]);
  });

  test("a more specific group beats a later, less specific one", () => {
    const lines = tokenizeLines("self", [r(0, 4, "variable.builtin"), r(0, 4, "variable")]);
    expect(lines[0]).toEqual([{ start: 0, end: 4, group: "variable.builtin" }]);
  });

  test("unstyled groups (spell, none, conceal, private captures) never win", () => {
    const lines = tokenizeLines("// hi", [
      r(0, 5, "comment"),
      r(0, 5, "spell"),
      r(0, 2, "conceal"),
      r(0, 5, "_x"),
    ]);
    expect(lines[0]).toEqual([{ start: 0, end: 5, group: "comment" }]);
  });

  test("merges adjacent spans of the same group and accepts unsorted input", () => {
    const lines = tokenizeLines("abcd", [r(2, 4, "keyword"), r(0, 2, "keyword")]);
    expect(lines[0]).toEqual([{ start: 0, end: 4, group: "keyword" }]);
  });

  test("ignores invalid ranges and clamps out-of-bounds ones", () => {
    const lines = tokenizeLines("abc", [
      r(2, 1, "keyword"),
      r(Number.NaN, 2, "keyword"),
      r(-5, 1, "string"),
      r(2, 99, "number"),
    ]);
    expect(lines[0]).toEqual([
      { start: 0, end: 1, group: "string" },
      { start: 2, end: 3, group: "number" },
    ]);
  });

  test("columns are UTF-16 code units within each line", () => {
    const content = 'ş = "😀"\nlet ğ';
    const lines = tokenizeLines(content, [r(4, 8, "string"), r(9, 12, "keyword")]);
    expect(lines[0]).toEqual([{ start: 4, end: 8, group: "string" }]);
    expect(lines[1]).toEqual([{ start: 0, end: 3, group: "keyword" }]);
    expect('ş = "😀"'.slice(4, 8)).toBe('"😀"');
  });

  test("tokens are sorted and never overlap on a dense random input", () => {
    const content = Array.from({ length: 50 }, (_, i) => `line ${i} ${"x".repeat(i % 7)}`).join("\n");
    const groups = ["keyword", "string", "string.escape", "comment", "function.call", "variable", "spell"];
    let seed = 7;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const ranges = Array.from({ length: 400 }, () => {
      const start = random(content.length);
      return r(start, start + 1 + random(40), groups[random(groups.length)] ?? "keyword");
    });
    for (const line of tokenizeLines(content, ranges)) {
      for (let i = 0; i < line.length; i++) {
        const token = line[i];
        const next = line[i + 1];
        if (!token) continue;
        expect(token.start).toBeLessThan(token.end);
        if (next) expect(token.end).toBeLessThanOrEqual(next.start);
      }
    }
  });
});
