/**
 * The contrast policy, as data. The test suite asserts every requirement for every theme,
 * and the same table can drive a theme-authoring report, so the policy cannot drift from
 * what is enforced.
 *
 * Thresholds are WCAG 2.x ratios. `AA` applies to regular themes and `AAA` to themes that
 * declare `contrastLevel: "AAA"` (High Contrast), which also raises the floor for secondary
 * and decorative text because a high-contrast theme must not rely on dim text.
 */
import { contrastRatio } from "./color";
import type { Theme } from "./theme";
import { getToken, type TokenPath } from "./tokens";

export interface ContrastRequirement {
  fg: TokenPath;
  bg: TokenPath;
  AA: number;
  AAA: number;
  /** Why this pair matters, shown in failure messages and docs. */
  role: string;
}

const BODY = { AA: 4.5, AAA: 7 } as const;
const UI = { AA: 3, AAA: 4.5 } as const;

function pairs(
  fgs: readonly TokenPath[],
  bgs: readonly TokenPath[],
  levels: { AA: number; AAA: number },
  role: string,
): ContrastRequirement[] {
  return fgs.flatMap((fg) => bgs.map((bg) => ({ fg, bg, ...levels, role })));
}

const SYNTAX_EXCEPT_COMMENT: TokenPath[] = [
  "syntax.keyword",
  "syntax.string",
  "syntax.number",
  "syntax.function",
  "syntax.type",
  "syntax.variable",
  "syntax.parameter",
  "syntax.constant",
  "syntax.property",
  "syntax.operator",
  "syntax.punctuation",
  "syntax.tag",
  "syntax.attribute",
  "syntax.heading",
  "syntax.link",
  "syntax.regexp",
];

const UI_COLORS: TokenPath[] = [
  "accent.primary",
  "accent.secondary",
  "border.focus",
  "state.focusRing",
  "status.success",
  "status.warning",
  "status.error",
  "status.info",
  "git.added",
  "git.modified",
  "git.deleted",
  "git.renamed",
  "git.untracked",
  "git.conflicted",
  "git.ignored",
];

const TERMINAL_COLORS: TokenPath[] = [
  "terminal.red",
  "terminal.green",
  "terminal.yellow",
  "terminal.blue",
  "terminal.magenta",
  "terminal.cyan",
  "terminal.white",
  "terminal.brightRed",
  "terminal.brightGreen",
  "terminal.brightYellow",
  "terminal.brightBlue",
  "terminal.brightMagenta",
  "terminal.brightCyan",
  "terminal.brightWhite",
];

export const CONTRAST_REQUIREMENTS: readonly ContrastRequirement[] = [
  ...pairs(
    ["fg.default"],
    ["bg.base", "bg.surface", "bg.raised", "bg.overlay", "bg.inset"],
    BODY,
    "body text on every background",
  ),
  ...pairs(["fg.muted"], ["bg.base", "bg.surface", "bg.overlay"], BODY, "secondary text"),
  ...pairs(["fg.subtle"], ["bg.base", "bg.surface", "bg.overlay"], UI, "hints and placeholders"),
  ...pairs(["fg.default"], ["state.hover", "state.selectedInactiveBg", "state.active"], BODY, "text on rows"),
  ...pairs(["state.selectedFg"], ["state.selectedBg"], BODY, "selected row text"),
  ...pairs(["fg.onAccent"], ["accent.primary"], BODY, "text on accent"),
  ...pairs(["badge.fg"], ["badge.bg"], BODY, "badge text"),
  ...pairs(UI_COLORS, ["bg.base", "bg.surface"], UI, "accent, status and git colors"),
  ...pairs(
    ["fg.default", "diff.addedFg"],
    ["diff.addedLineBg", "diff.addedWordBg"],
    BODY,
    "text on added lines",
  ),
  ...pairs(
    ["fg.default", "diff.removedFg"],
    ["diff.removedLineBg", "diff.removedWordBg"],
    BODY,
    "text on removed lines",
  ),
  ...pairs(["diff.hunkHeaderFg"], ["diff.hunkHeaderBg"], BODY, "hunk headers"),
  ...pairs(["diff.contextFg"], ["editor.bg"], BODY, "diff context lines"),
  ...pairs(SYNTAX_EXCEPT_COMMENT, ["editor.bg"], BODY, "syntax colors on the editor"),
  ...pairs(SYNTAX_EXCEPT_COMMENT, ["editor.activeLineBg"], UI, "syntax colors on the cursor line"),
  // Comments are intentionally the quietest syntax color, but must stay readable.
  ...pairs(["syntax.comment"], ["editor.bg"], { AA: 3.5, AAA: 4.5 }, "comments"),
  ...pairs(["syntax.comment"], ["editor.activeLineBg"], UI, "comments on the cursor line"),
  ...pairs(
    ["fg.default"],
    ["editor.activeLineBg", "editor.selectionBg", "editor.findMatchBg", "editor.findMatchActiveBg"],
    BODY,
    "code on editor highlights",
  ),
  ...pairs(["editor.lineNumberActive"], ["editor.bg", "editor.activeLineBg"], BODY, "active line number"),
  // Inactive line numbers are deliberately quiet: they are reference marks, not content.
  ...pairs(["editor.lineNumber"], ["editor.bg"], { AA: 2.5, AAA: 4.5 }, "inactive line numbers"),
  ...pairs(["border.default"], ["bg.base", "bg.surface"], { AA: 1.3, AAA: 4.5 }, "control borders"),
  ...pairs(["border.subtle"], ["bg.base"], { AA: 1.15, AAA: 3 }, "dividers"),
  ...pairs(["scrollbar.thumb"], ["scrollbar.track"], { AA: 1.8, AAA: 3 }, "scrollbar thumb"),
  ...pairs(["terminal.fg"], ["terminal.bg", "terminal.selectionBg"], BODY, "terminal text"),
  ...pairs(TERMINAL_COLORS, ["terminal.bg"], UI, "terminal ANSI colors"),
  // ANSI 8 is conventionally used for de-emphasized text (shell autosuggestions).
  ...pairs(["terminal.brightBlack"], ["terminal.bg"], { AA: 2, AAA: 4.5 }, "dim terminal text"),
];

export interface ContrastResult extends ContrastRequirement {
  ratio: number;
  min: number;
  pass: boolean;
}

/** Measures every requirement for a theme at its declared contrast level. */
export function auditContrast(theme: Pick<Theme, "tokens" | "contrastLevel">): ContrastResult[] {
  return CONTRAST_REQUIREMENTS.map((req) => {
    const ratio = contrastRatio(getToken(theme.tokens, req.fg), getToken(theme.tokens, req.bg));
    const min = theme.contrastLevel === "AAA" ? req.AAA : req.AA;
    return { ...req, ratio, min, pass: ratio >= min };
  });
}
