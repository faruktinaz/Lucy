/**
 * What the code viewer draws for a document, and the mapping between document columns
 * (UTF-16 offsets into a line, as the model and find use them) and screen cells.
 *
 * File content is untrusted. Every line goes through `sanitizeLineForDisplay`, which shows
 * control and bidi characters visibly (ESC as `␛`) without shifting offsets, and expands tabs
 * here because OpenTUI's `<code>` has no tab-width option. Cell positions are computed from the
 * same sanitized text the renderer draws, so highlights land exactly on the glyphs.
 */
import { displayWidth, sanitizeLineForDisplay } from "@/core/text";

/** The `<code>` content for viewer lines: one display line per document line, no trailing newline. */
export function buildDisplayContent(lines: readonly string[], tabWidth: number): string {
  const out = new Array<string>(lines.length);
  for (let i = 0; i < lines.length; i++) out[i] = sanitizeLineForDisplay(lines[i] as string, { tabWidth });
  return out.join("\n");
}

/** Screen cells from the start of `line` to the UTF-16 offset `offset`. */
export function cellColumn(line: string, offset: number, tabWidth: number): number {
  if (offset <= 0) return 0;
  return displayWidth(sanitizeLineForDisplay(line.slice(0, Math.min(offset, line.length)), { tabWidth }));
}

let segmenter: Intl.Segmenter | undefined;

/** UTF-16 offset of the character drawn at screen cell `cell` (clamped to the line end). */
export function offsetAtCell(line: string, cell: number, tabWidth: number): number {
  if (cell <= 0) return 0;
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const stop = Math.max(1, tabWidth);
  let used = 0;
  // Tab stops follow `sanitizeLineForDisplay`, which counts the expanded text in UTF-16 units.
  let expanded = 0;
  for (const { segment, index } of segmenter.segment(line)) {
    const isTab = segment === "\t";
    const units = isTab ? stop - (expanded % stop) : segment.length;
    const width = isTab ? units : displayWidth(sanitizeLineForDisplay(segment));
    if (used + width > cell) return index;
    used += width;
    expanded += units;
  }
  return line.length;
}

/**
 * The graphemes of a display line that lie completely inside the cells `[from, to)`, and the
 * cell where they start. A wide glyph cut by an edge is left out (it cannot be half drawn).
 */
export function sliceCells(display: string, from: number, to: number): { text: string; start: number } {
  if (to <= from) return { text: "", start: from };
  if (/^[\x20-\x7e]*$/.test(display)) {
    const start = Math.max(0, from);
    return { text: display.slice(start, Math.max(start, to)), start };
  }
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let cell = 0;
  let text = "";
  let start = -1;
  for (const { segment } of segmenter.segment(display)) {
    const width = displayWidth(segment);
    if (cell >= to) break;
    if (cell >= from && cell + width <= to) {
      if (start === -1) start = cell;
      text += segment;
    }
    cell += width;
  }
  return { text, start: start === -1 ? from : start };
}

/** 1-based character (code point) column for external editors, from a UTF-16 offset. */
export function characterColumn(line: string, offset: number): number {
  let count = 0;
  for (let i = 0; i < Math.min(offset, line.length); i++) {
    const code = line.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < line.length) i++;
    count++;
  }
  return count + 1;
}
