/**
 * Display-safe text helpers shared by every view.
 *
 * Repository content is untrusted: file names and file contents may contain control or
 * bidirectional-override characters. Everything rendered as a single-line label goes through
 * `sanitizeForDisplay` first; code shown line by line goes through `sanitizeLineForDisplay`.
 * Widths are terminal cell widths, not string lengths.
 */

/*
 * Characters that are replaced, besides C0 controls, DEL and C1 controls:
 * - Bidi controls: U+061C (Arabic letter mark), U+200E/U+200F (LRM/RLM), U+202A–U+202E
 *   (embeddings and overrides), U+2066–U+2069 (isolates). They reorder what is displayed
 *   ("Trojan Source").
 * - Invisible characters that make two different strings look identical: U+00AD (soft hyphen),
 *   U+180E (Mongolian vowel separator), U+200B (zero-width space), U+2060–U+2064 (word joiner
 *   and invisible operators), U+206A–U+206F (deprecated format controls), U+FEFF (zero-width
 *   no-break space / BOM), U+FFF9–U+FFFB (interlinear annotation).
 * - U+2028/U+2029 (line and paragraph separators), which some terminals treat as a newline.
 *
 * Deliberately kept: U+200C (zero-width non-joiner) and U+200D (zero-width joiner). The joiner
 * builds emoji sequences ("👩‍💻") and both are required for correct text in Persian, Hindi and
 * other scripts; removing them would corrupt legitimate names. Their spoofing potential is
 * limited to joining or separating glyphs that are already there.
 */
const FORMAT_CHARS = "­؜᠎​‎‏  ‪-‮⁠-⁤⁦-⁯﻿￹-￻";

const UNSAFE = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${FORMAT_CHARS}]`, "g");
// Same set without the tab, which `sanitizeLineForDisplay` handles separately.
const UNSAFE_IN_LINE = new RegExp(`[\\u0000-\\u0008\\u000a-\\u001f\\u007f-\\u009f${FORMAT_CHARS}]`, "g");

const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;
const ASCII_PRINTABLE_OR_TAB = /^[\x20-\x7e\t]*$/;

const REPLACEMENT = "�";

let segmenter: Intl.Segmenter | undefined;

function graphemes(text: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const out: string[] = [];
  for (const part of segmenter.segment(text)) out.push(part.segment);
  return out;
}

/**
 * Makes a string safe to draw on one terminal row: tabs become `tabWidth` spaces; other control
 * characters, bidi controls and the invisible characters listed above become U+FFFD.
 */
export function sanitizeForDisplay(text: string, tabWidth = 2): string {
  if (ASCII_PRINTABLE.test(text)) return text;
  return text.replace(UNSAFE, (char) => (char === "\t" ? " ".repeat(tabWidth) : REPLACEMENT));
}

/** Visible one-unit stand-in for an unsafe character inside a line of code. */
function lineStandIn(char: string): string {
  const code = char.charCodeAt(0);
  // C0 controls have Unicode "control pictures" (ESC shows as U+241B "␛"), DEL is U+2421 "␡".
  if (code < 0x20) return String.fromCharCode(0x2400 + code);
  if (code === 0x7f) return "\u2421";
  return REPLACEMENT;
}

export interface LineDisplayOptions {
  /**
   * Expand tabs to the next multiple of this many cells. Omit it (or pass 0) when the renderer
   * expands tabs itself (OpenTUI's `tabWidth`); tabs are then kept and offsets stay unchanged.
   */
  tabWidth?: number;
}

/**
 * Makes one line of file content (code viewer, diff) safe to draw. It must not contain a
 * newline; split lines first (a stray "\n" or "\r" inside is replaced like any other control).
 *
 * Offsets are preserved: every replaced character is a single UTF-16 unit and becomes exactly one
 * UTF-16 unit, so syntax-highlight ranges and match ranges computed on the original line stay
 * valid on the result. C0 controls become their control pictures (`␛` for ESC), DEL becomes `␡`,
 * and C1, bidi and invisible format characters become U+FFFD; surrogate pairs (emoji) and
 * U+200C/U+200D are untouched. The one exception is `tabWidth`: expanded tabs grow the line, so
 * map offsets with `lineDisplayOffset` when using it.
 */
export function sanitizeLineForDisplay(line: string, options: LineDisplayOptions = {}): string {
  const tabWidth = options.tabWidth ?? 0;
  if (ASCII_PRINTABLE_OR_TAB.test(line)) return tabWidth > 0 ? expandTabs(line, tabWidth) : line;
  const safe = line.replace(UNSAFE_IN_LINE, lineStandIn);
  return tabWidth > 0 ? expandTabs(safe, tabWidth) : safe;
}

/** Expands tabs to tab stops; columns count UTF-16 units, as `lineDisplayOffset` does. */
function expandTabs(line: string, tabWidth: number): string {
  if (!line.includes("\t")) return line;
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const char = line[i] as string;
    out += char === "\t" ? " ".repeat(tabWidth - (out.length % tabWidth)) : char;
  }
  return out;
}

/**
 * Where `offset` (a UTF-16 offset in the original line) lands in
 * `sanitizeLineForDisplay(line, { tabWidth })`. The identity without tab expansion.
 */
export function lineDisplayOffset(line: string, offset: number, tabWidth = 0): number {
  if (tabWidth <= 0) return offset;
  let column = 0;
  const end = Math.min(offset, line.length);
  for (let i = 0; i < end; i++) {
    column += line.charCodeAt(i) === 9 ? tabWidth - (column % tabWidth) : 1;
  }
  return column + Math.max(0, offset - end);
}

/** Width in terminal cells (wide CJK and emoji count as 2, combining marks as 0). */
export function displayWidth(text: string): number {
  if (ASCII_PRINTABLE.test(text)) return text.length;
  return Bun.stringWidth(text);
}

/**
 * Longest prefix of `parts` that fits in `width` cells, as the graphemes taken, their text
 * and the cells used. Callers that walk the string backwards reverse `taken` rather than
 * re-segmenting reversed text: concatenating graphemes in reverse order can merge them into
 * different clusters (regional-indicator flags, Hangul jamo), which would scramble the output.
 */
function takeWidth(parts: readonly string[], width: number): { taken: string[]; text: string; used: number } {
  let used = 0;
  const taken: string[] = [];
  for (const part of parts) {
    const w = Bun.stringWidth(part);
    if (used + w > width) break;
    used += w;
    taken.push(part);
  }
  return { taken, text: taken.join(""), used };
}

/** Cuts the end: `a-very-long-na…`. */
export function truncateEnd(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  const room = width - displayWidth(ellipsis);
  if (room <= 0) return takeWidth(graphemes(ellipsis), width).text;
  if (ASCII_PRINTABLE.test(text)) return text.slice(0, room) + ellipsis;
  return takeWidth(graphemes(text), room).text + ellipsis;
}

/** Cuts the start, keeping the tail visible: `…ponents/button.tsx`. Best for paths. */
export function truncateStart(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  const room = width - displayWidth(ellipsis);
  if (room <= 0) return takeWidth(graphemes(ellipsis), width).text;
  if (ASCII_PRINTABLE.test(text)) return ellipsis + text.slice(text.length - room);
  const tail = takeWidth(graphemes(text).reverse(), room).taken;
  return ellipsis + tail.reverse().join("");
}

/** Cuts the middle, keeping both ends: `src/featu…/index.ts`. */
export function truncateMiddle(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  const room = width - displayWidth(ellipsis);
  if (room <= 0) return takeWidth(graphemes(ellipsis), width).text;
  const parts = graphemes(text);
  const headRoom = Math.ceil(room / 2);
  const head = takeWidth(parts, headRoom);
  const tail = takeWidth([...parts].reverse(), room - head.used).taken;
  return head.text + ellipsis + tail.reverse().join("");
}

/** Pads with spaces on the right up to `width` cells (never truncates). */
export function padEndWidth(text: string, width: number): string {
  const missing = width - displayWidth(text);
  return missing > 0 ? text + " ".repeat(missing) : text;
}

/** `1 file` / `3 files`. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
