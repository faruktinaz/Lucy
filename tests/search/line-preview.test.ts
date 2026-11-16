import { describe, expect, test } from "bun:test";
import {
  canonicalGlobs,
  compileQuery,
  createPathFilter,
  hasUppercase,
} from "@/adapters/search/compile-query";
import { buildMatch, MAX_PREVIEW_LENGTH, utf8ToUtf16Offsets } from "@/adapters/search/line-preview";

describe("utf8ToUtf16Offsets", () => {
  test("maps byte offsets through multi-byte characters and surrogate pairs", () => {
    const text = "aığ🎉b";
    // Bytes: a(1) ı(2) ğ(2) 🎉(4) b(1)
    expect(utf8ToUtf16Offsets(text, [0, 1, 3, 5, 9, 10])).toEqual([0, 1, 2, 3, 5, 6]);
    expect(utf8ToUtf16Offsets(text, [9, 0])).toEqual([5, 0]);
  });
});

describe("buildMatch", () => {
  test("replaces control characters and expands tabs while keeping ranges aligned", () => {
    const match = buildMatch("a.ts", 3, "x\u0007\tfoo\u001b[31m bar\r\n", [
      [3, 6],
      [12, 15],
    ]);
    expect(match).not.toBeNull();
    if (!match) return;
    expect(match.column).toBe(4);
    expect(match.lineText.includes("\u001b")).toBe(false);
    expect(match.lineText.includes("\t")).toBe(false);
    expect(match.ranges.map((range) => match.lineText.slice(range.start, range.end))).toEqual(["foo", "bar"]);
  });

  test("windows long lines around the first match without splitting surrogate pairs", () => {
    const line = `${"🎉".repeat(400)}TARGET${"z".repeat(1000)}`;
    const start = line.indexOf("TARGET");
    const match = buildMatch("x", 1, line, [[start, start + 6]]);
    expect(match?.lineText.length).toBeLessThanOrEqual(MAX_PREVIEW_LENGTH);
    expect(match?.clippedStart).toBe(true);
    expect(match?.clippedEnd).toBe(true);
    const text = match?.lineText ?? "";
    expect(text.slice(match?.ranges[0]?.start, match?.ranges[0]?.end)).toBe("TARGET");
    // No lone surrogates at the edges.
    expect(/^[\udc00-\udfff]/.test(text)).toBe(false);
    expect(/[\ud800-\udbff]$/.test(text)).toBe(false);
  });

  test("returns null without ranges", () => {
    expect(buildMatch("x", 1, "text", [])).toBeNull();
  });
});

describe("query compilation", () => {
  test("smart case ignores escapes", () => {
    expect(hasUppercase("foo", false)).toBe(false);
    expect(hasUppercase("Foo", false)).toBe(true);
    expect(hasUppercase("İ", false)).toBe(true);
    expect(hasUppercase("\\W\\S\\p{Lu}x", true)).toBe(false);
    expect(compileQuery({ pattern: "\\Wfoo", isRegex: true }).caseSensitive).toBe(false);
  });

  test("canonical globs follow .gitignore intuition", () => {
    expect(canonicalGlobs(["*.ts", "./src/", "/docs/**", "", "**"])).toEqual([
      "**/*.ts",
      "**/*.ts/**",
      "src",
      "src/**",
      "docs/**",
    ]);
    const accept = createPathFilter(canonicalGlobs(["src"]), canonicalGlobs(["*.test.ts"]));
    expect(accept("src/a.ts")).toBe(true);
    expect(accept("src/deep/a.test.ts")).toBe(false);
    expect(accept("lib/src.ts")).toBe(false);
  });

  test("literal patterns are escaped; regex syntax errors are reported, not thrown", () => {
    const literal = compileQuery({ pattern: "a.b(c)-[d]" });
    expect(literal.regex?.test("xa.b(c)-[d]y")).toBe(true);
    const invalid = compileQuery({ pattern: "a(", isRegex: true });
    expect(invalid.regex).toBeNull();
    expect(invalid.regexError).toBeTruthy();
  });
});
