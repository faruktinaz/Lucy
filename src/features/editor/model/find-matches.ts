/**
 * Find matches and lookups over them. The scanning core (`collectLineMatches`) is shared with
 * the regex worker and lives in `src/core/regex-worker/line-matches.ts`.
 */
import type { LineMatch } from "@/core/regex-worker/line-matches";

export { collectLineMatches } from "@/core/regex-worker/line-matches";

/** One match on one line; `start`/`end` are UTF-16 columns into the viewer line (end exclusive). */
export type FindMatch = LineMatch;

/** Index of the first match on `line` or later (binary search; matches are in document order). */
function lowerBound(matches: readonly FindMatch[], line: number, column: number): number {
  let low = 0;
  let high = matches.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const m = matches[mid] as FindMatch;
    if (m.line < line || (m.line === line && m.start < column)) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** `[from, to)` indices of the matches on `line`: O(log n), no allocation. For the renderer's row loop. */
export function lineMatchRange(matches: readonly FindMatch[], line: number): readonly [number, number] {
  const from = lowerBound(matches, line, 0);
  let to = from;
  while (to < matches.length && (matches[to] as FindMatch).line === line) to++;
  return [from, to];
}

export function matchesOnLine(matches: readonly FindMatch[], line: number): readonly FindMatch[] {
  const [from, to] = lineMatchRange(matches, line);
  return from === to ? [] : matches.slice(from, to);
}

/** Index of the first match at or after the position, or -1. */
export function firstMatchAtOrAfter(matches: readonly FindMatch[], line: number, column: number): number {
  const index = lowerBound(matches, line, column);
  return index < matches.length ? index : -1;
}
