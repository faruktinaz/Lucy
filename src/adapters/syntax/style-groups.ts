/**
 * Highlight groups (Tree-sitter capture names) and their mapping onto Lucy's semantic syntax
 * tokens. The UI layer builds an OpenTUI `SyntaxStyle` from theme tokens with this module and
 * never needs to know capture names:
 *
 *   SyntaxStyle.fromStyles(Object.fromEntries(STYLE_GROUPS.map((group) =>
 *     [group, styleForToken(syntaxGroupToToken(group)!)])), owner)
 *
 * OpenTUI resolves a group by its exact name and then by its FIRST segment only
 * (`markup.heading.1` falls back to `markup`, never to `markup.heading`). `syntaxGroupToToken`
 * applies exactly the same rule over the same table, so a `SyntaxStyle` built from
 * `STYLE_GROUPS` colors `<code>` identically to views that render `tokenizeLines` output.
 */

/** The fifteen core tokens every theme defines. */
export const CORE_SYNTAX_TOKENS = [
  "keyword",
  "string",
  "number",
  "comment",
  "function",
  "type",
  "variable",
  "constant",
  "property",
  "operator",
  "punctuation",
  "tag",
  "attribute",
  "heading",
  "link",
] as const;

/** Finer roles. A theme may omit them; see `SYNTAX_TOKEN_FALLBACKS`. */
export const EXTENDED_SYNTAX_TOKENS = [
  "parameter",
  "regexp",
  "emphasis",
  "strong",
  "code",
  "list",
  "quote",
  "strikethrough",
] as const;

export const SYNTAX_TOKENS = [...CORE_SYNTAX_TOKENS, ...EXTENDED_SYNTAX_TOKENS] as const;

export type CoreSyntaxTokenName = (typeof CORE_SYNTAX_TOKENS)[number];
export type ExtendedSyntaxTokenName = (typeof EXTENDED_SYNTAX_TOKENS)[number];
export type SyntaxTokenName = (typeof SYNTAX_TOKENS)[number];

/**
 * What to use when a theme has no color for an extended token. `null` means "default
 * foreground": emphasis and strong are carried by text attributes, not color.
 */
export const SYNTAX_TOKEN_FALLBACKS: Readonly<Record<ExtendedSyntaxTokenName, CoreSyntaxTokenName | null>> = {
  parameter: "variable",
  regexp: "string",
  emphasis: null,
  strong: null,
  code: "string",
  list: "punctuation",
  quote: "comment",
  strikethrough: "comment",
};

export interface SyntaxTextAttributes {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
}

/** Attributes that carry meaning on their own (they matter even in a monochrome theme). */
export const SYNTAX_TOKEN_ATTRIBUTES: Readonly<Partial<Record<SyntaxTokenName, SyntaxTextAttributes>>> = {
  heading: { bold: true },
  strong: { bold: true },
  emphasis: { italic: true },
  link: { underline: true },
  strikethrough: { strikethrough: true },
};

/**
 * Every group name with an entry here is a group the UI must register. Deeper names are
 * listed explicitly when their meaning differs from their first segment, because OpenTUI
 * would otherwise fall back to that first segment. A list of pairs rather than an object
 * literal, so names such as `constructor` or `toString` can never hit `Object.prototype`.
 */
const GROUP_TOKEN_ENTRIES: readonly (readonly [string, SyntaxTokenName])[] = [
  ["keyword", "keyword"],

  ["string", "string"],
  ["string.escape", "regexp"],
  ["string.regexp", "regexp"],
  ["string.special.url", "link"],
  ["string.special.key", "property"],
  ["string.special.symbol", "constant"],
  ["character", "string"],
  ["character.special", "regexp"],

  ["number", "number"],
  ["boolean", "constant"],
  ["constant", "constant"],
  ["label", "constant"],

  ["comment", "comment"],

  ["function", "function"],
  ["method", "function"],
  ["constructor", "type"],

  ["type", "type"],
  ["module", "type"],
  ["namespace", "type"],

  ["variable", "variable"],
  ["variable.parameter", "parameter"],
  ["variable.member", "property"],
  ["parameter", "parameter"],

  ["property", "property"],
  ["field", "property"],

  ["operator", "operator"],
  ["punctuation", "punctuation"],

  ["tag", "tag"],
  ["tag.attribute", "attribute"],
  ["tag.delimiter", "punctuation"],
  ["attribute", "attribute"],

  ["markup.heading", "heading"],
  ["markup.heading.1", "heading"],
  ["markup.heading.2", "heading"],
  ["markup.heading.3", "heading"],
  ["markup.heading.4", "heading"],
  ["markup.heading.5", "heading"],
  ["markup.heading.6", "heading"],
  ["markup.strong", "strong"],
  ["markup.italic", "emphasis"],
  ["markup.emphasis", "emphasis"],
  ["markup.underline", "emphasis"],
  ["markup.strikethrough", "strikethrough"],
  ["markup.raw", "code"],
  ["markup.raw.block", "code"],
  ["markup.math", "code"],
  ["markup.link", "link"],
  ["markup.link.label", "link"],
  ["markup.link.url", "link"],
  ["markup.link.bracket.close", "punctuation"],
  ["markup.list", "list"],
  ["markup.list.checked", "list"],
  ["markup.list.unchecked", "list"],
  ["markup.quote", "quote"],
];

const GROUP_TOKEN_MAP: ReadonlyMap<string, SyntaxTokenName> = new Map(GROUP_TOKEN_ENTRIES);

/** Canonical list of highlight group names to register in an OpenTUI `SyntaxStyle`. */
export const STYLE_GROUPS: readonly string[] = Object.freeze([...GROUP_TOKEN_MAP.keys()]);

/**
 * Maps a capture group to a syntax token with OpenTUI's own resolution rule (exact name, then
 * first segment). Returns `null` for groups that are never colored: `spell`, `none`,
 * `conceal`, private `_captures`, `embedded`, a bare `markup`, and unknown names.
 */
export function syntaxGroupToToken(group: string): SyntaxTokenName | null {
  const exact = GROUP_TOKEN_MAP.get(group);
  if (exact !== undefined) return exact;
  const dot = group.indexOf(".");
  if (dot === -1) return null;
  return GROUP_TOKEN_MAP.get(group.slice(0, dot)) ?? null;
}

/** Number of dot-separated segments; OpenTUI lets the more specific group win an overlap. */
export function groupSpecificity(group: string): number {
  let count = 1;
  for (let i = 0; i < group.length; i++) if (group.charCodeAt(i) === 46) count++;
  return count;
}
