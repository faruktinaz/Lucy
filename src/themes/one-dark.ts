/**
 * One Dark. Palette values from Atom's One Dark syntax and UI themes (MIT, see README.md);
 * the mapping to Lucy's tokens is our own.
 *
 * Character: the classic editor look. Blue accent and functions, purple keywords, green
 * strings, yellow types, orange numbers, and red for properties, tags and headings, which is
 * what makes One Dark recognisable.
 *
 * Adjustments:
 * - The comment grey (#5c6370) is 2.3:1, so comments and placeholders use #7f848e, the
 *   comment color of the widely used One Dark Pro port (3.7:1). The original grey stays
 *   on ANSI 8 (2:1 floor) and for disabled text.
 * - The gutter grey (#4b5263) is 1.8:1, so inactive line numbers and the scrollbar thumb
 *   use the lighter gutter step #636d83 (2.7:1).
 * - Red (#e06c75) is 4.4:1 on the background, under our 4.5:1 for code, so properties,
 *   tags and headings use it lightened just enough (`redCode`, #e17078), and removed diff
 *   text uses it lightened to read on the removed-word tint (`redText`, #e68990). Status
 *   and git colors keep the palette red.
 * - One Dark has one light grey, so ANSI 15 is that grey lightened a step to stay
 *   distinguishable from ANSI 7.
 */
import { blend, ensureContrast } from "./color";
import { defineTheme } from "./theme";

const p = {
  bgDarker: "#181a1f",
  bgDark: "#21252b",
  bg: "#282c34",
  lineHighlight: "#2c313c",
  selection: "#3e4451",
  gutter: "#4b5263",
  gutterLight: "#636d83",
  comment: "#5c6370",
  commentPro: "#7f848e",
  uiText: "#9da5b4",
  fg: "#abb2bf",
  red: "#e06c75",
  darkRed: "#be5046",
  green: "#98c379",
  yellow: "#e5c07b",
  darkYellow: "#d19a66",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
} as const;

/** Palette red, lightened just enough for 4.5:1 on the editor background. */
const redCode = ensureContrast(p.red, p.bg, 4.5);
const removedWordBg = blend(p.red, p.bg, 0.16);
/** Palette red, lightened until it reads at 4.5:1 on the removed-word tint. */
const redText = ensureContrast(p.red, removedWordBg, 4.5);

export const oneDark = defineTheme({
  id: "one-dark",
  name: "One Dark",
  appearance: "dark",
  contrastLevel: "AA",
  accents: {
    blue: p.blue,
    purple: p.magenta,
    green: p.green,
    yellow: p.yellow,
    orange: p.darkYellow,
    red: p.red,
    teal: p.cyan,
  },
  defaultAccent: "blue",
  build: (accent) => ({
    bg: {
      canvas: p.bgDarker,
      base: p.bg,
      surface: p.bgDark,
      raised: p.selection,
      overlay: blend(p.selection, p.bgDark, 0.45),
      inset: p.bgDarker,
    },
    fg: {
      default: p.fg,
      muted: p.uiText,
      subtle: p.commentPro,
      onAccent: p.bgDarker,
      disabled: p.comment,
    },
    border: { subtle: p.bgDarker, default: p.selection, focus: accent },
    accent: { primary: accent, secondary: p.magenta },
    state: {
      hover: blend(p.selection, p.bgDark, 0.5),
      active: p.selection,
      selectedBg: blend(accent, p.bg, 0.24),
      selectedFg: p.fg,
      selectedInactiveBg: blend(p.selection, p.bg, 0.7),
      focusRing: accent,
    },
    status: { success: p.green, warning: p.yellow, error: p.red, info: p.blue },
    git: {
      added: p.green,
      modified: p.yellow,
      deleted: p.red,
      renamed: p.blue,
      untracked: p.cyan,
      conflicted: p.darkYellow,
      ignored: p.commentPro,
    },
    diff: {
      addedLineBg: blend(p.green, p.bg, 0.12),
      removedLineBg: blend(p.red, p.bg, 0.12),
      addedWordBg: blend(p.green, p.bg, 0.16),
      removedWordBg,
      addedFg: p.green,
      removedFg: redText,
      hunkHeaderBg: blend(p.blue, p.bg, 0.1),
      hunkHeaderFg: p.blue,
      contextFg: p.fg,
    },
    syntax: {
      keyword: p.magenta,
      string: p.green,
      number: p.darkYellow,
      comment: p.commentPro,
      function: p.blue,
      type: p.yellow,
      variable: p.fg,
      parameter: p.fg,
      constant: p.darkYellow,
      property: redCode,
      operator: p.cyan,
      punctuation: p.fg,
      tag: redCode,
      attribute: p.darkYellow,
      heading: redCode,
      link: p.cyan,
      regexp: p.cyan,
    },
    editor: {
      bg: p.bg,
      lineNumber: p.gutterLight,
      lineNumberActive: p.fg,
      activeLineBg: p.lineHighlight,
      selectionBg: blend(accent, p.bg, 0.26),
      findMatchBg: blend(p.yellow, p.bg, 0.16),
      findMatchActiveBg: blend(p.darkYellow, p.bg, 0.2),
      indentGuide: blend(p.gutter, p.bg, 0.6),
    },
    badge: { bg: accent, fg: p.bgDarker },
    scrollbar: { track: blend(p.selection, p.bg, 0.35), thumb: p.gutterLight },
    terminal: {
      fg: p.fg,
      bg: p.bg,
      cursor: p.blue,
      selectionBg: p.selection,
      black: p.bgDarker,
      red: p.red,
      green: p.green,
      yellow: p.yellow,
      blue: p.blue,
      magenta: p.magenta,
      cyan: p.cyan,
      white: p.fg,
      brightBlack: p.comment,
      brightRed: p.red,
      brightGreen: p.green,
      brightYellow: p.darkYellow,
      brightBlue: p.blue,
      brightMagenta: p.magenta,
      brightCyan: p.cyan,
      brightWhite: blend("#ffffff", p.fg, 0.45),
    },
  }),
});
