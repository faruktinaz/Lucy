/**
 * Splits captured spans back into terminal cells.
 *
 * OpenTUI's `captureSpans()` concatenates the cell characters of a span and drops the empty
 * continuation cell that follows a wide glyph, so cell columns have to be recovered from the
 * grapheme widths. The span's `width` stays authoritative: positions never drift past it.
 */
import type { Frame, FrameSpan } from "./types";

export interface Cell {
  /** One grapheme cluster. */
  text: string;
  /** Column of the first cell it occupies. */
  col: number;
  /** 1 or 2. */
  width: number;
}

export interface SpanCells {
  span: FrameSpan;
  /** First column of the span. */
  col: number;
  cells: Cell[];
}

let segmenter: Intl.Segmenter | null = null;

export function graphemes(text: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const out: string[] = [];
  for (const part of segmenter.segment(text)) out.push(part.segment);
  return out;
}

/** Cell width of one grapheme, matching OpenTUI's `unicode-wide` method for the cases that matter here. */
export function graphemeWidth(grapheme: string): 1 | 2 {
  return Bun.stringWidth(grapheme) >= 2 ? 2 : 1;
}

/** Splits one span (starting at `col`) into cells, never exceeding `span.width` columns. */
export function spanCells(span: FrameSpan, col: number): Cell[] {
  const cells: Cell[] = [];
  const end = col + span.width;
  let x = col;
  for (const text of graphemes(span.text)) {
    if (x >= end) break;
    const width = Math.min(graphemeWidth(text), end - x);
    cells.push({ text, col: x, width });
    x += width;
  }
  return cells;
}

/** All rows of a frame as spans with recovered cell positions. */
export function frameCells(frame: Frame): SpanCells[][] {
  return frame.lines.map((line) => {
    let col = 0;
    return line.spans.map((span) => {
      const result = { span, col, cells: spanCells(span, col) };
      col += span.width;
      return result;
    });
  });
}

/** The frame as plain text, one line per row (wide glyphs are not padded, as in `captureCharFrame()`). */
export function frameToText(frame: Frame): string {
  return frame.lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n");
}

/**
 * Cell position of the first occurrence of `needle` in the frame, or null. Columns account
 * for wide glyphs earlier in the row, so the result can be clicked.
 */
export function findTextInFrame(frame: Frame, needle: string): { x: number; y: number } | null {
  if (needle.length === 0) return null;
  const rows = frameCells(frame);
  for (let y = 0; y < rows.length; y++) {
    let text = "";
    const columnAt: number[] = [];
    for (const span of rows[y] ?? []) {
      for (const cell of span.cells) {
        for (let i = 0; i < cell.text.length; i++) columnAt.push(cell.col);
        text += cell.text;
      }
    }
    const index = text.indexOf(needle);
    if (index !== -1) return { x: columnAt[index] ?? 0, y };
  }
  return null;
}
