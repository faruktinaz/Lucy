/**
 * Fits a match preview into a fixed number of cells while keeping the first match visible.
 *
 * A preview line can be hundreds of characters long and its match can sit far to the right
 * (a long import list, minified code). Simply cutting the end would hide the very thing the
 * row is about, so when the first match does not fit, the window slides right and keeps a
 * little context before the match, marking the cut with an ellipsis (VS Code does the same).
 * Widths are terminal cells, measured per grapheme, so CJK, emoji and combining marks never
 * push a row out of alignment.
 */
import type { MatchRange } from "@/adapters/search";
import { displayWidth } from "@/core/text";

export interface PreviewRun {
  readonly text: string;
  readonly match: boolean;
}

export interface PreviewLayout {
  /** Something was cut before the visible text: draw a leading ellipsis. */
  readonly leading: boolean;
  /** Something was cut after it: draw a trailing ellipsis. */
  readonly trailing: boolean;
  readonly runs: readonly PreviewRun[];
}

export const PREVIEW_ELLIPSIS = "…";

interface Cluster {
  readonly text: string;
  /** UTF-16 offset of the cluster in the preview text. */
  readonly start: number;
  readonly width: number;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function clusters(text: string): Cluster[] {
  const out: Cluster[] = [];
  for (const part of segmenter.segment(text)) {
    out.push({ text: part.segment, start: part.index, width: displayWidth(part.segment) });
  }
  return out;
}

function inRanges(offset: number, ranges: readonly MatchRange[]): boolean {
  for (const range of ranges) {
    if (offset >= range.start && offset < range.end) return true;
  }
  return false;
}

/**
 * Lays out `text` (already display-safe) in `width` cells.
 *
 * @param clippedStart the engine already cut the line before `text`
 * @param clippedEnd the engine already cut the line after `text`
 */
export function layoutPreview(
  text: string,
  ranges: readonly MatchRange[],
  width: number,
  clippedStart = false,
  clippedEnd = false,
): PreviewLayout {
  if (width <= 0) return { leading: false, trailing: false, runs: [] };
  const parts = clusters(text);
  const firstMatch = ranges[0];
  let from = 0;
  let leading = clippedStart;

  // Width needed to show everything up to the end of the first match from the start.
  if (firstMatch) {
    const matchFirst = parts.findIndex((part) => part.start + part.text.length > firstMatch.start);
    let matchLast = matchFirst;
    while (matchLast + 1 < parts.length && (parts[matchLast + 1] as Cluster).start < firstMatch.end) {
      matchLast++;
    }
    if (matchFirst !== -1) {
      let upToMatchEnd = leading ? 1 : 0;
      for (let i = 0; i <= matchLast; i++) upToMatchEnd += (parts[i] as Cluster).width;
      // Keep one cell for a trailing ellipsis when more text follows the match.
      const tail = matchLast + 1 < parts.length || clippedEnd ? 1 : 0;
      if (upToMatchEnd + tail > width) {
        let matchWidth = 0;
        for (let i = matchFirst; i <= matchLast; i++) matchWidth += (parts[i] as Cluster).width;
        // Context before the match: about a third of the row, never more than 12 cells.
        const context = Math.max(0, Math.min(12, Math.floor(width / 3), width - 2 - matchWidth));
        from = matchFirst;
        let used = 0;
        while (from > 0 && used + (parts[from - 1] as Cluster).width <= context) {
          from--;
          used += (parts[from] as Cluster).width;
        }
        if (from > 0) leading = true;
      }
    }
  }

  let remaining = 0;
  for (let i = from; i < parts.length; i++) remaining += (parts[i] as Cluster).width;
  let budget = width - (leading ? displayWidth(PREVIEW_ELLIPSIS) : 0);
  let trailing = clippedEnd;
  if (remaining > budget || clippedEnd) {
    budget -= displayWidth(PREVIEW_ELLIPSIS);
    trailing = true;
  }
  if (budget <= 0) return { leading: false, trailing: width > 0, runs: [] };

  const runs: PreviewRun[] = [];
  let used = 0;
  let current = "";
  let currentMatch = false;
  for (let i = from; i < parts.length; i++) {
    const part = parts[i] as Cluster;
    if (used + part.width > budget) {
      trailing = true;
      break;
    }
    used += part.width;
    const match = inRanges(part.start, ranges);
    if (current !== "" && match !== currentMatch) {
      runs.push({ text: current, match: currentMatch });
      current = "";
    }
    currentMatch = match;
    current += part.text;
  }
  if (current !== "") runs.push({ text: current, match: currentMatch });
  return { leading, trailing, runs };
}
