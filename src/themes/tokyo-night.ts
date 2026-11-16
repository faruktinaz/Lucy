/**
 * Tokyo Night ("night" variant). Palette values from the published Tokyo Night color scheme
 * (see README.md for sources and licenses); the mapping to Lucy's tokens is our own.
 *
 * Adjustments, all to other palette colors:
 * - `comment` (#565f89) is about 2.6:1 on the background, below our 3.5:1 floor for
 *   comments, so comments use `dark5` (#737aa2, 4.1:1).
 * - `terminal_black` (#414868) is 1.9:1 as ANSI 8 and as a scrollbar thumb; shell
 *   autosuggestions print in ANSI 8, so both use `dark3` (#545c7e, 2.6:1).
 */
import { blend } from "./color";
import { defineTheme } from "./theme";

const p = {
  bg: "#1a1b26",
  bgDark: "#16161e",
  bgHighlight: "#292e42",
  bgVisual: "#283457",
  black: "#15161e",
  terminalBlack: "#414868",
  fg: "#c0caf5",
  fgDark: "#a9b1d6",
  fgGutter: "#3b4261",
  dark3: "#545c7e",
  dark5: "#737aa2",
  blue: "#7aa2f7",
  cyan: "#7dcfff",
  blue1: "#2ac3de",
  blue5: "#89ddff",
  blue6: "#b4f9f8",
  magenta: "#bb9af7",
  orange: "#ff9e64",
  yellow: "#e0af68",
  green: "#9ece6a",
  green1: "#73daca",
  teal: "#1abc9c",
  red: "#f7768e",
} as const;

/** Not a palette color: inputs need a well one step darker than bgDark. */
const inset = blend("#000000", p.bgDark, 0.3);

export const tokyoNight = defineTheme({
  id: "tokyo-night",
  name: "Tokyo Night",
  appearance: "dark",
  contrastLevel: "AA",
  accents: {
    blue: p.blue,
    purple: p.magenta,
    green: p.green,
    yellow: p.yellow,
    orange: p.orange,
    red: p.red,
    teal: p.teal,
  },
  defaultAccent: "blue",
  build: (accent) => ({
    bg: {
      base: p.bg,
      surface: p.bgDark,
      raised: p.bgHighlight,
      overlay: blend(p.bgHighlight, p.bg, 0.55),
      inset,
    },
    fg: {
      default: p.fg,
      muted: p.fgDark,
      subtle: p.dark5,
      onAccent: p.black,
      disabled: p.dark3,
    },
    border: { subtle: blend(p.fgGutter, p.bg, 0.55), default: p.fgGutter, focus: accent },
    accent: { primary: accent, secondary: p.magenta },
    state: {
      hover: blend(p.bgHighlight, p.bgDark, 0.7),
      active: p.fgGutter,
      selectedBg: blend(accent, p.bg, 0.24),
      selectedFg: p.fg,
      selectedInactiveBg: p.bgHighlight,
      focusRing: accent,
    },
    status: { success: p.green, warning: p.yellow, error: p.red, info: p.cyan },
    git: {
      added: p.green,
      modified: p.yellow,
      deleted: p.red,
      renamed: p.cyan,
      untracked: p.green1,
      conflicted: p.orange,
      ignored: p.dark5,
    },
    diff: {
      addedLineBg: blend(p.green, p.bg, 0.12),
      removedLineBg: blend(p.red, p.bg, 0.12),
      addedWordBg: blend(p.green, p.bg, 0.2),
      removedWordBg: blend(p.red, p.bg, 0.2),
      addedFg: p.green,
      removedFg: p.red,
      hunkHeaderBg: blend(p.blue, p.bg, 0.1),
      hunkHeaderFg: p.cyan,
      contextFg: p.fgDark,
    },
    syntax: {
      keyword: p.magenta,
      string: p.green,
      number: p.orange,
      comment: p.dark5,
      function: p.blue,
      type: p.blue1,
      variable: p.fg,
      parameter: p.yellow,
      constant: p.orange,
      property: p.green1,
      operator: p.blue5,
      punctuation: p.blue5,
      tag: p.red,
      attribute: p.magenta,
      heading: p.blue,
      link: p.green1,
      regexp: p.blue6,
    },
    editor: {
      bg: p.bg,
      lineNumber: p.dark3,
      lineNumberActive: p.fgDark,
      activeLineBg: blend(p.bgHighlight, p.bg, 0.5),
      selectionBg: blend(accent, p.bg, 0.26),
      findMatchBg: blend(p.yellow, p.bg, 0.18),
      findMatchActiveBg: blend(p.orange, p.bg, 0.34),
      indentGuide: blend(p.fgGutter, p.bg, 0.6),
    },
    badge: { bg: accent, fg: p.black },
    scrollbar: { track: blend(p.bgHighlight, p.bg, 0.4), thumb: p.dark3 },
    terminal: {
      fg: p.fg,
      bg: p.bg,
      cursor: p.fg,
      selectionBg: p.bgVisual,
      black: p.black,
      red: p.red,
      green: p.green,
      yellow: p.yellow,
      blue: p.blue,
      magenta: p.magenta,
      cyan: p.cyan,
      white: p.fgDark,
      brightBlack: p.dark3,
      brightRed: p.red,
      brightGreen: p.green,
      brightYellow: p.yellow,
      brightBlue: p.blue,
      brightMagenta: p.magenta,
      brightCyan: p.cyan,
      brightWhite: p.fg,
    },
  }),
});
