/**
 * Turns a frame into positioned primitives (background rectangles, glyphs, vector shapes and
 * decoration lines) on an exact cell grid. The SVG and HTML emitters only serialize this model,
 * so both formats share one geometry.
 */
import { isVectorGlyph, type Shape, vectorGlyphShapes } from "./box-drawing";
import { frameCells } from "./cells";
import { type ColorContext, createColorContext, mix, type Rgb, resolveColor, sameRgb, toHex } from "./color";
import { Attr, type Frame, type ScreenshotOptions } from "./types";

export const DEFAULT_FONT_FAMILY = '"JetBrainsMono Nerd Font", "JetBrains Mono", Menlo, monospace';
export const WINDOW_FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif';

/** Distance from the cell's vertical center to the baseline, in ems. Centers the ascent+descent box of
 * JetBrains Mono ((1.02 - 0.30) / 2); most monospace fonts land within a few hundredths of it. */
const BASELINE_FROM_CENTER = 0.36;
/** How far a dim foreground moves toward the background, like most terminals' faint rendering. */
const DIM_AMOUNT = 0.45;

export interface Metrics {
  fontFamily: string;
  fontSize: number;
  cellW: number;
  cellH: number;
  /** Grid origin in image coordinates. */
  gridX: number;
  gridY: number;
  /** Whole image size. */
  width: number;
  height: number;
  /** Thickness of light lines (box drawing, underline). */
  light: number;
}

export interface WindowChrome {
  title: string;
  /** Window rectangle in image coordinates. */
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
  titleBarH: number;
  shadow: boolean;
  titleBarColor: string;
  separatorColor: string;
  borderColor: string;
  dotColor: string;
  titleColor: string;
}

export interface BgRect {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

export interface Glyph {
  text: string;
  /** Center of the glyph's cells (glyphs are centered in their cells, as terminals do). */
  cx: number;
  /** Baseline. */
  y: number;
  /** Image-space left edge and width of the cells the glyph occupies. */
  x: number;
  w: number;
  /** Row and column of the first cell. */
  row: number;
  col: number;
  cells: 1 | 2;
  color: string;
  bold: boolean;
  italic: boolean;
  /** One BMP code point and one cell: may share a <text> element with neighbors. */
  simple: boolean;
}

export interface VectorGlyph {
  x: number;
  y: number;
  color: string;
  shapes: Shape[];
}

export interface Layout {
  metrics: Metrics;
  background: string;
  foreground: string;
  window: WindowChrome | null;
  backgrounds: BgRect[];
  glyphs: Glyph[];
  vectors: VectorGlyph[];
  decorations: BgRect[];
  title: string;
}

function isPrivateUse(code: number): boolean {
  return (code >= 0xe000 && code <= 0xf8ff) || code >= 0xf0000;
}

function luminance(color: Rgb): number {
  return (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
}

function computeMetrics(frame: Frame, options: ScreenshotOptions, chrome: boolean, shadow: boolean): Metrics {
  const fontSize = options.fontSize ?? 15;
  const cellW = options.cellWidth ?? Math.round(fontSize * 0.6);
  const cellH = options.cellHeight ?? Math.round(fontSize * (options.lineHeight ?? 1.2));
  if (!(fontSize > 0 && cellW > 0 && cellH > 0))
    throw new RangeError("Font size and cell size must be positive");
  const padding = options.padding ?? (chrome ? Math.round(cellH * 0.75) : 0);
  const margin = chrome && shadow ? Math.round(fontSize * 3) : 0;
  const titleBarH = chrome ? Math.round(fontSize * 2.2) : 0;
  return {
    fontFamily: options.fontFamily ?? DEFAULT_FONT_FAMILY,
    fontSize,
    cellW,
    cellH,
    gridX: margin + padding,
    gridY: margin + titleBarH + padding,
    width: 2 * margin + 2 * padding + frame.cols * cellW,
    height: 2 * margin + titleBarH + 2 * padding + frame.rows * cellH,
    light: Math.max(1, Math.round(fontSize / 14)),
  };
}

export function layoutFrame(frame: Frame, options: ScreenshotOptions = {}): Layout {
  const ctx: ColorContext = createColorContext(options);
  const windowOptions = options.window === true ? {} : options.window || null;
  const chrome = windowOptions !== null;
  const shadow = chrome && windowOptions.shadow !== false;
  const metrics = computeMetrics(frame, options, chrome, shadow);
  const { cellW, cellH, gridX, gridY, fontSize } = metrics;
  const vectorGlyphs = options.vectorGlyphs ?? true;
  const background = toHex(ctx.background);
  const title = options.title ?? windowOptions?.title ?? "";

  let window: WindowChrome | null = null;
  if (windowOptions) {
    const margin = shadow ? Math.round(fontSize * 3) : 0;
    const dark = luminance(ctx.background) < 0.5;
    window = {
      title: windowOptions.title ?? "",
      x: margin,
      y: margin,
      w: metrics.width - 2 * margin,
      h: metrics.height - 2 * margin,
      radius: Math.round(fontSize * 0.7),
      titleBarH: Math.round(fontSize * 2.2),
      shadow,
      titleBarColor: toHex(mix(ctx.background, ctx.foreground, dark ? 0.045 : 0.03)),
      separatorColor: toHex(
        mix(ctx.background, dark ? { r: 0, g: 0, b: 0 } : ctx.foreground, dark ? 0.35 : 0.1),
      ),
      borderColor: dark ? "rgba(255,255,255,0.09)" : "rgba(0,0,0,0.14)",
      dotColor: toHex(mix(ctx.background, ctx.foreground, 0.2)),
      titleColor: toHex(mix(ctx.background, ctx.foreground, 0.62)),
    };
  }

  const backgrounds: BgRect[] = [];
  const glyphs: Glyph[] = [];
  const vectors: VectorGlyph[] = [];
  const decorations: BgRect[] = [];
  const box = { w: cellW, h: cellH, light: metrics.light };
  const baselineOffset = Math.round((cellH / 2 + fontSize * BASELINE_FROM_CENTER) * 100) / 100;
  const underlineY = Math.round(baselineOffset + fontSize * 0.12);
  const strikeY = Math.round(baselineOffset - fontSize * 0.3);

  frameCells(frame).forEach((row, rowIndex) => {
    const top = gridY + rowIndex * cellH;
    let previous: BgRect | null = null;
    for (const { span, col, cells } of row) {
      const attrs = span.attributes;
      let bg = resolveColor(span.bg, "bg", ctx.background, ctx);
      let fg = resolveColor(span.fg, "fg", bg, ctx);
      // OpenTUI writes SGR 7 with these colors, so a terminal swaps them; do the same.
      if (attrs & Attr.INVERSE) [fg, bg] = [bg, fg];
      if (attrs & Attr.DIM) fg = mix(fg, bg, DIM_AMOUNT);
      const left = gridX + col * cellW;
      const width = span.width * cellW;

      if (!sameRgb(bg, ctx.background) && width > 0) {
        const color = toHex(bg);
        if (previous && previous.color === color && previous.x + previous.w === left) previous.w += width;
        else {
          previous = { x: left, y: top, w: width, h: cellH, color };
          backgrounds.push(previous);
        }
      } else {
        previous = null;
      }
      if (attrs & Attr.HIDDEN) continue;

      const color = toHex(fg);
      const bold = (attrs & Attr.BOLD) !== 0;
      const italic = (attrs & Attr.ITALIC) !== 0;
      for (const cell of cells) {
        if (cell.text.trim() === "") continue;
        const x = gridX + cell.col * cellW;
        if (vectorGlyphs && isVectorGlyph(cell.text)) {
          const shapes = vectorGlyphShapes(cell.text, box);
          if (shapes && shapes.length > 0) vectors.push({ x, y: top, color, shapes });
          continue;
        }
        const code = cell.text.codePointAt(0) ?? 0;
        glyphs.push({
          text: cell.text,
          cx: x + (cell.width * cellW) / 2,
          y: top + baselineOffset,
          x,
          w: cell.width * cellW,
          row: rowIndex,
          col: cell.col,
          cells: cell.width === 2 ? 2 : 1,
          color,
          bold,
          italic,
          simple: cell.width === 1 && cell.text.length === 1 && !isPrivateUse(code),
        });
      }
      if (attrs & Attr.UNDERLINE) {
        decorations.push({ x: left, y: top + underlineY, w: width, h: metrics.light, color });
      }
      if (attrs & Attr.STRIKETHROUGH) {
        decorations.push({ x: left, y: top + strikeY, w: width, h: metrics.light, color });
      }
    }
  });

  return {
    metrics,
    background,
    foreground: toHex(ctx.foreground),
    window,
    backgrounds: mergeVertically(backgrounds),
    glyphs,
    vectors,
    decorations,
    title,
  };
}

/** Joins identical rectangles stacked in consecutive rows (panels), so fewer seams and elements remain. */
function mergeVertically(rects: BgRect[]): BgRect[] {
  const open = new Map<string, BgRect>();
  const out: BgRect[] = [];
  for (const rect of rects) {
    const key = `${rect.x}:${rect.w}:${rect.color}`;
    const above = open.get(key);
    if (above && above.y + above.h === rect.y) {
      above.h += rect.h;
      continue;
    }
    open.set(key, rect);
    out.push(rect);
  }
  return out;
}
