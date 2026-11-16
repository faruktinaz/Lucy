/**
 * Identifiers shared with the config schema. Kept free of imports so `src/core/config` can
 * depend on it without pulling in theme data.
 */

export const THEME_IDS = ["catppuccin-mocha", "tokyo-night", "gruvbox-dark", "high-contrast"] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export const DEFAULT_THEME_ID: ThemeId = "catppuccin-mocha";

/**
 * Accent names every theme maps to one of its own palette colors, so `accent = "purple"`
 * means "this theme's purple" whichever theme is active.
 */
export const ACCENT_NAMES = ["blue", "purple", "green", "yellow", "orange", "red", "teal"] as const;
export type AccentName = (typeof ACCENT_NAMES)[number];

export const ICON_TIERS = ["nerd", "unicode", "ascii"] as const;
export type IconTier = (typeof ICON_TIERS)[number];

export const COLOR_MODES = ["truecolor", "256", "16"] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

export function isThemeId(value: string): value is ThemeId {
  return (THEME_IDS as readonly string[]).includes(value);
}

export function isAccentName(value: string): value is AccentName {
  return (ACCENT_NAMES as readonly string[]).includes(value);
}
