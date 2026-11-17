/**
 * The conservative fallback for files nobody recognizes: it colors only what is unambiguous in
 * any text, namely URLs, quoted strings that open and close on the same line, and standalone
 * numbers. No comments, no keywords: prose must never turn into a wall of color.
 *
 * Guards against prose: a single quote or backtick opens a string only when it does not follow a
 * letter or digit and closes only when no letter or digit follows (so "don't" and "users' files"
 * stay plain); strings longer than 200 characters are ignored; a number glued to a letter
 * ("v2", "3rd", "mp3") is not a number.
 */
import type { HighlightRange } from "../types";

const URL = /\b(?:https?|ftp|file):\/\/[^\s<>"'`)\]}]+[^\s<>"'`)\]}.,;:!?]/y;
const NUMBER = /\d+(?:[.,:]\d+)*(?![\p{L}\p{N}_])/uy;
const MAX_STRING = 200;

function isWordCode(code: number): boolean {
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    (code >= 48 && code <= 57) ||
    code === 95 ||
    code > 127
  );
}

export function tokenizeText(text: string): HighlightRange[] {
  const out: HighlightRange[] = [];
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    const previous = i > 0 ? text.charCodeAt(i - 1) : 32;

    if ((code === 104 || code === 102) && !isWordCode(previous)) {
      URL.lastIndex = i;
      const match = URL.exec(text);
      if (match) {
        out.push({ start: i, end: i + match[0].length, group: "string.special.url" });
        i += match[0].length;
        continue;
      }
    }

    if (code === 34 || ((code === 39 || code === 96) && !isWordCode(previous))) {
      const quote = text[i] ?? "";
      let j = i + 1;
      let end = -1;
      while (j < text.length && j - i <= MAX_STRING) {
        const char = text[j];
        if (char === "\n") break;
        if (char === "\\") {
          j += 2;
          continue;
        }
        if (char === quote && (code === 34 || !isWordCode(text.charCodeAt(j + 1) || 32))) {
          end = j + 1;
          break;
        }
        j++;
      }
      if (end > i + 1) {
        out.push({ start: i, end, group: "string" });
        i = end;
        continue;
      }
      i++;
      continue;
    }

    if (code >= 48 && code <= 57 && !isWordCode(previous) && previous !== 46) {
      NUMBER.lastIndex = i;
      const match = NUMBER.exec(text);
      if (match) {
        out.push({ start: i, end: i + match[0].length, group: "number" });
        i += match[0].length;
        continue;
      }
    }

    // Skip the rest of a word so nothing starts inside it.
    if (isWordCode(code)) {
      while (i < text.length && isWordCode(text.charCodeAt(i))) i++;
      continue;
    }
    i++;
  }
  return out;
}
