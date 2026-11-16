/**
 * Theme definition and accent handling.
 *
 * A theme is a `build(accent)` function rather than a static table so that changing the
 * accent recomputes everything that depends on it (focus, selection tints, badge, on-accent
 * text) with the theme's own formulas. `withAccent` then runs contrast guards, because a
 * user-supplied hex can be anything.
 */
import { blend, contrastRatio, ensureContrast, isHexColor, normalizeHex } from "./color";
import { type AccentName, isAccentName, type ThemeId } from "./ids";
import type { ThemeTokens } from "./tokens";

export type ContrastLevel = "AA" | "AAA";

export interface ThemeSpec {
  id: ThemeId;
  name: string;
  appearance: "dark" | "light";
  /** WCAG level targeted for body text: AA (4.5:1) or AAA (7:1). */
  contrastLevel: ContrastLevel;
  /** Every accent name mapped to a color of this theme's palette. */
  accents: Readonly<Record<AccentName, string>>;
  defaultAccent: AccentName;
  /** Builds the complete token set for an accent color (already contrast-guarded). */
  build(accent: string): ThemeTokens;
}

export interface Theme extends ThemeSpec {
  /** The accent color currently applied. */
  readonly accent: string;
  readonly tokens: ThemeTokens;
}

/** `ui.accent` setting value: the theme default, a named accent, or `#rrggbb`. */
export type AccentSetting = "default" | AccentName | (string & {});

/** Minimum ratios the guards enforce, by contrast level. */
export function contrastTargets(level: ContrastLevel): { text: number; ui: number } {
  return level === "AAA" ? { text: 7, ui: 4.5 } : { text: 4.5, ui: 3 };
}

/** Resolves an accent setting to a hex color for this theme. Unknown values fall back to the default. */
export function resolveAccent(theme: ThemeSpec, accent: AccentSetting): string {
  if (isAccentName(accent)) return theme.accents[accent];
  if (isHexColor(accent)) return normalizeHex(accent);
  return theme.accents[theme.defaultAccent];
}

/** Moves `bg` toward `base` until `fg` reaches `min` on it, keeping as much tint as possible. */
function guardTint(fg: string, bg: string, base: string, min: number): string {
  if (contrastRatio(fg, bg) >= min) return bg;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(fg, blend(base, bg, mid)) >= min) hi = mid;
    else lo = mid;
  }
  return blend(base, bg, hi);
}

function guardOnColor(bg: string, preferred: string, alternatives: readonly string[], min: number): string {
  if (contrastRatio(preferred, bg) >= min) return preferred;
  for (const candidate of alternatives) {
    if (contrastRatio(candidate, bg) >= min) return candidate;
  }
  return contrastRatio("#000000", bg) >= contrastRatio("#ffffff", bg) ? "#000000" : "#ffffff";
}

function applyAccent(spec: ThemeSpec, requested: string): Theme {
  const targets = contrastTargets(spec.contrastLevel);
  // The canvas does not depend on the accent, so one probe build tells us what to guard against.
  const probe = spec.build(requested);
  let accent = ensureContrast(requested, probe.bg.base, targets.ui);
  accent = ensureContrast(accent, probe.bg.surface, targets.ui);
  const built = spec.build(accent);

  const selectedBg = guardTint(built.state.selectedFg, built.state.selectedBg, built.bg.base, targets.text);
  const selectionBg = guardTint(built.fg.default, built.editor.selectionBg, built.editor.bg, targets.text);
  const darkText = built.bg.inset;
  const lightText = built.fg.default;
  const onAccent = guardOnColor(built.accent.primary, built.fg.onAccent, [darkText, lightText], targets.text);
  const badgeFg = guardOnColor(built.badge.bg, built.badge.fg, [darkText, lightText], targets.text);
  const focus = ensureContrast(built.border.focus, built.bg.surface, targets.ui);
  const focusRing = ensureContrast(built.state.focusRing, built.bg.surface, targets.ui);

  const tokens: ThemeTokens = {
    ...built,
    fg: { ...built.fg, onAccent },
    border: { ...built.border, focus },
    state: { ...built.state, selectedBg, focusRing },
    editor: { ...built.editor, selectionBg },
    badge: { ...built.badge, fg: badgeFg },
  };
  return { ...spec, accent, tokens };
}

/** Creates a theme with its default accent applied. */
export function defineTheme(spec: ThemeSpec): Theme {
  return applyAccent(spec, spec.accents[spec.defaultAccent]);
}

/**
 * Returns the theme recolored for another accent: a named accent from the theme's palette
 * or a custom `#rrggbb`. Dependent tokens are recomputed and contrast-guarded: the accent is
 * lightened or darkened until it reaches 3:1 (4.5:1 for AAA themes) on base and surface,
 * selection tints are reduced until selected text stays readable, and on-accent text flips
 * between dark and light as needed.
 */
export function withAccent(theme: ThemeSpec, accent: AccentSetting): Theme {
  return applyAccent(theme, resolveAccent(theme, accent));
}
