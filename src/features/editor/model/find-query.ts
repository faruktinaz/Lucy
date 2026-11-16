/**
 * Compiles the in-file find query into a global JavaScript regular expression.
 *
 * Decisions (consistent with project search in `src/adapters/search/compile-query.ts`):
 * - Matching is per line; a pattern never matches across a line break (`\n` finds nothing).
 * - The `u` flag is used when the pattern allows it; regexes valid only without it fall back
 *   to legacy mode instead of being rejected.
 * - Whole word means "not preceded or followed by a letter, mark, digit or underscore" with
 *   Unicode classes, so "ığü" count as word characters (JavaScript's `\b` is ASCII-only).
 *
 * Case-insensitive matching and Turkish text:
 * - JavaScript's `i` flag uses Unicode simple case folding, which is locale-independent and
 *   leaves dotted capital "İ" (U+0130) and dotless "ı" (U+0131) matching only themselves. A
 *   Turkish reader expects "istanbul" to find "İstanbul" and "ışık" to find "IŞIK", while an
 *   English reader expects "file" to find "FILE". No single locale rule satisfies both, so a
 *   plain-text query treats the four letters i, I, İ, ı as one letter when case is ignored.
 *   That only ever adds matches, never loses one, and keeps every match the same length as
 *   the text it covers (columns stay exact). Other letters fold as usual ("ş" finds "Ş",
 *   "ç" finds "Ç"); accents are never ignored ("s" does not find "ş").
 * - Regex queries keep JavaScript's rules unchanged (rewriting letters inside a user's regex
 *   would break group names and escapes), so "/istanbul/i" does not find "İstanbul".
 * - Matches never change length: "ß" does not find "SS" (full case folding would).
 */

export interface FindOptions {
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly regex: boolean;
}

export const DEFAULT_FIND_OPTIONS: FindOptions = Object.freeze({
  caseSensitive: false,
  wholeWord: false,
  regex: false,
});

export type CompiledFindQuery =
  | { readonly kind: "empty" }
  | { readonly kind: "invalid"; readonly message: string }
  | {
      readonly kind: "ok";
      readonly source: string;
      readonly flags: string;
      /** True for user regexes: they may backtrack catastrophically and need the guarded engine. */
      readonly untrusted: boolean;
    };

const TURKISH_I = new Set(["i", "I", "İ", "ı"]);
const TURKISH_I_CLASS = "[iIİı]";

/** Escapes a literal for a `u`-mode regex (escaping "-" would be a syntax error there). */
function escapeChar(char: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(char) ? `\\${char}` : char;
}

function literalSource(text: string, caseSensitive: boolean): string {
  let out = "";
  for (const char of text) out += !caseSensitive && TURKISH_I.has(char) ? TURKISH_I_CLASS : escapeChar(char);
  return out;
}

function wrapWholeWord(source: string, unicode: boolean): string {
  return unicode
    ? `(?<![\\p{L}\\p{M}\\p{N}_])(?:${source})(?![\\p{L}\\p{M}\\p{N}_])`
    : `(?<![A-Za-z0-9_])(?:${source})(?![A-Za-z0-9_])`;
}

function regexErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Engines prefix the pattern ("Invalid regular expression: /(/gu: ..."); the user sees it already.
  const detail = raw.replace(/^Invalid regular expression:\s*/i, "").replace(/^\/.*\/[a-z]*:\s*/s, "");
  return `Invalid regular expression: ${detail || "syntax error"}`;
}

function tryCompile(source: string, flags: string): string | null {
  try {
    new RegExp(source, flags);
    return null;
  } catch (error) {
    return regexErrorMessage(error);
  }
}

export function compileFindQuery(query: string, options: FindOptions): CompiledFindQuery {
  if (query === "") return { kind: "empty" };
  const base = options.caseSensitive ? "g" : "gi";
  if (!options.regex) {
    const literal = literalSource(query, options.caseSensitive);
    const source = options.wholeWord ? wrapWholeWord(literal, true) : literal;
    const error = tryCompile(source, `${base}u`);
    // A literal always compiles; reaching this means a bug in escaping, so report it plainly.
    return error
      ? { kind: "invalid", message: error }
      : { kind: "ok", source, flags: `${base}u`, untrusted: false };
  }
  const unicodeSource = options.wholeWord ? wrapWholeWord(query, true) : query;
  const unicodeError = tryCompile(unicodeSource, `${base}u`);
  if (unicodeError === null) return { kind: "ok", source: unicodeSource, flags: `${base}u`, untrusted: true };
  const legacySource = options.wholeWord ? wrapWholeWord(query, false) : query;
  if (tryCompile(legacySource, base) === null) {
    return { kind: "ok", source: legacySource, flags: base, untrusted: true };
  }
  return { kind: "invalid", message: unicodeError };
}
