/**
 * Row models for a virtualized diff view, built from a `ParsedDiff`.
 *
 * Rows are flat arrays, so "the rows currently visible" is a slice. Keys are derived from hunk
 * and line indices, so they stay stable when the same patch is rebuilt. Split rows and word
 * highlights are computed lazily: a 20 000-line diff shown in unified mode never pays for them,
 * and word diffs are only computed for rows that are actually drawn.
 */
import type { DiffHunk, DiffLine, DiffLineKind, ParsedDiff } from "./patch-parser";
import { type WordDiff, type WordDiffOptions, type WordRange, wordDiff } from "./word-diff";

export interface DiffLineRef {
  readonly hunk: number;
  readonly line: number;
}

export interface UnifiedHunkRow {
  readonly kind: "hunk";
  readonly key: string;
  readonly hunkIndex: number;
  /** The `@@ ... @@ section` line. */
  readonly header: string;
  readonly section: string;
}

export interface UnifiedLineRow {
  readonly kind: "line";
  readonly key: string;
  readonly hunkIndex: number;
  readonly lineIndex: number;
  readonly type: DiffLineKind;
  readonly sign: "+" | "-" | " ";
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly text: string;
  readonly noNewlineAtEnd: boolean;
  /** Index into `DiffModel.changes` for added/removed lines; `null` for context. */
  readonly changeIndex: number | null;
}

export type UnifiedRow = UnifiedHunkRow | UnifiedLineRow;

export interface SplitCell {
  readonly lineIndex: number;
  readonly type: DiffLineKind;
  /** Line number on this side (old for the left cell, new for the right cell). */
  readonly lineNumber: number;
  readonly text: string;
  readonly noNewlineAtEnd: boolean;
}

export interface SplitHunkRow {
  readonly kind: "hunk";
  readonly key: string;
  readonly hunkIndex: number;
  readonly header: string;
  readonly section: string;
}

export interface SplitPairRow {
  readonly kind: "pair";
  readonly key: string;
  readonly hunkIndex: number;
  /** Old side; `null` is a filler (an added line with no removed partner). */
  readonly left: SplitCell | null;
  /** New side; `null` is a filler (a removed line with no added partner). */
  readonly right: SplitCell | null;
  readonly changeIndex: number | null;
}

export type SplitRow = SplitHunkRow | SplitPairRow;

/** A run of consecutive added/removed lines inside one hunk. */
export interface DiffChange {
  readonly index: number;
  readonly hunkIndex: number;
  /** Index of the change's first line in its hunk. */
  readonly firstLine: number;
  readonly removed: number;
  readonly added: number;
  /** First unified row of the change, or -1 when it lies beyond the row cap. */
  readonly unifiedRow: number;
}

export interface DiffHunkInfo {
  readonly index: number;
  /** Unified row of the hunk header, or -1 when it lies beyond the row cap. */
  readonly unifiedRow: number;
  readonly added: number;
  readonly removed: number;
  /** Indices into `changes`. */
  readonly changes: readonly number[];
}

export type DiffViewKind = "unified" | "split";

export interface DiffModelOptions {
  /** Row cap for each view. Default 100 000. */
  maxRows?: number;
  wordDiff?: WordDiffOptions;
}

export const DEFAULT_MAX_DIFF_ROWS = 100_000;

const SIGNS: Readonly<Record<DiffLineKind, "+" | "-" | " ">> = { added: "+", removed: "-", context: " " };

function lowerBound(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] ?? 0) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class DiffModel {
  readonly diff: ParsedDiff;
  readonly unified: readonly UnifiedRow[];
  readonly hunks: readonly DiffHunkInfo[];
  readonly changes: readonly DiffChange[];
  readonly added: number;
  readonly removed: number;
  /** The unified view hit the row cap; later hunks are not represented. */
  readonly truncated: boolean;
  readonly maxRows: number;

  /** Per hunk: index of the paired line on the other side of a change, or -1. */
  private readonly partners: Int32Array[];
  /** Per hunk: change index for each line, or -1 for context. */
  private readonly changeOfLine: Int32Array[];
  private readonly wordOptions: WordDiffOptions | undefined;
  private readonly wordCache = new Map<string, WordDiff | null>();
  private splitCache: {
    rows: SplitRow[];
    truncated: boolean;
    hunkRows: number[];
    changeRows: number[];
  } | null = null;
  private readonly unifiedChangeRows: number[];

  constructor(diff: ParsedDiff, options: DiffModelOptions = {}) {
    this.diff = diff;
    this.maxRows = options.maxRows ?? DEFAULT_MAX_DIFF_ROWS;
    this.wordOptions = options.wordDiff;
    this.added = diff.added;
    this.removed = diff.removed;

    const changes: DiffChange[] = [];
    const hunkInfos: {
      index: number;
      unifiedRow: number;
      added: number;
      removed: number;
      changes: number[];
    }[] = [];
    this.partners = [];
    this.changeOfLine = [];
    for (const hunk of diff.hunks) {
      const partner = new Int32Array(hunk.lines.length).fill(-1);
      const changeOf = new Int32Array(hunk.lines.length).fill(-1);
      const info = { index: hunk.index, unifiedRow: -1, added: 0, removed: 0, changes: [] as number[] };
      let i = 0;
      while (i < hunk.lines.length) {
        if (hunk.lines[i]?.kind === "context") {
          i++;
          continue;
        }
        const first = i;
        const removedLines: number[] = [];
        const addedLines: number[] = [];
        while (i < hunk.lines.length && hunk.lines[i]?.kind !== "context") {
          if (hunk.lines[i]?.kind === "removed") removedLines.push(i);
          else addedLines.push(i);
          changeOf[i] = changes.length;
          i++;
        }
        // Pair removed and added lines in order; extra lines on either side stay unpaired.
        for (let k = 0; k < Math.min(removedLines.length, addedLines.length); k++) {
          const r = removedLines[k] ?? -1;
          const a = addedLines[k] ?? -1;
          partner[r] = a;
          partner[a] = r;
        }
        info.changes.push(changes.length);
        info.added += addedLines.length;
        info.removed += removedLines.length;
        changes.push({
          index: changes.length,
          hunkIndex: hunk.index,
          firstLine: first,
          removed: removedLines.length,
          added: addedLines.length,
          unifiedRow: -1,
        });
      }
      this.partners.push(partner);
      this.changeOfLine.push(changeOf);
      hunkInfos.push(info);
    }

    // Unified rows, with the row cap.
    const rows: UnifiedRow[] = [];
    const changeRows = new Array<number>(changes.length).fill(-1);
    let truncated = false;
    outer: for (const hunk of diff.hunks) {
      if (rows.length >= this.maxRows) {
        truncated = true;
        break;
      }
      const info = hunkInfos[hunk.index];
      if (info) info.unifiedRow = rows.length;
      rows.push({
        kind: "hunk",
        key: `h${hunk.index}`,
        hunkIndex: hunk.index,
        header: hunk.header,
        section: hunk.section,
      });
      const changeOf = this.changeOfLine[hunk.index];
      for (let l = 0; l < hunk.lines.length; l++) {
        if (rows.length >= this.maxRows) {
          truncated = true;
          break outer;
        }
        const line = hunk.lines[l] as DiffLine;
        const change = changeOf?.[l] ?? -1;
        if (change !== -1 && changeRows[change] === -1) changeRows[change] = rows.length;
        rows.push({
          kind: "line",
          key: `h${hunk.index}:${l}`,
          hunkIndex: hunk.index,
          lineIndex: l,
          type: line.kind,
          sign: SIGNS[line.kind],
          oldLine: line.oldLine,
          newLine: line.newLine,
          text: line.text,
          noNewlineAtEnd: line.noNewlineAtEnd,
          changeIndex: change === -1 ? null : change,
        });
      }
    }
    this.unified = rows;
    this.truncated = truncated;
    this.changes = changes.map((change, index) => ({ ...change, unifiedRow: changeRows[index] ?? -1 }));
    this.hunks = hunkInfos;
    this.unifiedChangeRows = this.changes.map((change) => change.unifiedRow).filter((row) => row !== -1);
  }

  /** The parsed line a reference points at. */
  line(ref: DiffLineRef): DiffLine | undefined {
    return this.diff.hunks[ref.hunk]?.lines[ref.line];
  }

  /** The paired line on the other side of a change (removed ↔ added), if any. */
  partner(ref: DiffLineRef): DiffLineRef | null {
    const index = this.partners[ref.hunk]?.[ref.line] ?? -1;
    return index === -1 ? null : { hunk: ref.hunk, line: index };
  }

  /**
   * Word-level changed ranges for an added or removed line, computed on first request and
   * cached. `null` when the line has no partner or highlighting was skipped (see `word-diff.ts`).
   */
  wordRanges(ref: DiffLineRef): readonly WordRange[] | null {
    const line = this.line(ref);
    const partnerRef = this.partner(ref);
    if (!line || !partnerRef || line.kind === "context") return null;
    const removedRef = line.kind === "removed" ? ref : partnerRef;
    const key = `${removedRef.hunk}:${removedRef.line}`;
    let result = this.wordCache.get(key);
    if (result === undefined) {
      const removedLine = this.line(removedRef);
      const addedLine = this.line(line.kind === "removed" ? partnerRef : ref);
      result = removedLine && addedLine ? wordDiff(removedLine.text, addedLine.text, this.wordOptions) : null;
      this.wordCache.set(key, result);
    }
    if (!result) return null;
    return line.kind === "removed" ? result.old : result.new;
  }

  /** Split rows, built on first access. */
  get split(): readonly SplitRow[] {
    return this.buildSplit().rows;
  }

  /** The split view hit the row cap. */
  get splitTruncated(): boolean {
    return this.buildSplit().truncated;
  }

  /** Row index of each hunk header in a view (-1 beyond the row cap). */
  hunkRows(view: DiffViewKind): readonly number[] {
    return view === "unified" ? this.hunks.map((hunk) => hunk.unifiedRow) : this.buildSplit().hunkRows;
  }

  /** First row index of each change in a view (-1 beyond the row cap). */
  changeRows(view: DiffViewKind): readonly number[] {
    return view === "unified"
      ? this.changes.map((change) => change.unifiedRow)
      : this.buildSplit().changeRows;
  }

  /** Row of the next change strictly after `fromRow`, or `null`. Pass -1 to get the first change. */
  nextChange(fromRow: number, view: DiffViewKind = "unified"): number | null {
    const rows = this.sortedChangeRows(view);
    const index = lowerBound(rows, fromRow + 1);
    return rows[index] ?? null;
  }

  /** Row of the previous change strictly before `fromRow`, or `null`. */
  previousChange(fromRow: number, view: DiffViewKind = "unified"): number | null {
    const rows = this.sortedChangeRows(view);
    const index = lowerBound(rows, fromRow) - 1;
    return index >= 0 ? (rows[index] ?? null) : null;
  }

  /** Index of the hunk a row belongs to, or `null` for an out-of-range row. */
  hunkAt(row: number, view: DiffViewKind = "unified"): number | null {
    const target = view === "unified" ? this.unified[row] : this.split[row];
    return target ? target.hunkIndex : null;
  }

  private sortedChangeRows(view: DiffViewKind): readonly number[] {
    return view === "unified"
      ? this.unifiedChangeRows
      : this.buildSplit().changeRows.filter((row) => row !== -1);
  }

  private buildSplit(): { rows: SplitRow[]; truncated: boolean; hunkRows: number[]; changeRows: number[] } {
    if (this.splitCache) return this.splitCache;
    const rows: SplitRow[] = [];
    const hunkRows = new Array<number>(this.hunks.length).fill(-1);
    const changeRows = new Array<number>(this.changes.length).fill(-1);
    let truncated = false;
    const cell = (hunk: DiffHunk, index: number, side: "old" | "new"): SplitCell | null => {
      const line = hunk.lines[index];
      if (!line) return null;
      const lineNumber = side === "old" ? line.oldLine : line.newLine;
      if (lineNumber === null) return null;
      return {
        lineIndex: index,
        type: line.kind,
        lineNumber,
        text: line.text,
        noNewlineAtEnd: line.noNewlineAtEnd,
      };
    };

    outer: for (const hunk of this.diff.hunks) {
      if (rows.length >= this.maxRows) {
        truncated = true;
        break;
      }
      hunkRows[hunk.index] = rows.length;
      rows.push({
        kind: "hunk",
        key: `h${hunk.index}`,
        hunkIndex: hunk.index,
        header: hunk.header,
        section: hunk.section,
      });
      const lines = hunk.lines;
      let i = 0;
      while (i < lines.length) {
        if (rows.length >= this.maxRows) {
          truncated = true;
          break outer;
        }
        const line = lines[i];
        if (line?.kind === "context") {
          rows.push({
            kind: "pair",
            key: `h${hunk.index}:${i}:${i}`,
            hunkIndex: hunk.index,
            left: cell(hunk, i, "old"),
            right: cell(hunk, i, "new"),
            changeIndex: null,
          });
          i++;
          continue;
        }
        const removedLines: number[] = [];
        const addedLines: number[] = [];
        const change = this.changeOfLine[hunk.index]?.[i] ?? -1;
        while (i < lines.length && lines[i]?.kind !== "context") {
          if (lines[i]?.kind === "removed") removedLines.push(i);
          else addedLines.push(i);
          i++;
        }
        if (change !== -1) changeRows[change] = rows.length;
        const count = Math.max(removedLines.length, addedLines.length);
        for (let k = 0; k < count; k++) {
          if (rows.length >= this.maxRows) {
            truncated = true;
            break outer;
          }
          const left = removedLines[k];
          const right = addedLines[k];
          rows.push({
            kind: "pair",
            key: `h${hunk.index}:${left ?? "-"}:${right ?? "-"}`,
            hunkIndex: hunk.index,
            left: left === undefined ? null : cell(hunk, left, "old"),
            right: right === undefined ? null : cell(hunk, right, "new"),
            changeIndex: change === -1 ? null : change,
          });
        }
      }
    }
    this.splitCache = { rows, truncated, hunkRows, changeRows };
    return this.splitCache;
  }
}
