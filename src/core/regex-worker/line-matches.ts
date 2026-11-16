/**
 * The synchronous scanning core shared by the regex worker and the in-thread scanners. No
 * imports on purpose: the worker loads this file on its own.
 */

/** One match on one line; `start`/`end` are UTF-16 columns into the line (end exclusive). */
export interface LineMatch {
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Appends the matches of `regex` (global) in `text` to `out` until `out.length` reaches
 * `limit`. Zero-length matches are reported (a `^` search counts lines, as in VS Code) and the
 * scan steps past them by a whole code point in Unicode mode, so a surrogate pair is never split.
 */
export function collectLineMatches(
  regex: RegExp,
  text: string,
  line: number,
  out: LineMatch[],
  limit: number,
): void {
  regex.lastIndex = 0;
  while (out.length < limit) {
    const match = regex.exec(text);
    if (match === null) break;
    const start = match.index;
    const end = start + match[0].length;
    out.push({ line, start, end });
    if (end === start) {
      if (start >= text.length) break;
      regex.lastIndex = start + (regex.unicode && isHighSurrogate(text.charCodeAt(start)) ? 2 : 1);
    }
  }
  regex.lastIndex = 0;
}
