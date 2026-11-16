/**
 * Cell-accurate text layout for the settings views: they compute row heights themselves (a
 * setting's description wraps), so wrapping must agree with what the terminal draws.
 */
import { displayWidth, sanitizeForDisplay, truncateEnd } from "@/core/text";

/**
 * Word-wraps `text` into lines of at most `width` cells. Words longer than a line are cut;
 * with `maxLines`, the last kept line ends with an ellipsis when text was dropped.
 */
export function wrapText(text: string, width: number, maxLines = Number.POSITIVE_INFINITY): string[] {
  const clean = sanitizeForDisplay(text).replace(/\s+/g, " ").trim();
  if (width <= 0 || clean === "") return [];
  const lines: string[] = [];
  let current = "";
  for (const word of clean.split(" ")) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (displayWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current !== "") lines.push(current);
    current = displayWidth(word) <= width ? word : truncateEnd(word, width);
  }
  if (current !== "") lines.push(current);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1] ?? "";
  kept[maxLines - 1] = truncateEnd(`${last} …`, width);
  return kept;
}

/** Pads with spaces to exactly `width` cells, truncating with an ellipsis when longer. */
export function fitWidth(text: string, width: number): string {
  if (width <= 0) return "";
  const shown = displayWidth(text) > width ? truncateEnd(text, width) : text;
  return shown + " ".repeat(Math.max(0, width - displayWidth(shown)));
}

/** Width of the right-hand control column for a content width. */
export function controlColumnWidth(width: number): number {
  return Math.max(18, Math.min(30, Math.round(width * 0.36)));
}
