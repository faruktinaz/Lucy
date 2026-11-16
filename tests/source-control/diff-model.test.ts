import { describe, expect, test } from "bun:test";
import {
  DiffModel,
  parseUnifiedDiff,
  type SplitPairRow,
  type SplitRow,
  type UnifiedRow,
} from "@/features/source-control/model";

function model(...hunkLines: string[]): DiffModel {
  return new DiffModel(parseUnifiedDiff(`--- a/f\n+++ b/f\n${hunkLines.join("\n")}\n`));
}

/** Compact picture of split rows: `L|R` with line numbers, `_` for a filler, `@` for headers. */
function picture(rows: readonly SplitRow[]): string[] {
  return rows.map((row) => {
    if (row.kind === "hunk") return "@";
    const side = (cell: SplitPairRow["left"], sign: string) =>
      cell ? `${sign}${cell.lineNumber}:${cell.text}` : "_";
    return `${side(row.left, row.left?.type === "removed" ? "-" : " ")}|${side(row.right, row.right?.type === "added" ? "+" : " ")}`;
  });
}

function unifiedPicture(rows: readonly UnifiedRow[]): string[] {
  return rows.map((row) =>
    row.kind === "hunk"
      ? `@ ${row.header}`
      : `${row.oldLine ?? "."} ${row.newLine ?? "."} ${row.sign}${row.text}`,
  );
}

describe("unified rows", () => {
  test("hunk headers and line rows with numbers, signs and stable keys", () => {
    const m = model("@@ -1,3 +1,3 @@ fn", " a", "-b", "+B", " c", "@@ -10,1 +10,2 @@", " x", "+y");
    expect(unifiedPicture(m.unified)).toEqual([
      "@ @@ -1,3 +1,3 @@ fn",
      "1 1  a",
      "2 . -b",
      ". 2 +B",
      "3 3  c",
      "@ @@ -10,1 +10,2 @@",
      "10 10  x",
      ". 11 +y",
    ]);
    expect(m.unified.map((row) => row.key)).toEqual([
      "h0",
      "h0:0",
      "h0:1",
      "h0:2",
      "h0:3",
      "h1",
      "h1:0",
      "h1:1",
    ]);
    const again = model("@@ -1,3 +1,3 @@ fn", " a", "-b", "+B", " c", "@@ -10,1 +10,2 @@", " x", "+y");
    expect(again.unified.map((row) => row.key)).toEqual(m.unified.map((row) => row.key));
    expect(m.unified[0]).toMatchObject({ kind: "hunk", section: "fn" });
  });

  test("changes, hunks, counts and navigation", () => {
    const m = model(
      "@@ -1,6 +1,5 @@",
      " a",
      "-b",
      "+B",
      " c",
      " d",
      "-e",
      " f",
      "@@ -20,2 +20,3 @@",
      " x",
      "+y",
      " z",
    );
    expect(m.added).toBe(2);
    expect(m.removed).toBe(2);
    expect(m.changes.map((c) => [c.hunkIndex, c.firstLine, c.removed, c.added, c.unifiedRow])).toEqual([
      [0, 1, 1, 1, 2],
      [0, 5, 1, 0, 6],
      [1, 1, 0, 1, 10],
    ]);
    expect(m.hunks.map((h) => [h.unifiedRow, h.added, h.removed, h.changes])).toEqual([
      [0, 1, 2, [0, 1]],
      [8, 1, 0, [2]],
    ]);
    expect(m.diff.problems).toEqual([]);
    expect(m.nextChange(-1)).toBe(2);
    expect(m.nextChange(2)).toBe(6);
    expect(m.nextChange(6)).toBe(10);
    expect(m.nextChange(10)).toBeNull();
    expect(m.previousChange(10)).toBe(6);
    expect(m.previousChange(3)).toBe(2);
    expect(m.previousChange(2)).toBeNull();
    expect(m.hunkAt(10)).toBe(1);
    expect(m.hunkAt(999)).toBeNull();
    const line = m.unified[3];
    expect(line?.kind === "line" ? line.changeIndex : "x").toBe(0);
  });

  test("row cap sets truncated and keeps navigation inside the rendered rows", () => {
    const body = Array.from({ length: 50 }, (_, i) => `+line ${i}`);
    const m = new DiffModel(
      parseUnifiedDiff(`--- a/f\n+++ b/f\n@@ -0,0 +1,50 @@\n${body.join("\n")}\n@@ -90 +100 @@\n-x\n+y\n`),
      {
        maxRows: 10,
      },
    );
    expect(m.unified).toHaveLength(10);
    expect(m.truncated).toBe(true);
    expect(m.added).toBe(51);
    expect(m.changes[1]?.unifiedRow).toBe(-1);
    expect(m.hunks[1]?.unifiedRow).toBe(-1);
    expect(m.nextChange(1)).toBeNull();
    expect(m.split).toHaveLength(10);
    expect(m.splitTruncated).toBe(true);
  });
});

describe("split rows", () => {
  test("a change block pairs removed and added lines one by one; extras get fillers", () => {
    const m = model("@@ -1,5 +1,4 @@", " a", "-b", "-c", "-d", "+B", "+C", " e");
    expect(picture(m.split)).toEqual(["@", " 1:a| 1:a", "-2:b|+2:B", "-3:c|+3:C", "-4:d|_", " 5:e| 4:e"]);
  });

  test("more added than removed", () => {
    const m = model("@@ -1,2 +1,4 @@", "-x", "+X", "+Y", "+Z", " end");
    expect(picture(m.split)).toEqual(["@", "-1:x|+1:X", "_|+2:Y", "_|+3:Z", " 2:end| 4:end"]);
  });

  test("additions only and deletions only", () => {
    expect(picture(model("@@ -0,0 +1,2 @@", "+one", "+two").split)).toEqual(["@", "_|+1:one", "_|+2:two"]);
    expect(picture(model("@@ -1,2 +0,0 @@", "-one", "-two").split)).toEqual(["@", "-1:one|_", "-2:two|_"]);
  });

  test("separate blocks are never paired across context; interleaved +/- lines pair in order", () => {
    expect(picture(model("@@ -1,3 +1,3 @@", "-a", " m", "+b").split)).toEqual([
      "@",
      "-1:a|_",
      " 2:m| 1:m",
      "_|+2:b",
    ]);
    expect(picture(model("@@ -1,2 +1,2 @@", "-a", "+A", "-b", "+B").split)).toEqual([
      "@",
      "-1:a|+1:A",
      "-2:b|+2:B",
    ]);
  });

  test("split keys are unique and stable; change and hunk rows map into split rows", () => {
    const m = model("@@ -1,4 +1,4 @@", " a", "-b", "+B", " c", "-d", "+D", "@@ -9 +9 @@", "-z", "+Z");
    const keys = m.split.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["h0", "h0:0:0", "h0:1:2", "h0:3:3", "h0:4:5", "h1", "h1:0:1"]);
    expect(m.changeRows("split")).toEqual([2, 4, 6]);
    expect(m.hunkRows("split")).toEqual([0, 5]);
    expect(m.nextChange(2, "split")).toBe(4);
    expect(m.previousChange(6, "split")).toBe(4);
    const pair = m.split[2];
    expect(pair?.kind === "pair" ? pair.changeIndex : null).toBe(0);
  });

  test("no-newline markers travel with their cells", () => {
    const m = model("@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+a");
    const pair = m.split[1];
    expect(pair?.kind === "pair" ? [pair.left?.noNewlineAtEnd, pair.right?.noNewlineAtEnd] : null).toEqual([
      true,
      false,
    ]);
  });
});

describe("word ranges", () => {
  test("computed lazily for paired lines, cached, and absent for unpaired or context lines", () => {
    const m = model(
      "@@ -1,3 +1,3 @@",
      " ctx",
      "-let total = price * count;",
      "-gone();",
      "+let total = price * quantity;",
    );
    expect(m.partner({ hunk: 0, line: 1 })).toEqual({ hunk: 0, line: 3 });
    expect(m.partner({ hunk: 0, line: 3 })).toEqual({ hunk: 0, line: 1 });
    expect(m.partner({ hunk: 0, line: 2 })).toBeNull();
    const removed = m.wordRanges({ hunk: 0, line: 1 });
    const added = m.wordRanges({ hunk: 0, line: 3 });
    expect(removed).toEqual([{ start: 20, end: 25 }]);
    expect(added).toEqual([{ start: 20, end: 28 }]);
    expect(m.wordRanges({ hunk: 0, line: 3 })).toBe(added);
    expect(m.wordRanges({ hunk: 0, line: 2 })).toBeNull();
    expect(m.wordRanges({ hunk: 0, line: 0 })).toBeNull();
    expect(m.wordRanges({ hunk: 5, line: 0 })).toBeNull();
  });
});

describe("large diffs", () => {
  test("a 20 000-line patch parses and builds rows quickly", () => {
    const parts = ["--- a/big.txt", "+++ b/big.txt"];
    // 2 000 hunks of 10 lines: 4 context, 3 removed, 3 added.
    for (let h = 0; h < 2_000; h++) {
      const start = h * 20 + 1;
      parts.push(`@@ -${start},7 +${start},7 @@ section ${h}`);
      parts.push(
        " context one",
        " context two",
        `-old value ${h} a`,
        `-old value ${h} b`,
        `-old value ${h} c`,
      );
      parts.push(
        `+new value ${h} a`,
        `+new value ${h} b`,
        `+new value ${h} c`,
        " context three",
        " context four",
      );
    }
    const patch = `${parts.join("\n")}\n`;
    let t = performance.now();
    const parsed = parseUnifiedDiff(patch);
    const parseMs = performance.now() - t;
    t = performance.now();
    const m = new DiffModel(parsed);
    const unifiedMs = performance.now() - t;
    t = performance.now();
    const split = m.split;
    const splitMs = performance.now() - t;
    t = performance.now();
    for (let i = 0; i < 60; i++) m.wordRanges({ hunk: i, line: 2 });
    const wordMs = performance.now() - t;
    console.log(
      `20k-line patch: parse ${parseMs.toFixed(1)} ms, unified rows ${unifiedMs.toFixed(1)} ms, split rows ${splitMs.toFixed(1)} ms, 60 word diffs ${wordMs.toFixed(1)} ms`,
    );
    expect(parsed.hunks).toHaveLength(2_000);
    expect(parsed.problems).toEqual([]);
    expect(m.unified).toHaveLength(22_000);
    expect(split).toHaveLength(2_000 * 8);
    expect(m.added).toBe(6_000);
    expect(m.truncated).toBe(false);
    expect(parseMs + unifiedMs + splitMs).toBeLessThan(1_000);
  });
});
