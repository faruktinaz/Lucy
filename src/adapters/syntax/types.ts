/** Types shared by the syntax service, the fallback tokenizers and `tokenizeLines`. */

/** A highlighted span of a whole document. Offsets are UTF-16 code units, `end` exclusive. */
export interface HighlightRange {
  readonly start: number;
  readonly end: number;
  /** A Tree-sitter capture name in nvim-treesitter style, e.g. `keyword.return`. */
  readonly group: string;
}

/** A highlighted span of one line. Columns are UTF-16 code units from the line start. */
export interface LineToken {
  readonly start: number;
  readonly end: number;
  readonly group: string;
}
