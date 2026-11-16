/**
 * Locale-independent, length-preserving case and accent folding for matching file names.
 *
 * Decisions (shared by the explorer filter and the fuzzy matcher):
 * - Folding works per UTF-16 code unit and never changes string length, so match positions
 *   map 1:1 back to the original string. `String#toLowerCase` cannot be used on whole
 *   strings because "İ".toLowerCase() is two code units.
 * - It is locale-independent: "I" always folds to "i", whatever the system locale is, so
 *   Turkish locale rules can never break plain ASCII matching.
 * - Turkish "İ" (U+0130) and "ı" (U+0131) both fold to ASCII "i", and Latin letters with
 *   diacritics fold to their base letter ("ş" -> "s", "Ç" -> "c"), like fzf's default
 *   normalization: typing "istanbul" finds "İstanbul.md". Callers add a small bonus for
 *   exact (unfolded) matches so "ş" still prefers "ş".
 * - Combining marks (decomposed NFD names, common on macOS) are left in place in candidates
 *   and removed from queries, so "s" + U+0327 matches a typed "ş" through its base letter.
 */

let table: Uint16Array | null = null;

function isLatinWithDiacritics(code: number): boolean {
  return (code >= 0x00c0 && code <= 0x024f) || (code >= 0x1e00 && code <= 0x1eff);
}

function buildTable(): Uint16Array {
  const out = new Uint16Array(65536);
  for (let code = 0; code < 65536; code++) {
    out[code] = code;
    if (code < 128) {
      if (code >= 65 && code <= 90) out[code] = code + 32;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdfff) continue;
    let char = String.fromCharCode(code);
    if (code === 0x0130 || code === 0x0131) {
      out[code] = 0x69; // "i"
      continue;
    }
    if (isLatinWithDiacritics(code)) {
      const decomposed = char.normalize("NFD");
      const base = decomposed.charCodeAt(0);
      if (decomposed.length > 1 && base < 128) char = decomposed.charAt(0);
    }
    const lower = char.toLowerCase();
    out[code] = lower.length === 1 ? lower.charCodeAt(0) : char.charCodeAt(0);
  }
  return out;
}

/** Folded code unit for `code` (see module docs). */
export function foldCode(code: number): number {
  if (code < 128) return code >= 65 && code <= 90 ? code + 32 : code;
  table ??= buildTable();
  return table[code] as number;
}

/** Same length as the input; position `i` of the result is the fold of position `i`. */
export function foldString(text: string): string {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 128 || (c >= 65 && c <= 90)) {
      ascii = false;
      break;
    }
  }
  if (ascii) return text;
  let out = "";
  for (let i = 0; i < text.length; i++) out += String.fromCharCode(foldCode(text.charCodeAt(i)));
  return out;
}

export function isCombiningMark(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x20d0 && code <= 0x20ff)
  );
}

/** Prepares user-typed text for matching: drops combining marks, then folds. */
export function foldQuery(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (!isCombiningMark(code)) out += String.fromCharCode(foldCode(code));
  }
  return out;
}
