import { catppuccinMocha } from "./catppuccin-mocha";
import { dracula } from "./dracula";
import { everforestDark } from "./everforest-dark";
import { githubDark } from "./github-dark";
import { gruvboxDark } from "./gruvbox-dark";
import { highContrast } from "./high-contrast";
import { DEFAULT_THEME_ID, isThemeId, THEME_IDS, type ThemeId } from "./ids";
import { kanagawaWave } from "./kanagawa-wave";
import { nord } from "./nord";
import { oneDark } from "./one-dark";
import { rosePine } from "./rose-pine";
import { solarizedDark } from "./solarized-dark";
import { type AccentSetting, type Theme, withAccent } from "./theme";
import { tokyoNight } from "./tokyo-night";

const THEMES: Readonly<Record<ThemeId, Theme>> = {
  "catppuccin-mocha": catppuccinMocha,
  "tokyo-night": tokyoNight,
  "gruvbox-dark": gruvboxDark,
  dracula,
  nord,
  "one-dark": oneDark,
  "rose-pine": rosePine,
  "kanagawa-wave": kanagawaWave,
  "everforest-dark": everforestDark,
  "github-dark": githubDark,
  "solarized-dark": solarizedDark,
  "high-contrast": highContrast,
};

/** Returns a built-in theme. Unknown ids fall back to the default theme. */
export function getTheme(id: string): Theme {
  return isThemeId(id) ? THEMES[id] : THEMES[DEFAULT_THEME_ID];
}

/** Built-in themes in display order. */
export function listThemes(): Theme[] {
  return THEME_IDS.map((id) => THEMES[id]);
}

/** The theme for the `ui.theme` and `ui.accent` settings. */
export function themeFromSettings(themeId: string, accent: AccentSetting = "default"): Theme {
  const theme = getTheme(themeId);
  return accent === "default" ? theme : withAccent(theme, accent);
}
