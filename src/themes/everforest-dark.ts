/**
 * Everforest Dark (medium background). Palette values from the published Everforest color
 * scheme (MIT, see README.md); the mapping to Lucy's tokens is our own, close to
 * Everforest's own highlight groups.
 *
 * Character: a calm forest. Sage green is the accent and the function color, keywords are
 * a soft red, strings aqua, types yellow, numbers purple and properties blue, all on a
 * warm grey-green background with Everforest's own green and red diff backgrounds.
 *
 * Adjustments:
 * - `bg_dim` is the darkest published step and serves as the chrome, so the canvas is
 *   `bg_dim` darkened.
 * - Green (#a7c080) and red (#e67e80) are below 4.5:1 on Everforest's own `bg_green` and
 *   `bg_red` diff backgrounds, so added and removed diff text use them lightened just
 *   enough (`greenText` #afc78c, `redText` #ec9c9d). Code, status and git colors keep the
 *   palette values.
 * - `grey2` is 4.4:1 on bg1, so overlays sit halfway between bg0 and bg1, and the active
 *   line number uses `fg` instead of `grey2` on the bg1 cursor line.
 */
import { blend, ensureContrast } from "./color";
import { defineTheme } from "./theme";

const p = {
  bgDim: "#232a2e",
  bg0: "#2d353b",
  bg1: "#343f44",
  bg2: "#3d484d",
  bg3: "#475258",
  bg4: "#4f585e",
  bg5: "#56635f",
  bgRed: "#514045",
  bgGreen: "#425047",
  bgBlue: "#3a515d",
  bgYellow: "#4d4c43",
  fg: "#d3c6aa",
  red: "#e67e80",
  orange: "#e69875",
  yellow: "#dbbc7f",
  green: "#a7c080",
  aqua: "#83c092",
  blue: "#7fbbb3",
  purple: "#d699b6",
  grey0: "#7a8478",
  grey1: "#859289",
  grey2: "#9da9a0",
} as const;

const canvas = blend("#000000", p.bgDim, 0.3);
const addedWordBg = blend(p.green, p.bg0, 0.2);
/** Palette green, lightened until it reads at 4.5:1 on bg_green and the added-word tint. */
const greenText = ensureContrast(ensureContrast(p.green, p.bgGreen, 4.5), addedWordBg, 4.5);
const removedWordBg = blend(p.red, p.bg0, 0.16);
/** Palette red, lightened until it reads at 4.5:1 on bg_red and the removed-word tint. */
const redText = ensureContrast(ensureContrast(p.red, p.bgRed, 4.5), removedWordBg, 4.5);

export const everforestDark = defineTheme({
  id: "everforest-dark",
  name: "Everforest Dark",
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
  defaultAccent: "green",
  build: (accent) => ({
    bg: {
      canvas,
      base: p.bg0,
      surface: p.bgDim,
      raised: p.bg2,
      overlay: blend(p.bg1, p.bg0, 0.5),
      inset: canvas,
    },
    fg: {
      default: p.fg,
      muted: p.grey2,
      subtle: p.grey1,
      onAccent: p.bgDim,
      disabled: p.grey0,
    },
    border: { subtle: p.bg1, default: p.bg3, focus: accent },
    accent: { primary: accent, secondary: p.aqua },
    state: {
      hover: blend(p.bg1, p.bgDim, 0.7),
      active: p.bg3,
      selectedBg: blend(accent, p.bg0, 0.24),
      selectedFg: p.fg,
      selectedInactiveBg: p.bg2,
      focusRing: accent,
    },
    status: { success: p.green, warning: p.yellow, error: p.red, info: p.blue },
    git: {
      added: p.green,
      modified: p.yellow,
      deleted: p.red,
      renamed: p.purple,
      untracked: p.aqua,
      conflicted: p.orange,
      ignored: p.grey1,
    },
    diff: {
      addedLineBg: p.bgGreen,
      removedLineBg: p.bgRed,
      addedWordBg,
      removedWordBg,
      addedFg: greenText,
      removedFg: redText,
      hunkHeaderBg: p.bgBlue,
      hunkHeaderFg: p.fg,
      contextFg: p.grey2,
    },
    syntax: {
      keyword: p.red,
      string: p.aqua,
      number: p.purple,
      comment: p.grey1,
      function: p.green,
      type: p.yellow,
      variable: p.fg,
      parameter: p.fg,
      constant: p.purple,
      property: p.blue,
      operator: p.orange,
      punctuation: p.grey2,
      tag: p.orange,
      attribute: p.yellow,
      heading: p.red,
      link: p.blue,
      regexp: p.yellow,
    },
    editor: {
      bg: p.bg0,
      lineNumber: p.grey0,
      lineNumberActive: p.fg,
      activeLineBg: p.bg1,
      selectionBg: blend(accent, p.bg0, 0.24),
      findMatchBg: p.bgYellow,
      findMatchActiveBg: blend(p.orange, p.bg0, 0.22),
      indentGuide: p.bg2,
    },
    badge: { bg: accent, fg: p.bgDim },
    scrollbar: { track: blend(p.bg1, p.bg0, 0.5), thumb: p.bg5 },
    terminal: {
      fg: p.fg,
      bg: p.bg0,
      cursor: p.fg,
      selectionBg: p.bg3,
      black: p.bg3,
      red: p.red,
      green: p.green,
      yellow: p.yellow,
      blue: p.blue,
      magenta: p.purple,
      cyan: p.aqua,
      white: p.grey2,
      brightBlack: p.grey0,
      brightRed: p.red,
      brightGreen: p.green,
      brightYellow: p.yellow,
      brightBlue: p.blue,
      brightMagenta: p.purple,
      brightCyan: p.aqua,
      brightWhite: p.fg,
    },
  }),
});
