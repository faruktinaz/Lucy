/**
 * Vector shapes for box-drawing (U+2500–U+257F), block elements (U+2580–U+259F) and the
 * powerline separators (U+E0B0–U+E0B7).
 *
 * Modern terminals (Ghostty, kitty, WezTerm) draw these themselves instead of using the font,
 * because font glyphs rarely fill the cell exactly: borders would show gaps or overlaps at
 * any line height other than the font's own. Drawing them from cell geometry keeps every
 * border straight and continuous. Coordinates are local to the cell and snapped to whole
 * units so lines render crisply at integer scale factors.
 */

export type Shape =
  | { kind: "rect"; x: number; y: number; w: number; h: number; opacity?: number }
  | { kind: "fill"; d: string }
  | { kind: "stroke"; d: string; width: number };

export interface CellBox {
  /** Cell width and height in layout units. */
  w: number;
  h: number;
  /** Thickness of a light line; heavy lines are twice as thick. */
  light: number;
}

type Weight = 0 | 1 | 2 | 3; // none, light, heavy, double
interface Arms {
  up: Weight;
  right: Weight;
  down: Weight;
  left: Weight;
}

/**
 * Arms of U+2500..U+257F as "urdl" weight digits. Entries that are not plain arm
 * combinations (dashes, arcs, diagonals) are "-" and handled separately.
 */
const ARM_TABLE = (
  "0101 0202 1010 2020 - - - - - - - - 0110 0210 0120 0220 " +
  "0011 0012 0021 0022 1100 1200 2100 2200 1001 1002 2001 2002 1110 1210 2110 1120 " +
  "2120 2210 1220 2220 1011 1012 2011 1021 2021 2012 1022 2022 0111 0112 0211 0212 " +
  "0121 0122 0221 0222 1101 1102 1201 1202 2101 2102 2201 2202 1111 1112 1211 1212 " +
  "2111 1121 2121 2112 2211 1122 1221 2212 1222 2122 2221 2222 - - - - " +
  "0303 3030 0310 0130 0330 0013 0031 0033 1300 3100 3300 1003 3001 3003 1310 3130 " +
  "3330 1013 3031 3033 0313 0131 0333 1303 3101 3303 1313 3131 3333 - - - " +
  "- - - - 0001 1000 0100 0010 0002 2000 0200 0020 0201 1020 0102 2010"
).split(" ");

/** Dashed lines: [horizontal?, weight, dash count]. */
const DASHES: Record<number, [boolean, 1 | 2, number]> = {
  9476: [true, 1, 3],
  9477: [true, 2, 3],
  9478: [false, 1, 3],
  9479: [false, 2, 3],
  9480: [true, 1, 4],
  9481: [true, 2, 4],
  9482: [false, 1, 4],
  9483: [false, 2, 4],
  9548: [true, 1, 2],
  9549: [true, 2, 2],
  9550: [false, 1, 2],
  9551: [false, 2, 2],
};

function armsOf(code: number): Arms | null {
  const entry = ARM_TABLE[code - 0x2500];
  if (!entry || entry === "-") return null;
  const digit = (i: number) => Number(entry[i]) as Weight;
  return { up: digit(0), right: digit(1), down: digit(2), left: digit(3) };
}

const thickness = (box: CellBox, weight: Weight) => (weight === 2 ? box.light * 2 : box.light);
/** Start of a centered line of thickness `t` across a cell dimension `size`. */
const centered = (size: number, t: number) => Math.floor((size - t) / 2);

function drawArms(arms: Arms, box: CellBox): Shape[] {
  const { w, h } = box;
  const t = box.light;
  const shapes: Shape[] = [];
  const rect = (x: number, y: number, rw: number, rh: number) => {
    if (rw > 0 && rh > 0) shapes.push({ kind: "rect", x, y, w: rw, h: rh });
  };

  // Double lines: two parallel lines of light thickness with a gap between them.
  const gap = Math.max(t, Math.round(w / 6));
  const vl = Math.round((w - (2 * t + gap)) / 2); // left vertical line x
  const vr = vl + t + gap; // right vertical line x
  const ht = Math.round((h - (2 * t + gap)) / 2); // top horizontal line y
  const hb = ht + t + gap; // bottom horizontal line y
  const cl = centered(w, t); // light vertical line x
  const ch = centered(h, t); // light horizontal line y

  const dbl = (weight: Weight) => weight === 3;
  const single = (weight: Weight) => weight === 1 || weight === 2;

  // Double horizontal lines, one half at a time.
  const horizontalHalf = (lineY: number, side: "left" | "right", near: Weight, far: Weight) => {
    const other = side === "left" ? arms.right : arms.left;
    let inner: number; // the end that points to the cell center
    if (dbl(near)) inner = side === "left" ? vl + t : vr;
    else if (dbl(other)) inner = w / 2;
    else if (dbl(far)) inner = side === "left" ? vr + t : vl;
    else if (single(arms.up) || single(arms.down)) inner = side === "left" ? cl + t : cl;
    else inner = w / 2;
    if (side === "left") rect(0, lineY, inner, t);
    else rect(inner, lineY, w - inner, t);
  };
  const verticalHalf = (lineX: number, side: "top" | "bottom", near: Weight, far: Weight) => {
    const other = side === "top" ? arms.down : arms.up;
    let inner: number;
    if (dbl(near)) inner = side === "top" ? ht + t : hb;
    else if (dbl(other)) inner = h / 2;
    else if (dbl(far)) inner = side === "top" ? hb + t : ht;
    else if (single(arms.left) || single(arms.right)) inner = side === "top" ? ch + t : ch;
    else inner = h / 2;
    if (side === "top") rect(lineX, 0, t, inner);
    else rect(lineX, inner, t, h - inner);
  };
  if (dbl(arms.left)) {
    horizontalHalf(ht, "left", arms.up, arms.down);
    horizontalHalf(hb, "left", arms.down, arms.up);
  }
  if (dbl(arms.right)) {
    horizontalHalf(ht, "right", arms.up, arms.down);
    horizontalHalf(hb, "right", arms.down, arms.up);
  }
  if (dbl(arms.up)) {
    verticalHalf(vl, "top", arms.left, arms.right);
    verticalHalf(vr, "top", arms.right, arms.left);
  }
  if (dbl(arms.down)) {
    verticalHalf(vl, "bottom", arms.left, arms.right);
    verticalHalf(vr, "bottom", arms.right, arms.left);
  }

  // Light and heavy arms run from the edge to just past the center, so corners are filled.
  const maxWeight = (a: Weight, b: Weight): Weight =>
    single(a) && single(b) ? (a > b ? a : b) : single(a) ? a : b;
  const hWeight = maxWeight(arms.left, arms.right);
  const vWeight = maxWeight(arms.up, arms.down);
  const hDouble = dbl(arms.left) || dbl(arms.right);
  const vDouble = dbl(arms.up) || dbl(arms.down);
  const bothH = dbl(arms.left) && dbl(arms.right);
  const bothV = dbl(arms.up) && dbl(arms.down);

  if (single(arms.up) || single(arms.down)) {
    // A vertical stroke; where it meets horizontal arms it stops on (or crosses) them.
    for (const side of ["up", "down"] as const) {
      const weight = arms[side];
      if (!single(weight)) continue;
      const tv = thickness(box, weight);
      const x = centered(w, tv);
      let inner: number;
      if (hDouble) {
        if (side === "up") inner = bothH ? ht + t : hb + t;
        else inner = bothH ? hb : ht;
      } else if (single(hWeight)) {
        const th = thickness(box, hWeight);
        inner = side === "up" ? centered(h, th) + th : centered(h, th);
      } else {
        inner = side === "up" ? centered(h, tv) + tv : centered(h, tv);
      }
      if (side === "up") rect(x, 0, tv, inner);
      else rect(x, inner, tv, h - inner);
    }
  }
  if (single(arms.left) || single(arms.right)) {
    for (const side of ["left", "right"] as const) {
      const weight = arms[side];
      if (!single(weight)) continue;
      const th = thickness(box, weight);
      const y = centered(h, th);
      let inner: number;
      if (vDouble) {
        if (side === "left") inner = bothV ? vl + t : vr + t;
        else inner = bothV ? vr : vl;
      } else if (single(vWeight)) {
        const tv = thickness(box, vWeight);
        inner = side === "left" ? centered(w, tv) + tv : centered(w, tv);
      } else {
        inner = side === "left" ? centered(w, th) + th : centered(w, th);
      }
      if (side === "left") rect(0, y, inner, th);
      else rect(inner, y, w - inner, th);
    }
  }
  return shapes;
}

function drawDashes(horizontal: boolean, weight: 1 | 2, count: number, box: CellBox): Shape[] {
  const t = thickness(box, weight);
  const length = horizontal ? box.w : box.h;
  const segment = length / count;
  const dash = Math.max(1, Math.round(segment * 0.6));
  const shapes: Shape[] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.round(i * segment + (segment - dash) / 2);
    shapes.push(
      horizontal
        ? { kind: "rect", x: start, y: centered(box.h, t), w: dash, h: t }
        : { kind: "rect", x: centered(box.w, t), y: start, w: t, h: dash },
    );
  }
  return shapes;
}

function drawArc(code: number, box: CellBox): Shape[] {
  const { w, h, light: t } = box;
  const cx = centered(w, t) + t / 2;
  const cy = centered(h, t) + t / 2;
  const r = Math.min(w, h) / 2;
  const paths: Record<number, string> = {
    9581: `M${w} ${cy}H${cx + r}A${r} ${r} 0 0 0 ${cx} ${cy + r}V${h}`, // ╭
    9582: `M0 ${cy}H${cx - r}A${r} ${r} 0 0 1 ${cx} ${cy + r}V${h}`, // ╮
    9583: `M0 ${cy}H${cx - r}A${r} ${r} 0 0 0 ${cx} ${cy - r}V0`, // ╯
    9584: `M${w} ${cy}H${cx + r}A${r} ${r} 0 0 1 ${cx} ${cy - r}V0`, // ╰
  };
  const d = paths[code];
  return d ? [{ kind: "stroke", d, width: t }] : [];
}

function drawDiagonal(code: number, box: CellBox): Shape[] {
  const { w, h, light: t } = box;
  const rising = `M0 ${h}L${w} 0`;
  const falling = `M0 0L${w} ${h}`;
  if (code === 0x2571) return [{ kind: "stroke", d: rising, width: t }];
  if (code === 0x2572) return [{ kind: "stroke", d: falling, width: t }];
  return [{ kind: "stroke", d: `${rising}${falling}`, width: t }];
}

function drawBlock(code: number, box: CellBox): Shape[] {
  const { w, h } = box;
  const rect = (x: number, y: number, rw: number, rh: number, opacity?: number): Shape =>
    opacity === undefined
      ? { kind: "rect", x, y, w: rw, h: rh }
      : { kind: "rect", x, y, w: rw, h: rh, opacity };
  const eighthH = (n: number) => Math.round((h * n) / 8);
  const eighthW = (n: number) => Math.round((w * n) / 8);
  const halfW = Math.round(w / 2);
  const halfH = Math.round(h / 2);
  const UL = rect(0, 0, halfW, halfH);
  const UR = rect(halfW, 0, w - halfW, halfH);
  const LL = rect(0, halfH, halfW, h - halfH);
  const LR = rect(halfW, halfH, w - halfW, h - halfH);
  if (code === 0x2580) return [rect(0, 0, w, halfH)];
  if (code >= 0x2581 && code <= 0x2588) {
    const n = code - 0x2580; // lower n eighths
    return [rect(0, h - eighthH(n), w, eighthH(n))];
  }
  if (code >= 0x2589 && code <= 0x258f) {
    const n = 0x2590 - code; // left n eighths
    return [rect(0, 0, eighthW(n), h)];
  }
  switch (code) {
    case 0x2590:
      return [rect(halfW, 0, w - halfW, h)];
    case 0x2591:
      return [rect(0, 0, w, h, 0.25)];
    case 0x2592:
      return [rect(0, 0, w, h, 0.5)];
    case 0x2593:
      return [rect(0, 0, w, h, 0.75)];
    case 0x2594:
      return [rect(0, 0, w, eighthH(1))];
    case 0x2595:
      return [rect(w - eighthW(1), 0, eighthW(1), h)];
    case 0x2596:
      return [LL];
    case 0x2597:
      return [LR];
    case 0x2598:
      return [UL];
    case 0x2599:
      return [UL, LL, LR];
    case 0x259a:
      return [UL, LR];
    case 0x259b:
      return [UL, UR, LL];
    case 0x259c:
      return [UL, UR, LR];
    case 0x259d:
      return [UR];
    case 0x259e:
      return [UR, LL];
    case 0x259f:
      return [UR, LL, LR];
    default:
      return [];
  }
}

function drawPowerline(code: number, box: CellBox): Shape[] {
  const { w, h, light: t } = box;
  const m = h / 2;
  switch (code) {
    case 0xe0b0:
      return [{ kind: "fill", d: `M0 0L${w} ${m}L0 ${h}Z` }];
    case 0xe0b1:
      return [{ kind: "stroke", d: `M0 0L${w} ${m}L0 ${h}`, width: t }];
    case 0xe0b2:
      return [{ kind: "fill", d: `M${w} 0L0 ${m}L${w} ${h}Z` }];
    case 0xe0b3:
      return [{ kind: "stroke", d: `M${w} 0L0 ${m}L${w} ${h}`, width: t }];
    case 0xe0b4:
      return [{ kind: "fill", d: `M0 0A${w} ${m} 0 0 1 0 ${h}Z` }];
    case 0xe0b5:
      return [{ kind: "stroke", d: `M0 0A${w} ${m} 0 0 1 0 ${h}`, width: t }];
    case 0xe0b6:
      return [{ kind: "fill", d: `M${w} 0A${w} ${m} 0 0 0 ${w} ${h}Z` }];
    case 0xe0b7:
      return [{ kind: "stroke", d: `M${w} 0A${w} ${m} 0 0 0 ${w} ${h}`, width: t }];
    default:
      return [];
  }
}

/** True when `grapheme` is drawn as vector shapes rather than with the font. */
export function isVectorGlyph(grapheme: string): boolean {
  if (grapheme.length !== 1) return false;
  const code = grapheme.charCodeAt(0);
  return (code >= 0x2500 && code <= 0x259f) || (code >= 0xe0b0 && code <= 0xe0b7);
}

/** Shapes for a vector glyph in cell-local coordinates, or null when the glyph is not one. */
export function vectorGlyphShapes(grapheme: string, box: CellBox): Shape[] | null {
  if (!isVectorGlyph(grapheme)) return null;
  const code = grapheme.charCodeAt(0);
  if (code >= 0xe0b0) return drawPowerline(code, box);
  if (code >= 0x2580) return drawBlock(code, box);
  const dash = DASHES[code];
  if (dash) return drawDashes(dash[0], dash[1], dash[2], box);
  if (code >= 0x256d && code <= 0x2570) return drawArc(code, box);
  if (code >= 0x2571 && code <= 0x2573) return drawDiagonal(code, box);
  const arms = armsOf(code);
  return arms ? drawArms(arms, box) : null;
}
