/**
 * Structural types for a captured terminal frame.
 *
 * They mirror OpenTUI's `CapturedFrame` (from `captureSpans()`), so a live frame can be passed
 * directly, but they only require plain data: a frame loaded from JSON works too, because
 * `RGBA` exposes `r`, `g`, `b`, `a`, `intent` and `slot` as getters.
 */

export type ColorIntent = "rgb" | "indexed" | "default";

export interface FrameColor {
  /** Channels are floats from 0 to 1, as in OpenTUI's `RGBA`. */
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
  /** Absent means `rgb`. */
  readonly intent?: ColorIntent;
  /** Palette index (0..255) when `intent` is `indexed`. */
  readonly slot?: number;
}

export interface FrameSpan {
  readonly text: string;
  readonly fg: FrameColor;
  readonly bg: FrameColor;
  /** OpenTUI `TextAttributes` bit set. */
  readonly attributes: number;
  /** Number of terminal cells the span covers (a wide glyph counts 2). */
  readonly width: number;
}

export interface FrameLine {
  readonly spans: readonly FrameSpan[];
}

export interface Frame {
  readonly cols: number;
  readonly rows: number;
  readonly cursor?: readonly [number, number];
  readonly lines: readonly FrameLine[];
}

/** OpenTUI `TextAttributes` bits (duplicated so this library has no runtime dependency on OpenTUI). */
export const Attr = {
  BOLD: 1,
  DIM: 2,
  ITALIC: 4,
  UNDERLINE: 8,
  BLINK: 16,
  INVERSE: 32,
  HIDDEN: 64,
  STRIKETHROUGH: 128,
} as const;

export interface WindowFrameOptions {
  /** Text centered in the title bar. */
  title?: string;
  /** Soft drop shadow around the window (adds a transparent margin). Default true. */
  shadow?: boolean;
}

export interface ScreenshotOptions {
  /** CSS font-family list. */
  fontFamily?: string;
  /** Font size in CSS pixels. Default 15. */
  fontSize?: number;
  /** Cell height as a multiple of the font size, used when `cellHeight` is not given. Default 1.2. */
  lineHeight?: number;
  /** Cell width in CSS pixels. Default `round(fontSize * 0.6)`, the advance of most monospace fonts. */
  cellWidth?: number;
  /** Cell height in CSS pixels. Default `round(fontSize * lineHeight)`. */
  cellHeight?: number;
  /** Space between the cell grid and the image edge (or the window frame), in CSS pixels. Default 0. */
  padding?: number;
  /** Default foreground: used for `default` intent colors. */
  foreground?: string;
  /** Default background: used for transparent cells and `default` intent colors. */
  background?: string;
  /** The 16 ANSI colors (`#rrggbb`) used for `indexed` colors 0..15. Without it the RGB snapshot stored in the
   * color is used. Indexes 16..255 always use the snapshot (the standard xterm cube and gray ramp). */
  palette?: readonly string[];
  /** Draw box-drawing, block and powerline glyphs as vector shapes, the way modern terminals do, so lines
   * join exactly across cells whatever the font. Default true. */
  vectorGlyphs?: boolean;
  /** Wrap the grid in a window frame with rounded corners and a title bar, for README images. Default off. */
  window?: boolean | WindowFrameOptions;
  /** Document title (`<title>`), defaults to the window title. */
  title?: string;
}
