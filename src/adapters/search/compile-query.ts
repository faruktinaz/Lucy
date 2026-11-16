/**
 * Turns a `ContentSearchQuery` into the pieces every engine needs: resolved case
 * sensitivity, canonical include/exclude globs, and a JavaScript matcher used by the
 * builtin engine and to compute highlight ranges for `git grep` output.
 *
 * JavaScript regex decisions: the `u` flag is used when the pattern allows it (Unicode-aware
 * case folding, `\p{...}`); patterns that are only valid without it fall back to legacy
 * mode. Whole word means "not preceded or followed by a letter, digit or underscore", with
 * Unicode letters (so "ığü" are word characters, unlike in `\b`).
 */
import { type ContentSearchQuery, InvalidPatternError } from "./search-types";

export interface CompiledQuery {
  readonly pattern: string;
  readonly isRegex: boolean;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly maxResults: number;
  /** Canonical globs (see `canonicalGlobs`). */
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  /** Global JavaScript matcher, or `null` when the pattern is not valid JavaScript syntax. */
  readonly regex: RegExp | null;
  /** Why `regex` is null. */
  readonly regexError: string | null;
}

export const DEFAULT_MAX_RESULTS = 2000;

/** Uppercase letters outside escape sequences (`\W`, `\p{Lu}` do not count in a regex). */
export function hasUppercase(pattern: string, isRegex: boolean): boolean {
  const text = isRegex ? pattern.replace(/\\[pP]\{[^}]*\}|\\./g, "") : pattern;
  for (const char of text) if (char !== char.toLowerCase()) return true;
  return false;
}

/** Escapes a literal for a `u`-mode regex (where escaping "-" would be a syntax error). */
export function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

/**
 * `.gitignore`-style globs to root-anchored globs: "x" becomes "**\/x" and "**\/x/**",
 * "a/b" or "/x" become "a/b" + "a/b/**" and "x" + "x/**". A trailing "/" is dropped.
 */
export function canonicalGlobs(patterns: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of patterns ?? []) {
    let glob = raw.trim();
    // As in .gitignore, a leading "/" (or "./") anchors the glob to the root.
    let anchored = false;
    while (glob.startsWith("./") || glob.startsWith("/")) {
      glob = glob.slice(glob.startsWith("./") ? 2 : 1);
      anchored = true;
    }
    while (glob.endsWith("/")) glob = glob.slice(0, -1);
    if (glob === "" || glob === "**") continue;
    const base = anchored || glob.includes("/") ? glob : `**/${glob}`;
    out.push(base);
    if (!base.endsWith("/**")) out.push(`${base}/**`);
  }
  return [...new Set(out)];
}

/** Path predicate for canonical include/exclude globs. */
export function createPathFilter(
  include: readonly string[],
  exclude: readonly string[],
): (path: string) => boolean {
  const inc = include.map((glob) => new Bun.Glob(glob));
  const exc = exclude.map((glob) => new Bun.Glob(glob));
  return (path) => {
    if (inc.length > 0 && !inc.some((glob) => glob.match(path))) return false;
    return !exc.some((glob) => glob.match(path));
  };
}

function buildRegex(
  source: string,
  caseSensitive: boolean,
  wholeWord: boolean,
): { regex: RegExp | null; error: string | null } {
  const flags = caseSensitive ? "g" : "gi";
  try {
    const body = wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])` : source;
    return { regex: new RegExp(body, `${flags}u`), error: null };
  } catch (unicodeError) {
    try {
      const body = wholeWord ? `(?<![A-Za-z0-9_])(?:${source})(?![A-Za-z0-9_])` : source;
      return { regex: new RegExp(body, flags), error: null };
    } catch {
      const message = unicodeError instanceof Error ? unicodeError.message : String(unicodeError);
      return { regex: null, error: message.replace(/^Invalid regular expression: /, "") };
    }
  }
}

export function compileQuery(query: ContentSearchQuery): CompiledQuery {
  const isRegex = query.isRegex ?? false;
  const mode = query.caseMode ?? "smart";
  const caseSensitive = mode === "sensitive" || (mode === "smart" && hasUppercase(query.pattern, isRegex));
  const wholeWord = query.wholeWord ?? false;
  const { regex, error } =
    query.pattern === ""
      ? { regex: null, error: null }
      : buildRegex(isRegex ? query.pattern : escapeRegExp(query.pattern), caseSensitive, wholeWord);
  return {
    pattern: query.pattern,
    isRegex,
    caseSensitive,
    wholeWord,
    maxResults: Math.max(1, Math.floor(query.maxResults ?? DEFAULT_MAX_RESULTS)),
    include: canonicalGlobs(query.include),
    exclude: canonicalGlobs(query.exclude),
    regex,
    regexError: error,
  };
}

/** The JavaScript matcher, or the typed error engines that need it must raise. */
export function requireRegex(query: CompiledQuery): RegExp {
  if (query.regex) return query.regex;
  throw new InvalidPatternError(query.pattern, query.regexError ?? "unsupported pattern");
}

/** All match ranges of `regex` in `text` (zero-length matches included, at most `limit`). */
export function findRanges(regex: RegExp, text: string, limit = 1000): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  regex.lastIndex = 0;
  for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
    out.push([match.index, match.index + match[0].length]);
    if (out.length >= limit) break;
    if (match[0].length === 0) regex.lastIndex = match.index + 1;
  }
  regex.lastIndex = 0;
  return out;
}
