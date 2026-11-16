/**
 * Turns document-level highlight ranges into per-line tokens for views that draw their own rows
 * (the diff view). Pure and synchronous.
 *
 * Overlaps are resolved exactly like OpenTUI's `treeSitterToTextChunks`, so a row drawn from
 * these tokens matches the same text inside `<code>`: only groups that map to a syntax token
 * take part, the group with more dot-separated segments wins, and on a tie the range that comes
 * later (after a stable sort by start offset) wins.
 */
import { groupSpecificity, syntaxGroupToToken } from "./style-groups";
import type { HighlightRange, LineToken } from "./types";

interface Candidate {
  readonly start: number;
  readonly end: number;
  readonly group: string;
  readonly specificity: number;
  /** Rank after the stable sort by start; the later range wins a specificity tie. */
  readonly order: number;
}

function beats(a: Candidate, b: Candidate): boolean {
  return a.specificity !== b.specificity ? a.specificity > b.specificity : a.order > b.order;
}

/**
 * Returns one array per line (`content.split("\n").length` entries). Each array is sorted,
 * non-overlapping, and merges adjacent spans of the same group. Line terminators (`\n` and the
 * `\r` of `\r\n`) never belong to a token. Invalid ranges are ignored rather than thrown on,
 * because ranges may come from a worker or a fallback tokenizer.
 */
export function tokenizeLines(content: string, ranges: readonly HighlightRange[]): LineToken[][] {
  const lineStarts = [0];
  for (let i = content.indexOf("\n"); i !== -1; i = content.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const lines: LineToken[][] = lineStarts.map(() => []);
  const length = content.length;

  const candidates: Candidate[] = [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  for (const range of sorted) {
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) continue;
    const start = Math.max(0, Math.trunc(range.start));
    const end = Math.min(length, Math.trunc(range.end));
    if (start >= end || syntaxGroupToToken(range.group) === null) continue;
    candidates.push({
      start,
      end,
      group: range.group,
      specificity: groupSpecificity(range.group),
      order: candidates.length,
    });
  }
  if (candidates.length === 0) return lines;

  // Starts are already in order; ends need their own order for the sweep.
  const byEnd = candidates
    .map((_, i) => i)
    .sort((a, b) => (candidates[a]?.end ?? 0) - (candidates[b]?.end ?? 0));

  let line = 0;
  const emit = (from: number, to: number, group: string): void => {
    let a = from;
    while (a < to) {
      while (line + 1 < lineStarts.length && (lineStarts[line + 1] ?? Infinity) <= a) line++;
      const lineStart = lineStarts[line] ?? 0;
      const nextStart = lineStarts[line + 1] ?? length + 1;
      // Visible end of the line: drop "\n" and the "\r" of "\r\n".
      let visibleEnd = nextStart - 1;
      if (visibleEnd > lineStart && content.charCodeAt(visibleEnd - 1) === 13) visibleEnd--;
      visibleEnd = Math.min(visibleEnd, length);
      const b = Math.min(to, visibleEnd);
      if (b > a) {
        const tokens = lines[line];
        const last = tokens?.[tokens.length - 1];
        const start = a - lineStart;
        if (last && last.end === start && last.group === group) {
          tokens?.splice(tokens.length - 1, 1, { start: last.start, end: b - lineStart, group });
        } else {
          tokens?.push({ start, end: b - lineStart, group });
        }
      }
      a = nextStart;
    }
  };

  const active: Candidate[] = [];
  let winner: Candidate | undefined;
  const recompute = (): void => {
    winner = undefined;
    for (const candidate of active) if (!winner || beats(candidate, winner)) winner = candidate;
  };

  let nextStart = 0;
  let nextEnd = 0;
  let position = 0;
  while (nextStart < candidates.length || nextEnd < byEnd.length) {
    const startCandidate = candidates[nextStart];
    const endCandidate = candidates[byEnd[nextEnd] ?? -1];
    // Ends are processed before starts at the same offset, like OpenTUI's boundary sort.
    const takeEnd =
      endCandidate !== undefined &&
      (startCandidate === undefined || endCandidate.end <= startCandidate.start);
    const offset = takeEnd ? (endCandidate?.end ?? 0) : (startCandidate?.start ?? 0);
    if (offset > position && winner) emit(position, offset, winner.group);
    position = Math.max(position, offset);
    if (takeEnd && endCandidate) {
      const at = active.indexOf(endCandidate);
      if (at !== -1) active.splice(at, 1);
      nextEnd++;
      if (winner === endCandidate) recompute();
    } else if (startCandidate) {
      active.push(startCandidate);
      nextStart++;
      if (!winner || beats(startCandidate, winner)) winner = startCandidate;
    }
  }
  return lines;
}
