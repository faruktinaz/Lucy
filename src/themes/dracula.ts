/**
 * Dracula. Palette values from the published Dracula specification (MIT, see README.md),
 * including its darker background steps and the ANSI bright colors; the mapping to Lucy's
 * tokens is our own.
 *
 * Character: purple is the brand accent, pink is the second emphasis, keywords are pink,
 * functions green, types cyan, strings yellow and parameters orange, as in the spec. The
 * palette is very saturated, so tints stay light-handed.
 *
 * Adjustments:
 * - `comment` (#6272a4) is 3.0:1 on the background, below our 3.5:1 floor for comments and
 *   hints, so comments and placeholders use it lightened just enough (`commentText`,
 *   #6f7eac: 3.6:1 on the editor, 3:1 on the cursor line and overlays). Inactive line
 *   numbers and ANSI 8 keep the palette color (2.5:1 and 2:1 floors).
 * - Red (#ff5555) is 4.5:1 on the background, so code keeps it, but it drops below 4.5:1 on
 *   the removed-line tints, so removed diff text uses it lightened just enough (`redText`,
 *   #ff7676).
 * - Dracula has no muted text color, so secondary text is the foreground blended toward the
 *   background.
 * - The palette has no blue: the `blue` and `teal` accents both map to cyan.
 */
import { blend, ensureContrast } from "./color";
import { defineTheme } from "./theme";

const p = {
  bgDarker: "#191a21",
  bgDark: "#21222c",
  bg: "#282a36",
  currentLine: "#44475a",
  fg: "#f8f8f2",
  comment: "#6272a4",
  cyan: "#8be9fd",
  green: "#50fa7b",
  orange: "#ffb86c",
  pink: "#ff79c6",
  purple: "#bd93f9",
  red: "#ff5555",
  yellow: "#f1fa8c",
  brightRed: "#ff6e6e",
  brightGreen: "#69ff94",
  brightYellow: "#ffffa5",
  brightBlue: "#d6acff",
  brightMagenta: "#ff92df",
  brightCyan: "#a4ffff",
  brightWhite: "#ffffff",
} as const;

const activeLineBg = blend(p.currentLine, p.bg, 0.4);
const overlay = blend(p.currentLine, p.bg, 0.35);
/** Comment color lightened to 3.5:1 on the editor and 3:1 on the cursor line and overlays. */
const commentText = [p.bg, activeLineBg, overlay].reduce(
  (color, bg, i) => ensureContrast(color, bg, i === 0 ? 3.5 : 3),
  p.comment as string,
);
const removedWordBg = blend(p.red, p.bg, 0.16);
/** Palette red, lightened until it reads at 4.5:1 on the removed-word tint. */
const redText = ensureContrast(p.red, removedWordBg, 4.5);

export const dracula = defineTheme({
  id: "dracula",
  name: "Dracula",
  appearance: "dark",
  contrastLevel: "AA",
  accents: {
    blue: p.cyan,
    purple: p.purple,
    green: p.green,
    yellow: p.yellow,
    orange: p.orange,
    red: p.red,
    teal: p.cyan,
  },
  defaultAccent: "purple",
  build: (accent) => ({
    bg: {
      canvas: p.bgDarker,
      base: p.bg,
      surface: p.bgDark,
      raised: p.currentLine,
      overlay,
      inset: p.bgDarker,
    },
    fg: {
      default: p.fg,
      muted: blend(p.fg, p.bg, 0.72),
      subtle: commentText,
      onAccent: p.bgDarker,
      disabled: p.comment,
    },
    border: { subtle: blend(p.currentLine, p.bg, 0.6), default: p.currentLine, focus: accent },
    accent: { primary: accent, secondary: p.pink },
    state: {
      hover: blend(p.currentLine, p.bgDark, 0.5),
      active: p.currentLine,
      selectedBg: blend(accent, p.bg, 0.24),
      selectedFg: p.fg,
      selectedInactiveBg: blend(p.currentLine, p.bg, 0.75),
      focusRing: accent,
    },
    status: { success: p.green, warning: p.yellow, error: p.red, info: p.cyan },
    git: {
      added: p.green,
      modified: p.orange,
      deleted: p.red,
      renamed: p.purple,
      untracked: p.cyan,
      conflicted: p.pink,
      ignored: p.comment,
    },
    diff: {
      addedLineBg: blend(p.green, p.bg, 0.1),
      removedLineBg: blend(p.red, p.bg, 0.12),
      addedWordBg: blend(p.green, p.bg, 0.2),
      removedWordBg,
      addedFg: p.green,
      removedFg: redText,
      hunkHeaderBg: blend(p.purple, p.bg, 0.12),
      hunkHeaderFg: p.purple,
      contextFg: blend(p.fg, p.bg, 0.72),
    },
    syntax: {
      keyword: p.pink,
      string: p.yellow,
      number: p.purple,
      comment: commentText,
      function: p.green,
      type: p.cyan,
      variable: p.fg,
      parameter: p.orange,
      constant: p.purple,
      property: p.fg,
      operator: p.pink,
      punctuation: p.fg,
      tag: p.pink,
      attribute: p.green,
      heading: p.purple,
      link: p.cyan,
      regexp: p.red,
    },
    editor: {
      bg: p.bg,
      lineNumber: p.comment,
      lineNumberActive: p.fg,
      activeLineBg,
      selectionBg: blend(accent, p.bg, 0.26),
      findMatchBg: blend(p.yellow, p.bg, 0.16),
      findMatchActiveBg: blend(p.orange, p.bg, 0.32),
      indentGuide: blend(p.currentLine, p.bg, 0.6),
    },
    badge: { bg: accent, fg: p.bgDarker },
    scrollbar: { track: blend(p.currentLine, p.bg, 0.35), thumb: p.comment },
    terminal: {
      fg: p.fg,
      bg: p.bg,
      cursor: p.fg,
      selectionBg: p.currentLine,
      black: p.bgDark,
      red: p.red,
      green: p.green,
      yellow: p.yellow,
      blue: p.purple,
      magenta: p.pink,
      cyan: p.cyan,
      white: p.fg,
      brightBlack: p.comment,
      brightRed: p.brightRed,
      brightGreen: p.brightGreen,
      brightYellow: p.brightYellow,
      brightBlue: p.brightBlue,
      brightMagenta: p.brightMagenta,
      brightCyan: p.brightCyan,
      brightWhite: p.brightWhite,
    },
  }),
});
