/**
 * Solarized Dark. Palette values from Ethan Schoonover's published Solarized palette (MIT,
 * see README.md): the eight monotones base03-base3 and the eight accents; the mapping to
 * Lucy's tokens is our own, following Solarized's own syntax groups (green statements,
 * cyan constants and strings, blue identifiers, yellow types, red specials).
 *
 * Character: the amber accent on deep teal-blue, with emphasized base1 text.
 *
 * Adjustments (Solarized is deliberately low contrast, so it needs the most):
 * - base03 is the darkest monotone, so the chrome and the canvas are base03 darkened.
 * - Body text uses base1 (Solarized's "emphasized content", 5.6:1); secondary text uses
 *   base0, the normal body color (4.7:1).
 * - base01 (#586e75, 2.8:1) is Solarized's comment color; comments and hints use it
 *   lightened just enough for 3.5:1 (`commentText`, #6a7e84). Inactive line numbers keep
 *   base01 (2.5:1 floor). Ignored files use base00 (base01 is under 3:1).
 * - Blue (4.1:1), violet (3.4:1), magenta (3.3:1), orange (3.3:1) and red (3.3:1) pass the
 *   3:1 floor for status, git and ANSI colors but not 4.5:1 for code, so their code uses
 *   are lightened just enough (`*Text`: #3694d5, #8287cd, #dd629d, #d67147, #e46462).
 *   Diff text is lightened likewise to read at 4.5:1 on its tints (green #95a722, red
 *   #e66f6c, hunk-header blue #4ea1da).
 * - Canonical Solarized ANSI puts base03 (the background itself) on ANSI 8 and base01
 *   (2.8:1) on ANSI 10. ANSI 8 uses base01 instead, so shell autosuggestions stay visible,
 *   and ANSI 10 uses base01 lightened to 3:1 (#5d737a); the other entries stay canonical.
 */
import { blend, ensureContrast } from "./color";
import { defineTheme } from "./theme";

const p = {
  base03: "#002b36",
  base02: "#073642",
  base01: "#586e75",
  base00: "#657b83",
  base0: "#839496",
  base1: "#93a1a1",
  base2: "#eee8d5",
  base3: "#fdf6e3",
  yellow: "#b58900",
  orange: "#cb4b16",
  red: "#dc322f",
  magenta: "#d33682",
  violet: "#6c71c4",
  blue: "#268bd2",
  cyan: "#2aa198",
  green: "#859900",
} as const;

const surface = blend("#000000", p.base03, 0.22);
const canvas = blend("#000000", p.base03, 0.42);
const text = (color: string): string => ensureContrast(color, p.base03, 4.5);
const commentText = ensureContrast(p.base01, p.base03, 3.5);
const blueText = text(p.blue);
const violetText = text(p.violet);
const magentaText = text(p.magenta);
const orangeText = text(p.orange);
const redText = text(p.red);
const addedWordBg = blend(p.green, p.base03, 0.16);
const removedWordBg = blend(p.red, p.base03, 0.2);
const hunkHeaderBg = blend(p.blue, p.base03, 0.12);

export const solarizedDark = defineTheme({
  id: "solarized-dark",
  name: "Solarized Dark",
  appearance: "dark",
  contrastLevel: "AA",
  accents: {
    blue: p.blue,
    purple: p.violet,
    green: p.green,
    yellow: p.yellow,
    orange: p.orange,
    red: p.red,
    teal: p.cyan,
  },
  defaultAccent: "yellow",
  build: (accent) => ({
    bg: {
      canvas,
      base: p.base03,
      surface,
      raised: p.base02,
      overlay: blend(p.base02, p.base03, 0.35),
      inset: canvas,
    },
    fg: {
      default: p.base1,
      muted: p.base0,
      subtle: commentText,
      onAccent: p.base03,
      disabled: p.base01,
    },
    border: { subtle: p.base02, default: blend(p.base01, p.base02, 0.45), focus: accent },
    accent: { primary: accent, secondary: p.blue },
    state: {
      hover: blend(p.base02, p.base03, 0.6),
      active: p.base02,
      selectedBg: blend(accent, p.base03, 0.2),
      selectedFg: p.base2,
      selectedInactiveBg: p.base02,
      focusRing: accent,
    },
    status: { success: p.green, warning: p.yellow, error: p.red, info: p.blue },
    git: {
      added: p.green,
      modified: p.yellow,
      deleted: p.red,
      renamed: p.violet,
      untracked: p.cyan,
      conflicted: p.orange,
      ignored: p.base00,
    },
    diff: {
      addedLineBg: blend(p.green, p.base03, 0.1),
      removedLineBg: blend(p.red, p.base03, 0.12),
      addedWordBg,
      removedWordBg,
      addedFg: ensureContrast(p.green, addedWordBg, 4.5),
      removedFg: ensureContrast(p.red, removedWordBg, 4.5),
      hunkHeaderBg,
      hunkHeaderFg: ensureContrast(p.blue, hunkHeaderBg, 4.5),
      contextFg: p.base0,
    },
    syntax: {
      keyword: p.green,
      string: p.cyan,
      number: magentaText,
      comment: commentText,
      function: blueText,
      type: p.yellow,
      variable: p.base1,
      parameter: violetText,
      constant: p.cyan,
      property: blueText,
      operator: p.green,
      punctuation: p.base0,
      tag: blueText,
      attribute: p.yellow,
      heading: orangeText,
      link: violetText,
      regexp: redText,
    },
    editor: {
      bg: p.base03,
      lineNumber: p.base01,
      lineNumberActive: p.base1,
      activeLineBg: blend(p.base02, p.base03, 0.7),
      selectionBg: blend(accent, p.base03, 0.22),
      findMatchBg: blend(p.yellow, p.base03, 0.16),
      findMatchActiveBg: blend(p.orange, p.base03, 0.3),
      indentGuide: p.base02,
    },
    badge: { bg: accent, fg: p.base03 },
    scrollbar: { track: p.base02, thumb: p.base01 },
    terminal: {
      fg: p.base0,
      bg: p.base03,
      cursor: p.base1,
      selectionBg: blend(p.base02, p.base03, 0.4),
      black: p.base02,
      red: p.red,
      green: p.green,
      yellow: p.yellow,
      blue: p.blue,
      magenta: p.magenta,
      cyan: p.cyan,
      white: p.base2,
      brightBlack: p.base01,
      brightRed: p.orange,
      brightGreen: ensureContrast(p.base01, p.base03, 3),
      brightYellow: p.base00,
      brightBlue: p.base0,
      brightMagenta: p.violet,
      brightCyan: p.base1,
      brightWhite: p.base3,
    },
  }),
});
