/**
 * Capability degradation: maps a theme onto the 256- or 16-color palette.
 *
 * Nearest-color mapping alone is not enough. Subtle tints (selection, diff lines) and dark
 * surfaces tend to land on the same palette entry as the canvas, and text can land on its own
 * background. Two guards run after mapping:
 *
 * 1. Backgrounds that must stay visible (selection, find match) are moved to the nearest
 *    entry that differs from the canvas and still carries their text.
 * 2. Each important foreground is checked against every background it is drawn on and, if
 *    it collapsed or lost contrast, moved to the nearest entry that satisfies all of them.
 *
 * In 256-color mode the minimums are real WCAG ratios, because entries 16-255 have fixed
 * values. In 16-color mode the actual colors come from the user's terminal theme, so the
 * guarantee is "never the same entry" plus a sanity ratio against xterm's nominal values.
 */
import {
  ANSI_16,
  type AnsiFamily,
  colorDistance,
  contrastRatio,
  nearestAnsi16,
  nearestXterm256,
  XTERM_256,
} from "./color";
import type { ColorMode } from "./ids";
import type { Theme } from "./theme";
import {
  getToken,
  mapTokens,
  TERMINAL_ANSI_ORDER,
  type ThemeTokens,
  type TokenPath,
  tokenPaths,
} from "./tokens";

export interface ResolvedTheme {
  readonly theme: Theme;
  readonly colorMode: ColorMode;
  /** Same shape as the theme's tokens; values are the palette colors actually used. */
  readonly tokens: ThemeTokens;
  /** Palette index per token (xterm-256 or ANSI 0-15). Empty in truecolor mode. */
  readonly indexes: Readonly<Partial<Record<TokenPath, number>>>;
}

type Strength = "text" | "ui" | "distinct";

export interface DegradationPair {
  fg: TokenPath;
  bg: TokenPath;
  strength: Strength;
}

const MINIMUMS: Record<Exclude<ColorMode, "truecolor">, Record<Strength, number>> = {
  "256": { text: 4.5, ui: 3, distinct: 1.2 },
  "16": { text: 3, ui: 2, distinct: 1.2 },
};

function fgPairs(
  fgs: readonly TokenPath[],
  bgs: readonly TokenPath[],
  strength: Strength,
): DegradationPair[] {
  return fgs.flatMap((fg) => bgs.map((bg) => ({ fg, bg, strength })));
}

const SYNTAX: TokenPath[] = [
  "syntax.keyword",
  "syntax.string",
  "syntax.number",
  "syntax.comment",
  "syntax.function",
  "syntax.type",
  "syntax.variable",
  "syntax.parameter",
  "syntax.constant",
  "syntax.property",
  "syntax.operator",
  "syntax.punctuation",
  "syntax.tag",
  "syntax.attribute",
  "syntax.heading",
  "syntax.link",
  "syntax.regexp",
];

const STATUS_AND_GIT: TokenPath[] = [
  "accent.primary",
  "status.success",
  "status.warning",
  "status.error",
  "status.info",
  "git.added",
  "git.modified",
  "git.deleted",
  "git.renamed",
  "git.untracked",
  "git.conflicted",
  "git.ignored",
];

/** Foreground/background pairs that must never collapse after degradation. */
export const DEGRADATION_PAIRS: readonly DegradationPair[] = [
  ...fgPairs(
    ["fg.default"],
    ["bg.base", "bg.surface", "bg.raised", "bg.overlay", "bg.inset", "state.selectedInactiveBg"],
    "text",
  ),
  ...fgPairs(["fg.muted"], ["bg.base", "bg.surface", "bg.overlay"], "text"),
  ...fgPairs(["fg.subtle"], ["bg.base", "bg.surface"], "ui"),
  ...fgPairs(["state.selectedFg"], ["state.selectedBg"], "text"),
  ...fgPairs(["fg.default"], ["editor.selectionBg", "editor.findMatchActiveBg"], "text"),
  ...fgPairs(["fg.onAccent"], ["accent.primary"], "text"),
  ...fgPairs(["badge.fg"], ["badge.bg"], "text"),
  ...fgPairs(["diff.addedFg"], ["diff.addedLineBg"], "ui"),
  ...fgPairs(["diff.removedFg"], ["diff.removedLineBg"], "ui"),
  ...fgPairs(["editor.lineNumberActive"], ["editor.bg"], "text"),
  ...fgPairs(["editor.lineNumber"], ["editor.bg"], "distinct"),
  ...fgPairs(SYNTAX, ["editor.bg"], "ui"),
  ...fgPairs(STATUS_AND_GIT, ["bg.base", "bg.surface"], "ui"),
  ...fgPairs(["border.focus", "state.focusRing"], ["bg.base", "bg.surface"], "ui"),
  ...fgPairs(["border.default", "border.subtle"], ["bg.base", "bg.surface"], "distinct"),
  ...fgPairs(["terminal.fg"], ["terminal.bg"], "text"),
];

interface DistinctBackground {
  bg: TokenPath;
  /** Must differ from these after mapping. */
  from: readonly TokenPath[];
  /** Text drawn on `bg`, which must stay readable on the replacement. */
  text: TokenPath;
}

/**
 * Backgrounds that carry meaning and must not vanish into the canvas. Diff line tints are
 * only protected in 256-color mode: with 16 colors, diffs rely on their +/- foregrounds.
 */
const DISTINCT_BACKGROUNDS: Record<Exclude<ColorMode, "truecolor">, readonly DistinctBackground[]> = {
  "256": [
    { bg: "state.selectedBg", from: ["bg.base", "bg.surface"], text: "state.selectedFg" },
    { bg: "editor.selectionBg", from: ["editor.bg"], text: "fg.default" },
    { bg: "editor.findMatchActiveBg", from: ["editor.bg"], text: "fg.default" },
    { bg: "diff.addedLineBg", from: ["editor.bg"], text: "fg.default" },
    { bg: "diff.removedLineBg", from: ["editor.bg"], text: "fg.default" },
  ],
  "16": [
    { bg: "state.selectedBg", from: ["bg.base", "bg.surface"], text: "state.selectedFg" },
    { bg: "editor.selectionBg", from: ["editor.bg"], text: "fg.default" },
    { bg: "editor.findMatchActiveBg", from: ["editor.bg"], text: "fg.default" },
  ],
};

/**
 * In 16-color mode these tokens use the conventional ANSI family instead of the nearest hue:
 * the user's terminal palette defines the actual colors, and a theme's yellow-green "green"
 * (Gruvbox) must not become the same yellow as "modified".
 */
const SEMANTIC_FAMILIES: Partial<Record<TokenPath, AnsiFamily>> = {
  "status.success": "green",
  "status.warning": "yellow",
  "status.error": "red",
  "git.added": "green",
  "git.modified": "yellow",
  "git.deleted": "red",
  "diff.addedFg": "green",
  "diff.removedFg": "red",
};

const HUE_BEARING_GROUPS = new Set(["accent", "status", "git", "syntax", "terminal"]);
const NEUTRAL_ROLES = new Set<TokenPath>([
  "syntax.comment",
  "syntax.punctuation",
  "syntax.variable",
  "syntax.operator",
  "terminal.fg",
  "terminal.bg",
  "terminal.selectionBg",
  "git.ignored",
]);

const HUE_BEARING_TOKENS = new Set<TokenPath>([
  "diff.addedFg",
  "diff.removedFg",
  "border.focus",
  "state.focusRing",
  "badge.bg",
]);

/**
 * Tokens whose hue means something, so a desaturated value must not degrade to grey. All
 * other tokens are text or surfaces and stay on the grey ramp in 16-color mode, where the
 * terminal's own black and white are the most faithful stand-ins.
 */
function isHueBearing(path: TokenPath): boolean {
  if (HUE_BEARING_TOKENS.has(path)) return true;
  const group = path.slice(0, path.indexOf("."));
  return HUE_BEARING_GROUPS.has(group) && !NEUTRAL_ROLES.has(path);
}

/** The canvas family: surfaces that stand for the terminal's own background. */
const CANVAS_SURFACES = new Set<TokenPath>([
  "bg.canvas",
  "bg.base",
  "bg.surface",
  "bg.inset",
  "editor.bg",
  "terminal.bg",
]);

/**
 * In 16-color mode the user's terminal defines the real colors, so a theme's canvas has to
 * become the terminal's background entry and its body text the terminal's foreground
 * entries, whatever their exact lightness. Matching by lightness alone sends a mid-dark
 * base such as Nord's #2e3440 to ANSI 8 (a mid grey in most terminals) and a mid-light
 * body text such as Solarized's base1 to ANSI 8 as well.
 */
function anchoredAnsi(theme: Theme, path: TokenPath, hex: string): number | undefined {
  const dark = theme.appearance === "dark";
  if (CANVAS_SURFACES.has(path)) return dark ? 0 : 15;
  if (path === "fg.default" || path === "terminal.fg") {
    return nearestAnsi16(hex, { role: "neutral", exclude: new Set(dark ? [0, 8] : [7, 15]) });
  }
  return undefined;
}

function paletteOf(mode: Exclude<ColorMode, "truecolor">): {
  hexOf: (i: number) => string;
  indexes: number[];
} {
  if (mode === "256") {
    return { hexOf: (i) => XTERM_256[i] ?? "#000000", indexes: [...Array(240).keys()].map((i) => i + 16) };
  }
  return { hexOf: (i) => ANSI_16[i] ?? "#000000", indexes: [...Array(16).keys()] };
}

/** Nearest candidate to `source` that satisfies `accept`; otherwise the one maximizing `score`. */
function pickIndex(
  source: string,
  candidates: readonly number[],
  hexOf: (i: number) => string,
  accept: (i: number) => boolean,
  score: (i: number) => number,
): number {
  let best: number | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const i of candidates) {
    if (!accept(i)) continue;
    const d = colorDistance(source, hexOf(i));
    if (d < bestDistance) {
      best = i;
      bestDistance = d;
    }
  }
  if (best !== undefined) return best;
  let fallback = candidates[0] ?? 0;
  let fallbackScore = Number.NEGATIVE_INFINITY;
  for (const i of candidates) {
    const s = score(i);
    if (s > fallbackScore) {
      fallback = i;
      fallbackScore = s;
    }
  }
  return fallback;
}

/**
 * Maps every token of `theme` into the palette of `colorMode`, then applies the guards
 * described above. Truecolor returns the theme's tokens unchanged.
 */
export function resolveTheme(theme: Theme, colorMode: ColorMode): ResolvedTheme {
  if (colorMode === "truecolor") return { theme, colorMode, tokens: theme.tokens, indexes: {} };

  const { hexOf, indexes: candidates } = paletteOf(colorMode);
  const mins = MINIMUMS[colorMode];
  const index = new Map<TokenPath, number>();
  const terminalIndex = new Map<string, number>(
    TERMINAL_ANSI_ORDER.map((name, i) => [`terminal.${name}`, i]),
  );

  for (const path of tokenPaths()) {
    const hex = getToken(theme.tokens, path);
    const fixedAnsi =
      colorMode === "16" ? (terminalIndex.get(path) ?? anchoredAnsi(theme, path, hex)) : undefined;
    index.set(
      path,
      fixedAnsi ??
        (colorMode === "256"
          ? nearestXterm256(hex)
          : nearestAnsi16(hex, {
              role: isHueBearing(path) ? "hue" : "neutral",
              family: SEMANTIC_FAMILIES[path],
            })),
    );
  }
  const at = (path: TokenPath): number => index.get(path) ?? 0;
  const ratio = (a: number, b: number): number => contrastRatio(hexOf(a), hexOf(b));

  // Protected backgrounds adapt to their text, never the other way around: recoloring
  // fg.default to suit a selection tint would change every label on screen.
  for (const rule of DISTINCT_BACKGROUNDS[colorMode]) {
    const textIndex = at(rule.text);
    const collapsed = rule.from.some((other) => at(other) === at(rule.bg));
    if (!collapsed && ratio(at(rule.bg), textIndex) >= mins.text) continue;
    const avoid = new Set(rule.from.map(at));
    index.set(
      rule.bg,
      pickIndex(
        getToken(theme.tokens, rule.bg),
        candidates,
        hexOf,
        (i) => !avoid.has(i) && i !== textIndex && ratio(i, textIndex) >= mins.text,
        (i) => (avoid.has(i) || i === textIndex ? -1 : ratio(i, textIndex)),
      ),
    );
  }

  // Group by foreground so a replacement satisfies every background the token is drawn on.
  const byFg = new Map<TokenPath, DegradationPair[]>();
  for (const pair of DEGRADATION_PAIRS) {
    const list = byFg.get(pair.fg) ?? [];
    list.push(pair);
    byFg.set(pair.fg, list);
  }
  // A token can be a foreground in one pair and a background in another (accent.primary),
  // so repeat until nothing moves. Three passes are plenty for the pair graph above.
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const [fg, list] of byFg) {
      const ok = (i: number) => list.every((p) => i !== at(p.bg) && ratio(i, at(p.bg)) >= mins[p.strength]);
      if (ok(at(fg))) continue;
      const next = pickIndex(getToken(theme.tokens, fg), candidates, hexOf, ok, (i) =>
        Math.min(...list.map((p) => (i === at(p.bg) ? 0 : ratio(i, at(p.bg)) / mins[p.strength]))),
      );
      if (next !== at(fg)) {
        index.set(fg, next);
        moved = true;
      }
    }
    if (!moved) break;
  }

  const tokens = mapTokens(theme.tokens, (_, path) => hexOf(at(path)));
  return {
    theme,
    colorMode,
    tokens,
    indexes: Object.fromEntries(index) as Partial<Record<TokenPath, number>>,
  };
}
