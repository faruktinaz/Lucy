/**
 * Turns one diff line into colored segments: syntax tokens for the foreground, word-level
 * changes for the background, clipped to the horizontally scrolled window.
 *
 * Text goes through `sanitizeLineForDisplay` first: control characters become visible stand-ins
 * of the same length (so token and word offsets stay valid) and tabs expand to 4 columns, with
 * every offset mapped through `lineDisplayOffset`.
 */
import type { RGBA } from "@opentui/core";
import {
  SYNTAX_TOKEN_FALLBACKS,
  type SyntaxTokenName,
  syntaxGroupToToken,
} from "@/adapters/syntax/style-groups";
import type { LineToken } from "@/adapters/syntax/types";
import { lineDisplayOffset, sanitizeLineForDisplay } from "@/core/text";
import type { UiTheme } from "@/ui/theme/ui-theme";
import type { WordRange } from "../model";

export const DIFF_TAB_WIDTH = 4;

export interface Segment {
  readonly text: string;
  readonly fg: RGBA;
  readonly bg: RGBA | undefined;
}

const colorCache = new WeakMap<UiTheme, Map<string, RGBA | null>>();

/** The theme color of a highlight group (with the extended-token fallbacks), or null. */
export function syntaxColor(theme: UiTheme, group: string): RGBA | null {
  let cache = colorCache.get(theme);
  if (!cache) {
    cache = new Map();
    colorCache.set(theme, cache);
  }
  const cached = cache.get(group);
  if (cached !== undefined) return cached;
  const token = syntaxGroupToToken(group);
  let color: RGBA | null = null;
  if (token) {
    const palette = theme.colors.syntax as Record<string, RGBA | undefined>;
    const fallback = (SYNTAX_TOKEN_FALLBACKS as Record<string, SyntaxTokenName | null | undefined>)[token];
    color = palette[token] ?? (fallback ? (palette[fallback] ?? null) : null);
  }
  cache.set(group, color);
  return color;
}

export interface SegmentOptions {
  readonly tokens: readonly LineToken[];
  readonly words: readonly WordRange[] | null;
  /** Text color where no syntax token applies. */
  readonly baseFg: RGBA;
  readonly lineBg: RGBA | undefined;
  readonly wordBg: RGBA | undefined;
  /** First visible display column. */
  readonly scrollLeft: number;
  /** Visible display columns. */
  readonly width: number;
}

/** Display width of a line after tab expansion (for the horizontal scroll range). */
export function displayLength(text: string): number {
  return lineDisplayOffset(text, text.length, DIFF_TAB_WIDTH);
}

export function lineSegments(theme: UiTheme, raw: string, options: SegmentOptions): Segment[] {
  const display = sanitizeLineForDisplay(raw, { tabWidth: DIFF_TAB_WIDTH });
  const map = (offset: number) => lineDisplayOffset(raw, offset, DIFF_TAB_WIDTH);
  const end = display.length;
  const from = Math.max(0, options.scrollLeft);
  const to = Math.min(end, from + Math.max(0, options.width));
  if (to <= from) return [];

  const tokens = options.tokens.map((token) => ({
    start: map(token.start),
    end: map(token.end),
    group: token.group,
  }));
  const words = (options.words ?? []).map((range) => ({ start: map(range.start), end: map(range.end) }));
  const cuts = new Set<number>([from, to]);
  for (const range of [...tokens, ...words]) {
    if (range.start > from && range.start < to) cuts.add(range.start);
    if (range.end > from && range.end < to) cuts.add(range.end);
  }
  const points = [...cuts].sort((a, b) => a - b);

  const segments: Segment[] = [];
  let tokenIndex = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i] ?? 0;
    const b = points[i + 1] ?? 0;
    if (b <= a) continue;
    while (tokenIndex < tokens.length && (tokens[tokenIndex]?.end ?? 0) <= a) tokenIndex++;
    const token = tokens[tokenIndex];
    const tokenColor = token && token.start <= a ? syntaxColor(theme, token.group) : null;
    const inWord = words.some((range) => range.start <= a && range.end > a);
    const fg = tokenColor ?? options.baseFg;
    const bg = inWord ? options.wordBg : options.lineBg;
    const last = segments[segments.length - 1];
    if (last && last.fg === fg && last.bg === bg) {
      segments[segments.length - 1] = { text: last.text + display.slice(a, b), fg, bg };
    } else {
      segments.push({ text: display.slice(a, b), fg, bg });
    }
  }
  return segments;
}
