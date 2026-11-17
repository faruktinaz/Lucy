/**
 * Rosé Pine (main variant). Palette values from the published Rosé Pine palette (MIT, see
 * README.md); the mapping to Lucy's tokens is our own, guided by Rosé Pine's own role
 * suggestions (pine keywords, rose functions, foam types, gold strings, iris parameters).
 *
 * Character: soft and warm on a violet-black base. The dusty rose is the accent, and the
 * hues stay muted rather than saturated.
 *
 * Adjustments:
 * - Rosé Pine's darkest color is `base`, so the chrome and the canvas are `base` darkened.
 *   The published `surface` and `overlay` colors serve as floating and raised layers.
 * - `muted` (#6e6a86, 3.4:1) is Rosé Pine's comment color and is just below our 3.5:1 floor
 *   for comments and hints, so those uses are lightened just enough (`mutedText`, #74718b).
 *   Inactive line numbers, ignored files and ANSI 8 keep the palette value.
 * - `pine` (#31748f, 3.4:1) passes the 3:1 floor for git and ANSI colors but not 4.5:1 for
 *   code, so keywords and links use it lightened just enough (`pineText`, #4f889f).
 * - The palette has six hues for seven accent names: there is no green, so `green` maps to
 *   pine (Rosé Pine's own ANSI green), `teal` to pine as well, and `orange` to rose.
 */
import { blend, ensureContrast } from "./color";
import { defineTheme } from "./theme";

const p = {
  base: "#191724",
  surface: "#1f1d2e",
  overlay: "#26233a",
  muted: "#6e6a86",
  subtle: "#908caa",
  text: "#e0def4",
  love: "#eb6f92",
  gold: "#f6c177",
  rose: "#ebbcba",
  pine: "#31748f",
  foam: "#9ccfd8",
  iris: "#c4a7e7",
  highlightLow: "#21202e",
  highlightMed: "#403d52",
  highlightHigh: "#524f67",
} as const;

const chrome = blend("#000000", p.base, 0.2);
const canvas = blend("#000000", p.base, 0.4);
const mutedText = ensureContrast(p.muted, p.surface, 3.5);
const pineText = ensureContrast(p.pine, p.base, 4.5);

export const rosePine = defineTheme({
  id: "rose-pine",
  name: "Rosé Pine",
  appearance: "dark",
  contrastLevel: "AA",
  accents: {
    blue: p.foam,
    purple: p.iris,
    green: p.pine,
    yellow: p.gold,
    orange: p.rose,
    red: p.love,
    teal: p.pine,
  },
  defaultAccent: "orange",
  build: (accent) => ({
    bg: {
      canvas,
      base: p.base,
      surface: chrome,
      raised: p.overlay,
      overlay: p.surface,
      inset: canvas,
    },
    fg: {
      default: p.text,
      muted: p.subtle,
      subtle: mutedText,
      onAccent: p.base,
      disabled: p.muted,
    },
    border: { subtle: p.overlay, default: p.highlightMed, focus: accent },
    accent: { primary: accent, secondary: p.iris },
    state: {
      hover: p.highlightLow,
      active: p.highlightMed,
      selectedBg: blend(accent, p.base, 0.22),
      selectedFg: p.text,
      selectedInactiveBg: blend(p.highlightMed, p.base, 0.6),
      focusRing: accent,
    },
    status: { success: p.foam, warning: p.gold, error: p.love, info: p.iris },
    git: {
      added: p.foam,
      modified: p.rose,
      deleted: p.love,
      renamed: p.pine,
      untracked: p.subtle,
      conflicted: p.iris,
      ignored: p.muted,
    },
    diff: {
      addedLineBg: blend(p.foam, p.base, 0.1),
      removedLineBg: blend(p.love, p.base, 0.12),
      addedWordBg: blend(p.foam, p.base, 0.2),
      removedWordBg: blend(p.love, p.base, 0.18),
      addedFg: p.foam,
      removedFg: p.love,
      hunkHeaderBg: blend(p.iris, p.base, 0.1),
      hunkHeaderFg: p.iris,
      contextFg: p.subtle,
    },
    syntax: {
      keyword: pineText,
      string: p.gold,
      number: p.gold,
      comment: mutedText,
      function: p.rose,
      type: p.foam,
      variable: p.text,
      parameter: p.iris,
      constant: p.gold,
      property: p.foam,
      operator: p.subtle,
      punctuation: p.subtle,
      tag: p.foam,
      attribute: p.iris,
      heading: p.iris,
      link: pineText,
      regexp: p.love,
    },
    editor: {
      bg: p.base,
      lineNumber: p.muted,
      lineNumberActive: p.text,
      activeLineBg: p.highlightLow,
      selectionBg: blend(accent, p.base, 0.24),
      findMatchBg: blend(p.gold, p.base, 0.16),
      findMatchActiveBg: blend(p.rose, p.base, 0.32),
      indentGuide: blend(p.highlightMed, p.base, 0.6),
    },
    badge: { bg: accent, fg: p.base },
    scrollbar: { track: blend(p.overlay, p.base, 0.5), thumb: p.highlightHigh },
    terminal: {
      fg: p.text,
      bg: p.base,
      cursor: p.highlightHigh,
      selectionBg: p.highlightMed,
      black: p.overlay,
      red: p.love,
      green: p.pine,
      yellow: p.gold,
      blue: p.foam,
      magenta: p.iris,
      cyan: p.rose,
      white: p.text,
      brightBlack: p.muted,
      brightRed: p.love,
      brightGreen: p.pine,
      brightYellow: p.gold,
      brightBlue: p.foam,
      brightMagenta: p.iris,
      brightCyan: p.rose,
      brightWhite: p.text,
    },
  }),
});
