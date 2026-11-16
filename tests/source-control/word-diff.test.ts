import { describe, expect, test } from "bun:test";
import { tokenizeForWordDiff, type WordRange, wordDiff } from "@/features/source-control/model";

/** The substrings a list of ranges covers, for readable assertions. */
function cut(text: string, ranges: readonly WordRange[] | undefined): string[] {
  return (ranges ?? []).map((range) => text.slice(range.start, range.end));
}

describe("tokenizeForWordDiff", () => {
  test("words in any script, whitespace runs and single punctuation", () => {
    expect(tokenizeForWordDiff("foo_bar(x,  şırınga)→🚀").map((t) => t.text)).toEqual([
      "foo_bar",
      "(",
      "x",
      ",",
      "  ",
      "şırınga",
      ")",
      "→",
      "🚀",
    ]);
    const tokens = tokenizeForWordDiff("a 🚀b");
    expect(tokens.map((t) => [t.start, t.end, t.isSpace])).toEqual([
      [0, 1, false],
      [1, 2, true],
      [2, 4, false],
      [4, 5, false],
    ]);
  });
});

describe("wordDiff", () => {
  test("a changed word", () => {
    const oldText = "const value = compute(alpha, beta);";
    const newText = "const value = compute(alpha, gamma);";
    const result = wordDiff(oldText, newText);
    expect(cut(oldText, result?.old)).toEqual(["beta"]);
    expect(cut(newText, result?.new)).toEqual(["gamma"]);
    expect(result?.similarity).toBeGreaterThan(0.8);
  });

  test("pure insertion and pure deletion", () => {
    const inserted = wordDiff("call(a, b)", "call(a, extra, b)");
    expect(inserted?.old).toEqual([]);
    expect(cut("call(a, extra, b)", inserted?.new)).toEqual(["extra, "]);
    const deleted = wordDiff("return cached ?? load();", "return load();");
    expect(cut("return cached ?? load();", deleted?.old)).toEqual(["cached ?? "]);
    expect(deleted?.new).toEqual([]);
  });

  test("identical lines have no ranges", () => {
    expect(wordDiff("same", "same")).toEqual({ old: [], new: [], similarity: 1 });
  });

  test("changes separated only by whitespace merge into one range", () => {
    const oldText = "if (ready) start the old engine now";
    const newText = "if (ready) start a brand new engine now";
    const result = wordDiff(oldText, newText);
    expect(cut(oldText, result?.old)).toEqual(["the old"]);
    expect(cut(newText, result?.new)).toEqual(["a brand new"]);
  });

  test("Turkish words and emoji are compared as units with UTF-16 columns", () => {
    const oldText = "selam('Merhaba dünya') // 👋";
    const newText = "selam('Merhaba güzel dünya') // 🚀";
    const result = wordDiff(oldText, newText);
    expect(cut(newText, result?.new)).toEqual(["güzel ", "🚀"]);
    expect(cut(oldText, result?.old)).toEqual(["👋"]);
  });

  test("indentation-only change", () => {
    const result = wordDiff("  return x;", "    return x;");
    expect(cut("  return x;", result?.old)).toEqual(["  "]);
    expect(cut("    return x;", result?.new)).toEqual(["    "]);
  });

  test("too dissimilar lines are skipped (below 40 % shared non-whitespace characters)", () => {
    expect(wordDiff("import { readFile } from 'node:fs';", "export default function main() {}")).toBeNull();
    expect(wordDiff("abc", "xyz")).toBeNull();
    // Just above the threshold still highlights.
    expect(wordDiff("alpha beta gamma delta", "alpha beta zeta theta")).not.toBeNull();
    expect(wordDiff("alpha beta", "gamma delta", { minSimilarity: 0 })).not.toBeNull();
  });

  test("too long lines and too large tables are skipped", () => {
    const long = `${"word ".repeat(250)}end`;
    expect(wordDiff(long, `${long}!`)).toBeNull();
    expect(wordDiff(long, `${long}!`, { maxLineLength: 10_000 })).not.toBeNull();
    const a = Array.from({ length: 300 }, (_, i) => `a${i}`).join(" ");
    const b = Array.from({ length: 300 }, (_, i) => `b${i}`).join(" ");
    expect(wordDiff(a, b, { maxLineLength: 100_000, maxCells: 1_000, minSimilarity: 0 })).toBeNull();
  });
});
