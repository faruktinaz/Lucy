/**
 * Tokenizer for JSON, JSON with Comments and JSON5.
 *
 * Used instead of a Tree-sitter grammar because the only packaged JSON grammar
 * (`tree-sitter-json`) is on Bun's default trusted-dependency list, so installing it would run
 * its native install script (see README). JSON's lexical grammar is regular, so this is exact for
 * JSON and JSONC and close for JSON5. Groups match nvim-treesitter's JSON query.
 */
import type { HighlightRange } from "../types";

const NUMBER = /[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|Infinity|NaN)/y;
const IDENTIFIER = /[A-Za-z_$][\w$]*/y;

const Char = {
  Tab: 9,
  LineFeed: 10,
  CarriageReturn: 13,
  Space: 32,
  DoubleQuote: 34,
  SingleQuote: 39,
  Star: 42,
  Comma: 44,
  Slash: 47,
  Colon: 58,
  OpenBracket: 91,
  Backslash: 92,
  CloseBracket: 93,
  LowerU: 117,
  OpenBrace: 123,
  CloseBrace: 125,
} as const;

function isSpace(code: number): boolean {
  return code === Char.Space || code === Char.Tab || code === Char.LineFeed || code === Char.CarriageReturn;
}

/** End offset of a comment starting at `i`, or -1 when there is none. */
function commentEnd(text: string, i: number): number {
  if (text.charCodeAt(i) !== Char.Slash) return -1;
  const next = text.charCodeAt(i + 1);
  if (next === Char.Slash) {
    const newline = text.indexOf("\n", i + 2);
    return newline === -1 ? text.length : newline;
  }
  if (next === Char.Star) {
    const close = text.indexOf("*/", i + 2);
    return close === -1 ? text.length : close + 2;
  }
  return -1;
}

/** True when the next significant character after `i` (skipping blanks and comments) is `:`. */
function followedByColon(text: string, i: number): boolean {
  let at = i;
  while (at < text.length) {
    const code = text.charCodeAt(at);
    if (isSpace(code)) {
      at++;
      continue;
    }
    const end = commentEnd(text, at);
    if (end === -1) return code === Char.Colon;
    at = end;
  }
  return false;
}

export function tokenizeJson(text: string): HighlightRange[] {
  const out: HighlightRange[] = [];
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (isSpace(code)) {
      i++;
      continue;
    }

    const commentStop = commentEnd(text, i);
    if (commentStop !== -1) {
      out.push({ start: i, end: commentStop, group: "comment" });
      i = commentStop;
      continue;
    }

    if (code === Char.DoubleQuote || code === Char.SingleQuote) {
      const start = i;
      const escapes: HighlightRange[] = [];
      i++;
      while (i < text.length) {
        const c = text.charCodeAt(i);
        if (c === code) {
          i++;
          break;
        }
        // An unterminated string stops at the end of its line, like the parser would recover.
        if (c === Char.LineFeed) break;
        if (c === Char.Backslash) {
          const escapeEnd = text.charCodeAt(i + 1) === Char.LowerU ? Math.min(i + 6, text.length) : i + 2;
          escapes.push({ start: i, end: Math.min(escapeEnd, text.length), group: "string.escape" });
          i = escapeEnd;
          continue;
        }
        i++;
      }
      const end = Math.min(i, text.length);
      out.push({ start, end, group: followedByColon(text, end) ? "property" : "string" });
      for (const escaped of escapes) out.push(escaped);
      continue;
    }

    if (
      code === Char.OpenBrace ||
      code === Char.CloseBrace ||
      code === Char.OpenBracket ||
      code === Char.CloseBracket
    ) {
      out.push({ start: i, end: i + 1, group: "punctuation.bracket" });
      i++;
      continue;
    }
    if (code === Char.Comma || code === Char.Colon) {
      out.push({ start: i, end: i + 1, group: "punctuation.delimiter" });
      i++;
      continue;
    }

    NUMBER.lastIndex = i;
    const number = NUMBER.exec(text);
    if (number && number[0].length > 0) {
      out.push({ start: i, end: i + number[0].length, group: "number" });
      i += number[0].length;
      continue;
    }

    IDENTIFIER.lastIndex = i;
    const identifier = IDENTIFIER.exec(text);
    if (identifier) {
      const word = identifier[0];
      const end = i + word.length;
      if (followedByColon(text, end)) {
        // JSON5 allows unquoted keys.
        out.push({ start: i, end, group: "property" });
      } else if (word === "true" || word === "false") {
        out.push({ start: i, end, group: "boolean" });
      } else if (word === "null") {
        out.push({ start: i, end, group: "constant.builtin" });
      }
      i = end;
      continue;
    }

    i++;
  }
  return out;
}
