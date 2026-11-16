/**
 * Highlight helpers shared by search results and Quick Open: match positions to ranges, and
 * display sanitization that keeps ranges aligned (sanitizing can change lengths: a tab
 * becomes two spaces).
 */
import type { MatchRange } from "@/adapters/search";
import { sanitizeForDisplay } from "@/core/text";

/**
 * Sorted match positions (UTF-16 indices into a larger string) that fall inside
 * `[offset, offset + length)`, as merged ranges relative to `offset`.
 */
export function positionsToRanges(
  positions: readonly number[],
  offset: number,
  length: number,
): MatchRange[] {
  const out: MatchRange[] = [];
  for (const position of positions) {
    const local = position - offset;
    if (local < 0 || local >= length) continue;
    const last = out[out.length - 1];
    if (last && last.end === local) out[out.length - 1] = { start: last.start, end: local + 1 };
    else out.push({ start: local, end: local + 1 });
  }
  return out;
}

/** `sanitizeForDisplay(text)` with `ranges` remapped onto the sanitized text. */
export function sanitizeWithRanges(
  text: string,
  ranges: readonly MatchRange[],
): { text: string; ranges: MatchRange[] } {
  if (/^[\x20-\x7e]*$/.test(text)) return { text, ranges: [...ranges] };
  let out = "";
  let cursor = 0;
  const mapped: MatchRange[] = [];
  for (const range of ranges) {
    const start = Math.max(range.start, cursor);
    const end = Math.min(Math.max(range.end, start), text.length);
    out += sanitizeForDisplay(text.slice(cursor, start));
    const mappedStart = out.length;
    out += sanitizeForDisplay(text.slice(start, end));
    mapped.push({ start: mappedStart, end: out.length });
    cursor = end;
  }
  out += sanitizeForDisplay(text.slice(cursor));
  return { text: out, ranges: mapped };
}

const numberFormat = new Intl.NumberFormat("en-US");

export function formatCount(value: number): string {
  return numberFormat.format(value);
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : plural}`;
}
