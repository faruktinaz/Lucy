/**
 * Color math for the design system: parsing, blending, WCAG contrast and mapping to the
 * fixed xterm-256 and basic-16 palettes.
 *
 * Every function takes and returns `#rrggbb` hex strings (lowercase) so theme files stay
 * readable. Blending happens in sRGB space, which is what a terminal does when it draws a
 * tinted cell next to an untinted one, so the result matches what users actually see.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

/** Parses `#rgb` or `#rrggbb` (the `#` is optional). Throws on anything else. */
export function hexToRgb(hex: string): Rgb {
  const match = HEX.exec(hex.trim());
  if (!match?.[1]) throw new Error(`Not a hex color: ${hex}`);
  let digits = match[1];
  if (digits.length === 3) {
    digits = digits
      .split("")
      .map((d) => d + d)
      .join("");
  }
  const value = Number.parseInt(digits, 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

function channel(value: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(value)));
  return clamped.toString(16).padStart(2, "0");
}

export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** Normalizes any accepted hex spelling to lowercase `#rrggbb`. */
export function normalizeHex(hex: string): string {
  return rgbToHex(hexToRgb(hex));
}

/**
 * Composites `fg` over `bg` with the given opacity (0 = only bg, 1 = only fg). This is how
 * tints such as diff and selection backgrounds are derived, so they stay subtle on any base.
 */
export function blend(fg: string, bg: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  const f = hexToRgb(fg);
  const b = hexToRgb(bg);
  return rgbToHex({
    r: f.r * a + b.r * (1 - a),
    g: f.g * a + b.g * (1 - a),
    b: f.b * a + b.b * (1 - a),
  });
}

function linearize(channelValue: number): number {
  const c = channelValue / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG 2.x contrast ratio, from 1 (identical) to 21 (black on white). Order does not matter. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Returns `fg`, moved toward white or black (whichever gains contrast faster against `bg`)
 * just far enough to reach `minRatio`. Used as a guard for user-supplied accents.
 */
export function ensureContrast(fg: string, bg: string, minRatio: number): string {
  if (contrastRatio(fg, bg) >= minRatio) return normalizeHex(fg);
  const towardWhite = contrastRatio("#ffffff", bg) >= contrastRatio("#000000", bg);
  const target = towardWhite ? "#ffffff" : "#000000";
  if (contrastRatio(target, bg) < minRatio) return target;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(blend(target, fg, mid), bg) >= minRatio) hi = mid;
    else lo = mid;
  }
  return blend(target, fg, hi);
}

/** Picks whichever candidate has the highest contrast against `bg`. */
export function bestContrast(bg: string, candidates: readonly string[]): string {
  let best = candidates[0] ?? "#000000";
  let bestRatio = -1;
  for (const candidate of candidates) {
    const ratio = contrastRatio(candidate, bg);
    if (ratio > bestRatio) {
      best = candidate;
      bestRatio = ratio;
    }
  }
  return best;
}

export interface Oklab {
  L: number;
  a: number;
  b: number;
}

/** OKLab: a perceptual space where Euclidean distance tracks visible difference. */
export function toOklab(hex: string): Oklab {
  const { r, g, b } = hexToRgb(hex);
  const lr = linearize(r);
  const lg = linearize(g);
  const lb = linearize(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** Perceptual distance between two colors (0 = identical). */
export function colorDistance(x: string, y: string): number {
  const a = toOklab(x);
  const b = toOklab(y);
  return Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b);
}

/** OKLCh chroma: how colorful a color is (0 for greys). */
export function chroma(hex: string): number {
  const { a, b } = toOklab(hex);
  return Math.hypot(a, b);
}

function hueAngle(hex: string): number {
  const { a, b } = toOklab(hex);
  return Math.atan2(b, a);
}

/**
 * Nominal RGB of the 16 ANSI colors (xterm's defaults). Real terminals substitute their own
 * theme for these, so they are only stand-ins for distance and contrast estimates.
 */
export const ANSI_16: readonly string[] = [
  "#000000",
  "#cd0000",
  "#00cd00",
  "#cdcd00",
  "#0000ee",
  "#cd00cd",
  "#00cdcd",
  "#e5e5e5",
  "#7f7f7f",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#5c5cff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
];

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

function buildXterm256(): string[] {
  const out: string[] = [...ANSI_16];
  for (const r of CUBE_LEVELS) {
    for (const g of CUBE_LEVELS) {
      for (const b of CUBE_LEVELS) out.push(rgbToHex({ r, g, b }));
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    out.push(rgbToHex({ r: v, g: v, b: v }));
  }
  return out;
}

/**
 * The xterm-256 palette. Indices 16-255 (the 6x6x6 cube and the grey ramp) have fixed,
 * standardized values; 0-15 are the nominal ANSI stand-ins above.
 */
export const XTERM_256: readonly string[] = buildXterm256();

/** Nearest stable xterm-256 index (16-255; the themable 0-15 are never chosen). */
export function nearestXterm256(hex: string, exclude: ReadonlySet<number> = new Set()): number {
  let best = 16;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 16; i < 256; i++) {
    if (exclude.has(i)) continue;
    const distance = colorDistance(hex, XTERM_256[i] ?? "#000000");
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

const ANSI_NEUTRALS = [0, 8, 7, 15] as const;

export type AnsiFamily = "red" | "yellow" | "green" | "cyan" | "blue" | "magenta";

/** [normal, bright] ANSI indexes per hue family. */
const ANSI_FAMILY_INDEXES: Readonly<Record<AnsiFamily, readonly [number, number]>> = {
  red: [1, 9],
  yellow: [3, 11],
  green: [2, 10],
  cyan: [6, 14],
  blue: [4, 12],
  magenta: [5, 13],
};
const ANSI_FAMILIES = Object.values(ANSI_FAMILY_INDEXES);
const CHROMA_THRESHOLD = 0.06;
const GREY_THRESHOLD = 0.015;

export interface Ansi16Options {
  exclude?: ReadonlySet<number>;
  /**
   * How to treat the input:
   * - `hue`: the hue carries meaning (status, git, syntax), so match by hue even when the
   *   color is desaturated, as long as it is not an actual grey;
   * - `neutral`: a text or surface color, always matched on the grey ramp by lightness;
   * - `auto` (default): decide by chroma.
   */
  role?: "auto" | "hue" | "neutral";
  /**
   * Force a hue family regardless of the input's hue, for colors whose meaning is a
   * convention (success is green, errors are red). Only normal vs bright is chosen.
   */
  family?: AnsiFamily;
}

function byLightness(hex: string, candidates: readonly number[]): number | undefined {
  const L = toOklab(hex).L;
  let best: number | undefined;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const index of candidates) {
    const delta = Math.abs(L - toOklab(ANSI_16[index] ?? "#000000").L);
    if (delta < bestDelta) {
      best = index;
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * Nearest basic-16 index. Plain distance would turn a pastel blue into grey and lose the
 * meaning of the color, so colors are matched in two steps: the hue family first (red,
 * yellow, green, cyan, blue, magenta), then the normal or bright variant by lightness.
 * Greys are matched by lightness among black, bright black, white and bright white.
 */
export function nearestAnsi16(hex: string, options: Ansi16Options = {}): number {
  const exclude = options.exclude ?? new Set<number>();
  if (options.family) {
    const pick = byLightness(
      hex,
      ANSI_FAMILY_INDEXES[options.family].filter((i) => !exclude.has(i)),
    );
    if (pick !== undefined) return pick;
  }
  const role = options.role ?? "auto";
  const c = chroma(hex);
  const colorful = role === "hue" ? c >= GREY_THRESHOLD : role === "auto" && c >= CHROMA_THRESHOLD;

  if (colorful) {
    const hue = hueAngle(hex);
    const families = [...ANSI_FAMILIES].sort((x, y) => {
      const dx = Math.abs(hue - hueAngle(ANSI_16[x[0]] ?? "#000000"));
      const dy = Math.abs(hue - hueAngle(ANSI_16[y[0]] ?? "#000000"));
      return Math.min(dx, 2 * Math.PI - dx) - Math.min(dy, 2 * Math.PI - dy);
    });
    for (const family of families) {
      const pick = byLightness(
        hex,
        family.filter((i) => !exclude.has(i)),
      );
      if (pick !== undefined) return pick;
    }
  }
  const neutral = byLightness(
    hex,
    ANSI_NEUTRALS.filter((i) => !exclude.has(i)),
  );
  if (neutral !== undefined) return neutral;
  return (
    byLightness(
      hex,
      [...Array(16).keys()].filter((i) => !exclude.has(i)),
    ) ?? 0
  );
}
