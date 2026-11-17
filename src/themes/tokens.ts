/**
 * The semantic design tokens. Components may use ONLY these; hex literals live only in
 * theme files. Tokens are named by role ("what is this color for"), never by hue, so a
 * theme can map them freely and a component never has to know which theme is active.
 *
 * This table is the single source of truth: the `ThemeTokens` type, the "every theme
 * defines every token" test and the design documentation are all derived from it.
 */
export const TOKEN_DEFINITIONS = {
  bg: {
    canvas: "Backdrop behind the panels: the darkest layer. Panels sit on it as separate cards.",
    base: "Editor area and the main card surface. Everything else is layered relative to it.",
    surface: "Chrome: sidebar, status bar, tab strip, panel headers.",
    raised: "Elevated elements inside base or surface: buttons, chips, inactive tabs on hover.",
    overlay: "Floating layers: command palette, menus, dialogs, toasts, tooltips.",
    inset: "Sunken fields: text inputs, search boxes, the commit message editor; the activity bar column.",
  },
  fg: {
    default: "Body text and primary labels.",
    muted: "Secondary text: descriptions, paths beside file names, inactive tabs.",
    subtle: "Tertiary text: placeholders, hints, keybinding labels. Never for content.",
    onAccent: "Text and icons drawn on accent.primary (primary buttons, badges).",
    disabled: "Disabled controls. Exempt from WCAG minimums, still kept legible.",
  },
  border: {
    subtle: "Dividers between regions. Low density by design.",
    default: "Borders that define a control: inputs, overlays, cards.",
    focus: "Border of the focused control or panel.",
  },
  accent: {
    primary: "Brand and focus color: active indicators, links, primary actions.",
    secondary: "Second emphasis color for rare highlights (AI, special states).",
  },
  state: {
    hover: "Background of a hovered row or control.",
    active: "Background of a pressed control or the active item of a group.",
    selectedBg: "Background of the selected row in the focused list or tree.",
    selectedFg: "Text on selectedBg.",
    selectedInactiveBg: "Selected row in a list that does not have focus.",
    focusRing: "Outline or marker that shows keyboard focus.",
  },
  status: {
    success: "Success messages and passing checks.",
    warning: "Warnings and attention states.",
    error: "Errors, failures and destructive actions.",
    info: "Neutral information and progress.",
  },
  git: {
    added: "Staged new files and added lines in gutters.",
    modified: "Modified files.",
    deleted: "Deleted files.",
    renamed: "Renamed or copied files.",
    untracked: "Untracked files.",
    conflicted: "Files with merge conflicts.",
    ignored: "Ignored files. Deliberately quiet, still 3:1.",
  },
  diff: {
    addedLineBg: "Background of an added line. A subtle tint, never a loud block.",
    removedLineBg: "Background of a removed line.",
    addedWordBg: "Changed characters inside an added line.",
    removedWordBg: "Changed characters inside a removed line.",
    addedFg: "+ marker and added text when not syntax highlighted.",
    removedFg: "- marker and removed text when not syntax highlighted.",
    hunkHeaderBg: "Background of a hunk header (@@ ... @@).",
    hunkHeaderFg: "Text of a hunk header.",
    contextFg: "Unchanged context lines when not syntax highlighted.",
  },
  syntax: {
    keyword: "Language keywords and storage modifiers.",
    string: "String literals.",
    number: "Numeric literals.",
    comment: "Comments. The quietest syntax color (see the contrast policy).",
    function: "Function and method names.",
    type: "Types, classes, interfaces.",
    variable: "Variables and identifiers.",
    parameter: "Function parameters.",
    constant: "Constants, booleans, null.",
    property: "Object properties and fields.",
    operator: "Operators.",
    punctuation: "Brackets, delimiters, separators.",
    tag: "Markup tags (HTML, JSX, XML).",
    attribute: "Markup attributes.",
    heading: "Markdown headings.",
    link: "URLs and Markdown links.",
    regexp: "Regular expressions and escape sequences.",
  },
  editor: {
    bg: "Code viewer background.",
    lineNumber: "Inactive line numbers. Deliberately quiet (see the contrast policy).",
    lineNumberActive: "The cursor line's number.",
    activeLineBg: "Background of the cursor line.",
    selectionBg: "Selected text background.",
    findMatchBg: "Other find matches.",
    findMatchActiveBg: "The current find match.",
    indentGuide: "Indentation guides. Decorative.",
  },
  badge: {
    bg: "Count badges (changes in Source Control, problems).",
    fg: "Text on badge.bg.",
  },
  scrollbar: {
    track: "Scrollbar track.",
    thumb: "Scrollbar thumb.",
  },
  terminal: {
    fg: "Embedded terminal default foreground.",
    bg: "Embedded terminal default background.",
    cursor: "Embedded terminal cursor.",
    selectionBg: "Embedded terminal selection.",
    black: "ANSI 0.",
    red: "ANSI 1.",
    green: "ANSI 2.",
    yellow: "ANSI 3.",
    blue: "ANSI 4.",
    magenta: "ANSI 5.",
    cyan: "ANSI 6.",
    white: "ANSI 7.",
    brightBlack: "ANSI 8.",
    brightRed: "ANSI 9.",
    brightGreen: "ANSI 10.",
    brightYellow: "ANSI 11.",
    brightBlue: "ANSI 12.",
    brightMagenta: "ANSI 13.",
    brightCyan: "ANSI 14.",
    brightWhite: "ANSI 15.",
  },
} as const;

type Definitions = typeof TOKEN_DEFINITIONS;

export type TokenGroup = keyof Definitions;

/** Every theme provides a hex string for every token. */
export type ThemeTokens = {
  readonly [G in TokenGroup]: { readonly [K in keyof Definitions[G]]: string };
};

/** Dotted path of a token, e.g. `"bg.surface"` or `"syntax.keyword"`. */
export type TokenPath = {
  [G in TokenGroup]: `${G}.${keyof Definitions[G] & string}`;
}[TokenGroup];

/** ANSI index order of the terminal palette tokens (index = ANSI color number). */
export const TERMINAL_ANSI_ORDER = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const satisfies readonly (keyof Definitions["terminal"])[];

/** All token paths in definition order. */
export function tokenPaths(): TokenPath[] {
  const out: TokenPath[] = [];
  for (const [group, names] of Object.entries(TOKEN_DEFINITIONS)) {
    for (const name of Object.keys(names)) out.push(`${group}.${name}` as TokenPath);
  }
  return out;
}

/** Human-readable role of a token, for docs and the theme preview screen. */
export function tokenDescription(path: TokenPath): string {
  const [group, name] = path.split(".") as [TokenGroup, string];
  return (TOKEN_DEFINITIONS[group] as Record<string, string>)[name] ?? "";
}

export function getToken(tokens: ThemeTokens, path: TokenPath): string {
  const [group, name] = path.split(".") as [TokenGroup, string];
  const value = (tokens[group] as Record<string, string | undefined>)[name];
  if (value === undefined) throw new Error(`Theme is missing token ${path}`);
  return value;
}

/** Returns a copy of `tokens` with one token replaced. */
export function withToken(tokens: ThemeTokens, path: TokenPath, value: string): ThemeTokens {
  const [group, name] = path.split(".") as [TokenGroup, string];
  return { ...tokens, [group]: { ...tokens[group], [name]: value } } as ThemeTokens;
}

/** Applies `fn` to every token, preserving the shape. */
export function mapTokens(tokens: ThemeTokens, fn: (value: string, path: TokenPath) => string): ThemeTokens {
  const out: Record<string, Record<string, string>> = {};
  for (const [group, names] of Object.entries(tokens) as [string, Record<string, string>][]) {
    const mapped: Record<string, string> = {};
    for (const [name, value] of Object.entries(names)) {
      mapped[name] = fn(value, `${group}.${name}` as TokenPath);
    }
    out[group] = mapped;
  }
  return out as unknown as ThemeTokens;
}
