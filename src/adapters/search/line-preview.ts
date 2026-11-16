/**
 * Builds the display-safe `SearchMatch` for one line from raw match ranges, plus UTF-8 byte
 * offset conversion (ripgrep and `git grep` report byte columns; JavaScript strings are UTF-16).
 */
import { sanitizeForDisplay } from "@/core/text";
import type { MatchRange, SearchMatch } from "./search-types";

/** Longest `lineText` in UTF-16 units (before tab expansion). */
export const MAX_PREVIEW_LENGTH = 500;
/** Characters of context kept before the first match when a long line is cut. */
const CONTEXT_BEFORE = 40;
const MAX_RANGES_PER_LINE = 100;

function isBlank(code: number): boolean {
  return code === 32 || code === 9;
}

/**
 * `ranges` are `[start, end)` UTF-16 offsets in `rawLine`, which may still carry its line
 * terminator. Returns `null` when no range lies on the line.
 */
export function buildMatch(
  path: string,
  line: number,
  rawLine: string,
  ranges: ReadonlyArray<readonly [number, number]>,
): SearchMatch | null {
  let text = rawLine;
  if (text.endsWith("\n")) text = text.slice(0, -1);
  if (text.endsWith("\r")) text = text.slice(0, -1);
  const length = text.length;
  const sorted = ranges
    .map(
      ([start, end]) =>
        [Math.min(Math.max(0, start), length), Math.min(Math.max(start, end), length)] as const,
    )
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const first = sorted[0];
  if (!first) return null;

  let start = 0;
  let end = length;
  if (length > MAX_PREVIEW_LENGTH) {
    start = Math.max(0, first[0] - CONTEXT_BEFORE);
    end = Math.min(length, start + MAX_PREVIEW_LENGTH);
    start = Math.max(0, end - MAX_PREVIEW_LENGTH);
    // Never split a surrogate pair at either edge.
    const startCode = text.charCodeAt(start);
    if (start > 0 && startCode >= 0xdc00 && startCode <= 0xdfff) start++;
    const endCode = text.charCodeAt(end - 1);
    if (end < length && endCode >= 0xd800 && endCode <= 0xdbff) end--;
  }
  const clippedStart = start > 0;
  while (start < first[0] && isBlank(text.charCodeAt(start))) start++;
  const lastEnd = sorted.reduce((max, range) => Math.max(max, range[1]), first[1]);
  let clippedEnd = end < length;
  while (end > Math.max(start, lastEnd) && isBlank(text.charCodeAt(end - 1))) end--;
  if (clippedEnd && /^[ \t]*$/.test(text.slice(end))) clippedEnd = false;

  let lineText = "";
  let cursor = start;
  const mapped: MatchRange[] = [];
  for (const [rangeStart, rangeEnd] of sorted) {
    if (mapped.length >= MAX_RANGES_PER_LINE) break;
    const from = Math.max(rangeStart, cursor, start);
    const to = Math.min(rangeEnd, end);
    if (from > end || to < from || rangeEnd < start) continue;
    lineText += sanitizeForDisplay(text.slice(cursor, from));
    const mappedStart = lineText.length;
    lineText += sanitizeForDisplay(text.slice(from, to));
    mapped.push({ start: mappedStart, end: lineText.length });
    cursor = to;
  }
  lineText += sanitizeForDisplay(text.slice(cursor, end));
  return {
    path,
    line,
    column: first[0] + 1,
    lineText,
    ranges: mapped,
    lineTextStart: start,
    clippedStart,
    clippedEnd,
  };
}

/** UTF-8 byte length of the code point starting at `index` (and how many code units it spans). */
function utf8Width(text: string, index: number): { bytes: number; units: number } {
  const code = text.charCodeAt(index);
  if (code < 0x80) return { bytes: 1, units: 1 };
  if (code < 0x800) return { bytes: 2, units: 1 };
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
    const next = text.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return { bytes: 4, units: 2 };
  }
  return { bytes: 3, units: 1 };
}

/** Maps UTF-8 byte offsets in `text` (as encoded by `TextEncoder`) to UTF-16 offsets. */
export function utf8ToUtf16Offsets(text: string, byteOffsets: readonly number[]): number[] {
  const order = byteOffsets.map((offset, index) => ({ offset, index })).sort((a, b) => a.offset - b.offset);
  const out = new Array<number>(byteOffsets.length);
  let bytes = 0;
  let units = 0;
  let next = 0;
  while (next < order.length) {
    const target = order[next] as { offset: number; index: number };
    if (target.offset <= bytes || units >= text.length) {
      out[target.index] = units;
      next++;
      continue;
    }
    const width = utf8Width(text, units);
    bytes += width.bytes;
    units += width.units;
  }
  return out;
}
