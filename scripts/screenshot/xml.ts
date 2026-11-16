/** Escaping shared by the SVG and HTML emitters. */

/** U+FFFD, written as a code point so formatters cannot turn it into an invisible literal. */
export const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);

/**
 * True for characters XML 1.0 forbids even when escaped: C0 controls other than tab, LF and
 * CR, lone surrogates and the non-characters U+FFFE/U+FFFF. A terminal frame can contain them,
 * and a single one makes the whole SVG unparsable.
 */
function isInvalidXml(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
    (code >= 0xd800 && code <= 0xdfff) ||
    code === 0xfffe ||
    code === 0xffff
  );
}

/** Escapes text for element content and attribute values (single or double quoted). */
export function escapeXml(text: string): string {
  let out = "";
  // for...of walks code points; a lone surrogate comes through as a single unit.
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (isInvalidXml(code)) out += REPLACEMENT_CHARACTER;
    else if (char === "&") out += "&amp;";
    else if (char === "<") out += "&lt;";
    else if (char === ">") out += "&gt;";
    else if (char === '"') out += "&quot;";
    else if (char === "'") out += "&#39;";
    else out += char;
  }
  return out;
}

/** Compact number formatting for coordinates (at most two decimals, no trailing zeros). */
export function num(value: number): string {
  return String(Math.round(value * 100) / 100);
}
