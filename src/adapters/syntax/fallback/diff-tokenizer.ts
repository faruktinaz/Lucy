/**
 * Unified diffs and patches (`.diff`, `.patch`, `git format-patch` output). Added and removed
 * lines use nvim's `diff.plus`/`diff.minus` groups (the `inserted`/`deleted` tokens); file headers
 * and hunk headers get their own colors so the structure is visible at a glance.
 */
import type { HighlightRange } from "../types";

const FILE_HEADER =
  /^(?:diff |index |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|Binary files )/;
const HUNK = /^@@ [^@\n]* @@/;

/** Highlights `text[from, to)` as diff lines and appends the ranges to `out`. */
export function tokenizeDiffInto(text: string, from: number, to: number, out: HighlightRange[]): void {
  let i = from;
  while (i < to) {
    const newline = text.indexOf("\n", i);
    const lineEnd = newline === -1 || newline > to ? to : newline;
    let end = lineEnd;
    if (text[end - 1] === "\r") end--;
    const line = text.slice(i, end);
    if (line.length > 0) {
      const hunk = HUNK.exec(line);
      if (line.startsWith("+++") || (line.startsWith("+") && !line.startsWith("++ "))) {
        out.push({ start: i, end, group: "diff.plus" });
      } else if (line.startsWith("---") || line.startsWith("-")) {
        out.push({ start: i, end, group: line === "-- " || line === "--" ? "comment" : "diff.minus" });
      } else if (hunk) {
        out.push({ start: i, end: i + hunk[0].length, group: "type" });
      } else if (FILE_HEADER.test(line)) {
        out.push({ start: i, end, group: "function" });
      } else if (line.startsWith("\\")) {
        out.push({ start: i, end, group: "comment" });
      }
    }
    i = lineEnd + 1;
  }
}

export function tokenizeDiff(text: string): HighlightRange[] {
  const out: HighlightRange[] = [];
  tokenizeDiffInto(text, 0, text.length, out);
  return out;
}
