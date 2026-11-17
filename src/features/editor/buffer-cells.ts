/**
 * Converts between our positions (UTF-16 offsets, as the syntax service and find report them)
 * and the edit buffer's positions.
 *
 * OpenTUI's edit buffer does not count UTF-16 units: `addHighlight(line, range)` takes display
 * cells relative to the logical line, `addHighlightByCharRange` takes document display cells
 * *excluding* newlines, and `getSelection()` returns document cells counting one per newline
 * (`edit-buffer.d.ts`, `EditBufferRenderable.d.ts`). A tab is a fixed `tabWidth` cells (not a tab
 * stop), wide characters and emoji are two cells, combining marks zero. Passing UTF-16 offsets
 * made every colour drift one cell per line break, plus one per wide glyph or tab.
 */
import { displayWidth } from "@/core/text";

const SIMPLE = /^[\x20-\x7e]*$/;

let segmenter: Intl.Segmenter | undefined;

export class BufferCells {
  readonly lines: readonly string[];
  /** UTF-16 offset where each line starts in the joined text. */
  readonly #starts: number[];
  readonly #tabWidth: number;
  /** Per non-ASCII line: cells before each UTF-16 index (length = line length + 1). */
  readonly #maps = new Map<number, Uint32Array>();

  constructor(text: string, tabWidth: number) {
    this.lines = text.split("\n");
    this.#tabWidth = Math.max(1, Math.floor(tabWidth));
    this.#starts = new Array<number>(this.lines.length);
    let offset = 0;
    for (let i = 0; i < this.lines.length; i++) {
      this.#starts[i] = offset;
      offset += (this.lines[i] as string).length + 1;
    }
  }

  /** The line holding the UTF-16 offset `offset` of the joined text. */
  lineOf(offset: number): number {
    let low = 0;
    let high = this.#starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      if ((this.#starts[mid] as number) <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  #map(line: number): Uint32Array | null {
    const text = this.lines[line] ?? "";
    if (SIMPLE.test(text)) return null;
    let map = this.#maps.get(line);
    if (map) return map;
    map = new Uint32Array(text.length + 1);
    segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let cells = 0;
    for (const { segment, index } of segmenter.segment(text)) {
      // Offsets inside a grapheme (a surrogate pair, a combining mark) belong to its start.
      for (let i = index; i < index + segment.length; i++) map[i] = cells;
      cells += segment === "\t" ? this.#tabWidth : displayWidth(segment);
    }
    map[text.length] = cells;
    this.#maps.set(line, map);
    return map;
  }

  /** Display cells from the start of `line` to the UTF-16 offset `offset` in it. */
  cell(line: number, offset: number): number {
    const text = this.lines[line] ?? "";
    const clamped = Math.max(0, Math.min(offset, text.length));
    const map = this.#map(line);
    return map ? (map[clamped] as number) : clamped;
  }

  /** Width of a whole line in cells. */
  width(line: number): number {
    return this.cell(line, (this.lines[line] ?? "").length);
  }

  /**
   * A UTF-16 range of the whole "\n"-joined text as per-line cell ranges, for
   * `addHighlight(line, …)`. Empty pieces (a range covering only a line break) are dropped.
   */
  ranges(start: number, end: number): { line: number; start: number; end: number }[] {
    const out: { line: number; start: number; end: number }[] = [];
    for (let line = this.lineOf(Math.max(0, start)); line < this.lines.length; line++) {
      const lineStart = this.#starts[line] as number;
      if (lineStart >= end) break;
      const length = (this.lines[line] as string).length;
      const a = this.cell(line, Math.max(0, start - lineStart));
      const b = this.cell(line, Math.min(length, end - lineStart));
      if (b > a) out.push({ line, start: a, end: b });
    }
    return out;
  }

  /** The row holding a document cell offset as `getSelection()` reports it (one cell per newline). */
  rowOfDocumentCell(cell: number): number {
    let remaining = cell;
    for (let line = 0; line < this.lines.length; line++) {
      const width = this.width(line);
      if (remaining <= width) return line;
      remaining -= width + 1;
    }
    return Math.max(0, this.lines.length - 1);
  }

  /** The document cell offset where `line` starts, counting one cell per newline. */
  documentCellOfLineStart(line: number): number {
    let cells = 0;
    for (let i = 0; i < line && i < this.lines.length; i++) cells += this.width(i) + 1;
    return cells;
  }
}
