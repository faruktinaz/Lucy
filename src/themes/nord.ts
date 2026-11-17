/**
 * Nord. Palette values from the published Nord color palette nord0-nord15 (MIT, see
 * README.md); the mapping to Lucy's tokens is our own and follows Nord's own syntax
 * guidelines (keywords nord9, functions nord8, types nord7, strings nord14, numbers nord15).
 *
 * Character: restrained and cool. The frost cyan nord8 is the accent, most code stays in
 * Snow Storm white, and the Aurora colors are reserved for strings, numbers and states.
 *
 * Adjustments (Nord is designed for low contrast, so several are needed):
 * - Polar Night has no step darker than nord0, so the chrome and the canvas are nord0
 *   darkened (`surface`, `canvas`).
 * - Comments use #616e88, the brightened nord3 that Nord's own editor ports use for
 *   comments. At 2.4:1 it is still below our 3.5:1 floor for comments and hints, so it is
 *   lightened just enough (`commentText`, #7e889d). Inactive line numbers use it lightened
 *   to 2.5:1 (#637089).
 * - nord3 (#4c566a) is 1.7:1, too dim for ANSI 8 and the scrollbar thumb, which use
 *   #616e88 (2.4:1) instead.
 * - Purple nord15 (#b48ead, 4.4:1) is just under 4.5:1 for code, so numbers and constants
 *   use it lightened just enough (`purpleText`, #b590af).
 * - Red nord11 (#bf616a, 3.1:1) passes the 3:1 floor for status and git colors but not
 *   4.5:1 for diff text, so removed diff text uses it lightened (`redText`, #d5999e). The
 *   added-word tint is kept at 15 % so nord14 still reads at 4.5:1 on it.
 * - Nord has no muted text color, so secondary text is nord4 blended toward nord0.
 */
import { blend, ensureContrast } from "./color";
import { defineTheme } from "./theme";

const p = {
  nord0: "#2e3440",
  nord1: "#3b4252",
  nord2: "#434c5e",
  nord3: "#4c566a",
  nord3Bright: "#616e88",
  nord4: "#d8dee9",
  nord5: "#e5e9f0",
  nord6: "#eceff4",
  nord7: "#8fbcbb",
  nord8: "#88c0d0",
  nord9: "#81a1c1",
  nord10: "#5e81ac",
  nord11: "#bf616a",
  nord12: "#d08770",
  nord13: "#ebcb8b",
  nord14: "#a3be8c",
  nord15: "#b48ead",
} as const;

const surface = blend("#000000", p.nord0, 0.16);
const canvas = blend("#000000", p.nord0, 0.34);
const muted = blend(p.nord4, p.nord0, 0.78);
const commentText = ensureContrast(p.nord3Bright, p.nord0, 3.5);
const lineNumber = ensureContrast(p.nord3Bright, p.nord0, 2.5);
const removedWordBg = blend(p.nord11, p.nord0, 0.16);
/** nord11 lightened until it reads at 4.5:1 on the removed-word tint. */
const redText = ensureContrast(p.nord11, removedWordBg, 4.5);
const purpleText = ensureContrast(p.nord15, p.nord0, 4.5);

export const nord = defineTheme({
  id: "nord",
  name: "Nord",
  appearance: "dark",
  contrastLevel: "AA",
  accents: {
    blue: p.nord9,
    purple: p.nord15,
    green: p.nord14,
    yellow: p.nord13,
    orange: p.nord12,
    red: p.nord11,
    teal: p.nord8,
  },
  defaultAccent: "teal",
  build: (accent) => ({
    bg: {
      canvas,
      base: p.nord0,
      surface,
      raised: p.nord1,
      overlay: blend(p.nord1, p.nord0, 0.6),
      inset: canvas,
    },
    fg: {
      default: p.nord4,
      muted,
      subtle: commentText,
      onAccent: p.nord0,
      disabled: p.nord3Bright,
    },
    border: { subtle: p.nord1, default: p.nord2, focus: accent },
    accent: { primary: accent, secondary: p.nord15 },
    state: {
      hover: blend(p.nord1, p.nord0, 0.6),
      active: p.nord2,
      selectedBg: blend(accent, p.nord0, 0.24),
      selectedFg: p.nord6,
      selectedInactiveBg: p.nord1,
      focusRing: accent,
    },
    status: { success: p.nord14, warning: p.nord13, error: p.nord11, info: p.nord8 },
    git: {
      added: p.nord14,
      modified: p.nord13,
      deleted: p.nord11,
      renamed: p.nord9,
      untracked: p.nord7,
      conflicted: p.nord12,
      ignored: commentText,
    },
    diff: {
      addedLineBg: blend(p.nord14, p.nord0, 0.1),
      removedLineBg: blend(p.nord11, p.nord0, 0.1),
      addedWordBg: blend(p.nord14, p.nord0, 0.15),
      removedWordBg,
      addedFg: p.nord14,
      removedFg: redText,
      hunkHeaderBg: blend(p.nord10, p.nord0, 0.16),
      hunkHeaderFg: p.nord8,
      contextFg: muted,
    },
    syntax: {
      keyword: p.nord9,
      string: p.nord14,
      number: purpleText,
      comment: commentText,
      function: p.nord8,
      type: p.nord7,
      variable: p.nord4,
      parameter: p.nord5,
      constant: purpleText,
      property: p.nord4,
      operator: p.nord9,
      punctuation: p.nord6,
      tag: p.nord9,
      attribute: p.nord7,
      heading: p.nord8,
      link: p.nord8,
      regexp: p.nord13,
    },
    editor: {
      bg: p.nord0,
      lineNumber,
      lineNumberActive: p.nord4,
      activeLineBg: blend(p.nord1, p.nord0, 0.6),
      selectionBg: blend(accent, p.nord0, 0.24),
      findMatchBg: blend(p.nord13, p.nord0, 0.16),
      findMatchActiveBg: blend(p.nord12, p.nord0, 0.32),
      indentGuide: p.nord1,
    },
    badge: { bg: accent, fg: p.nord0 },
    scrollbar: { track: blend(p.nord1, p.nord0, 0.4), thumb: p.nord3Bright },
    terminal: {
      fg: p.nord4,
      bg: p.nord0,
      cursor: p.nord4,
      selectionBg: p.nord2,
      black: p.nord1,
      red: p.nord11,
      green: p.nord14,
      yellow: p.nord13,
      blue: p.nord9,
      magenta: p.nord15,
      cyan: p.nord8,
      white: p.nord5,
      brightBlack: p.nord3Bright,
      brightRed: p.nord11,
      brightGreen: p.nord14,
      brightYellow: p.nord13,
      brightBlue: p.nord9,
      brightMagenta: p.nord15,
      brightCyan: p.nord7,
      brightWhite: p.nord6,
    },
  }),
});
