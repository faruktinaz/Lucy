/**
 * Gruvbox Dark (medium contrast). Palette values from the published Gruvbox color scheme
 * (MIT, see README.md); the mapping to Lucy's tokens is our own. The bright variants carry
 * text and status colors; the neutral variants are used only in the terminal palette.
 *
 * Adjustments:
 * - Bright red (#fb4934) is 4.3:1 on bg0 and 3.4:1 on a removed-word tint, under our 4.5:1
 *   for text, so keywords and removed text use it lightened just enough (`redText`).
 *   Status and git colors (3:1 floor) keep the palette red.
 * - Neutral red (#cc241d) is 2.7:1 as ANSI 1, too dark for error output, so ANSI 1 uses
 *   the bright red as well.
 */
import { blend, ensureContrast } from "./color";
import { defineTheme } from "./theme";

const p = {
  bg0h: "#1d2021",
  bg0: "#282828",
  bg0s: "#32302f",
  bg1: "#3c3836",
  bg2: "#504945",
  bg3: "#665c54",
  bg4: "#7c6f64",
  gray: "#928374",
  fg0: "#fbf1c7",
  fg1: "#ebdbb2",
  fg2: "#d5c4a1",
  fg3: "#bdae93",
  fg4: "#a89984",
  red: "#fb4934",
  green: "#b8bb26",
  yellow: "#fabd2f",
  blue: "#83a598",
  purple: "#d3869b",
  aqua: "#8ec07c",
  orange: "#fe8019",
  neutralGreen: "#98971a",
  neutralYellow: "#d79921",
  neutralBlue: "#458588",
  neutralPurple: "#b16286",
  neutralAqua: "#689d6a",
} as const;

/** Not a palette color: inputs need a well one step darker than bg0_h. */
const inset = blend("#000000", p.bg0h, 0.3);

const removedWordBg = blend(p.red, p.bg0, 0.2);
/** Palette red, lightened until it reads at 4.5:1 even on the removed-word tint. */
const redText = ensureContrast(p.red, removedWordBg, 4.5);

export const gruvboxDark = defineTheme({
  id: "gruvbox-dark",
  name: "Gruvbox Dark",
  appearance: "dark",
  contrastLevel: "AA",
  accents: {
    blue: p.blue,
    purple: p.purple,
    green: p.green,
    yellow: p.yellow,
    orange: p.orange,
    red: p.red,
    teal: p.aqua,
  },
  defaultAccent: "blue",
  build: (accent) => ({
    bg: { canvas: inset, base: p.bg0, surface: p.bg0h, raised: p.bg1, overlay: p.bg0s, inset },
    fg: {
      default: p.fg1,
      muted: p.fg3,
      subtle: p.gray,
      onAccent: p.bg0h,
      disabled: p.bg3,
    },
    border: { subtle: p.bg1, default: p.bg2, focus: accent },
    accent: { primary: accent, secondary: p.purple },
    state: {
      hover: blend(p.bg1, p.bg0h, 0.7),
      active: p.bg2,
      selectedBg: blend(accent, p.bg0, 0.24),
      selectedFg: p.fg0,
      selectedInactiveBg: p.bg1,
      focusRing: accent,
    },
    status: { success: p.green, warning: p.yellow, error: p.red, info: p.blue },
    git: {
      added: p.green,
      modified: p.yellow,
      deleted: p.red,
      renamed: p.blue,
      untracked: p.aqua,
      conflicted: p.orange,
      ignored: p.gray,
    },
    diff: {
      addedLineBg: blend(p.green, p.bg0, 0.12),
      removedLineBg: blend(p.red, p.bg0, 0.12),
      addedWordBg: blend(p.green, p.bg0, 0.2),
      removedWordBg,
      addedFg: p.green,
      removedFg: redText,
      hunkHeaderBg: blend(p.blue, p.bg0, 0.1),
      hunkHeaderFg: p.blue,
      contextFg: p.fg3,
    },
    syntax: {
      keyword: redText,
      string: p.green,
      number: p.purple,
      comment: p.gray,
      function: p.aqua,
      type: p.yellow,
      variable: p.fg1,
      parameter: p.blue,
      constant: p.purple,
      property: p.blue,
      operator: p.orange,
      punctuation: p.fg4,
      tag: p.aqua,
      attribute: p.yellow,
      heading: p.green,
      link: p.blue,
      regexp: p.orange,
    },
    editor: {
      bg: p.bg0,
      lineNumber: p.bg4,
      lineNumberActive: p.yellow,
      activeLineBg: blend(p.bg1, p.bg0, 0.55),
      selectionBg: blend(accent, p.bg0, 0.26),
      findMatchBg: blend(p.yellow, p.bg0, 0.16),
      findMatchActiveBg: blend(p.orange, p.bg0, 0.32),
      indentGuide: p.bg1,
    },
    badge: { bg: accent, fg: p.bg0h },
    scrollbar: { track: blend(p.bg1, p.bg0, 0.4), thumb: p.bg3 },
    terminal: {
      fg: p.fg1,
      bg: p.bg0,
      cursor: p.fg1,
      selectionBg: p.bg2,
      black: p.bg0,
      red: p.red,
      green: p.neutralGreen,
      yellow: p.neutralYellow,
      blue: p.neutralBlue,
      magenta: p.neutralPurple,
      cyan: p.neutralAqua,
      white: p.fg4,
      brightBlack: p.gray,
      brightRed: p.red,
      brightGreen: p.green,
      brightYellow: p.yellow,
      brightBlue: p.blue,
      brightMagenta: p.purple,
      brightCyan: p.aqua,
      brightWhite: p.fg1,
    },
  }),
});
