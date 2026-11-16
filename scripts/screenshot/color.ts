/** Resolves frame colors into the opaque colors a terminal would actually show. */
import type { FrameColor } from "./types";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export const DEFAULT_FOREGROUND = "#d4d6dd";
export const DEFAULT_BACKGROUND = "#15161a";

export interface ColorContext {
  foreground: Rgb;
  background: Rgb;
  /** Resolved ANSI 0..15 colors, or null to use the snapshot stored in each indexed color. */
  palette: readonly Rgb[] | null;
}

const clampByte = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

export function parseHex(hex: string): Rgb {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match?.[1]) throw new TypeError(`Expected a #rgb or #rrggbb color, got "${hex}"`);
  const digits =
    match[1].length === 3
      ? match[1]
          .split("")
          .map((d) => d + d)
          .join("")
      : match[1];
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16),
  };
}

export function toHex(color: Rgb): string {
  const part = (v: number) => clampByte(v).toString(16).padStart(2, "0");
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`;
}

export function sameRgb(a: Rgb, b: Rgb): boolean {
  return (
    clampByte(a.r) === clampByte(b.r) &&
    clampByte(a.g) === clampByte(b.g) &&
    clampByte(a.b) === clampByte(b.b)
  );
}

/** Linear mix: `amount` 0 gives `a`, 1 gives `b`. */
export function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
  };
}

export function createColorContext(options: {
  foreground?: string;
  background?: string;
  palette?: readonly string[];
}): ColorContext {
  if (options.palette && options.palette.length !== 16) {
    throw new TypeError(`palette must have exactly 16 colors, got ${options.palette.length}`);
  }
  return {
    foreground: parseHex(options.foreground ?? DEFAULT_FOREGROUND),
    background: parseHex(options.background ?? DEFAULT_BACKGROUND),
    palette: options.palette ? options.palette.map(parseHex) : null,
  };
}

function snapshot(color: FrameColor): Rgb {
  return { r: color.r * 255, g: color.g * 255, b: color.b * 255 };
}

/**
 * The opaque color for one channel of a cell. Translucent colors are composited over `under`
 * (the terminal cannot show alpha, and OpenTUI has already blended overlays into the buffer).
 */
export function resolveColor(color: FrameColor, role: "fg" | "bg", under: Rgb, ctx: ColorContext): Rgb {
  if (color.intent === "default") return role === "fg" ? ctx.foreground : ctx.background;
  if (color.intent === "indexed") {
    const slot = color.slot ?? -1;
    const fromPalette = ctx.palette && slot >= 0 && slot < 16 ? ctx.palette[slot] : undefined;
    return fromPalette ?? snapshot(color);
  }
  if (color.a <= 0) return under;
  if (color.a >= 1) return snapshot(color);
  return mix(under, snapshot(color), color.a);
}
