/**
 * Intra-line ("word") diff for a removed line paired with an added line.
 *
 * Lines are split into words (letters, digits, `_`, any script), whitespace runs and single
 * punctuation characters, then compared with a longest-common-subsequence over tokens after
 * trimming the common prefix and suffix (most edits touch a small middle part, so the quadratic
 * table stays tiny). Highlighting is skipped when it would be noise or too expensive:
 * - either line is longer than `maxLineLength` UTF-16 units (default 1 000);
 * - the middle part needs more than `maxCells` table cells (default 250 000);
 * - the lines are too dissimilar: fewer than `minSimilarity` (default 40 %) of their
 *   non-whitespace characters are shared. Then the whole line is the change and per-word
 *   highlights would only add color without information.
 */

export interface WordRange {
  /** UTF-16 column, inclusive. */
  readonly start: number;
  /** UTF-16 column, exclusive. */
  readonly end: number;
}

export interface WordDiff {
  /** Changed ranges in the removed (old) line. */
  readonly old: readonly WordRange[];
  /** Changed ranges in the added (new) line. */
  readonly new: readonly WordRange[];
  /** Shared non-whitespace characters / average non-whitespace length, 0..1. */
  readonly similarity: number;
}

export interface WordDiffOptions {
  maxLineLength?: number;
  maxCells?: number;
  minSimilarity?: number;
}

export const WORD_DIFF_DEFAULTS: Readonly<Required<WordDiffOptions>> = {
  maxLineLength: 1_000,
  maxCells: 250_000,
  minSimilarity: 0.4,
};

export interface WordToken {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly isSpace: boolean;
}

// Word runs in any script, whitespace runs, or one code point (punctuation, symbols, emoji).
const TOKEN = /[\p{L}\p{M}\p{N}_]+|\s+|[\s\S]/gu;

export function tokenizeForWordDiff(text: string): WordToken[] {
  const tokens: WordToken[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const value = match[0];
    const start = match.index ?? 0;
    tokens.push({ text: value, start, end: start + value.length, isSpace: /^\s+$/.test(value) });
  }
  return tokens;
}

function nonSpaceLength(tokens: readonly WordToken[], from = 0, to = tokens.length): number {
  let total = 0;
  for (let i = from; i < to; i++) {
    const token = tokens[i];
    if (token && !token.isSpace) total += token.text.length;
  }
  return total;
}

/**
 * Marks tokens that are not part of the LCS. `aChanged[i]` / `bChanged[j]` become true for
 * changed tokens in `a[aFrom, aTo)` / `b[bFrom, bTo)`.
 */
function markChanges(
  a: readonly WordToken[],
  b: readonly WordToken[],
  aFrom: number,
  aTo: number,
  bFrom: number,
  bTo: number,
  aChanged: boolean[],
  bChanged: boolean[],
): number {
  const n = aTo - aFrom;
  const m = bTo - bFrom;
  const width = m + 1;
  // lengths[i][j] = LCS length of a[aFrom+i..aTo) and b[bFrom+j..bTo), filled backwards.
  const lengths = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    const ta = a[aFrom + i]?.text;
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * width + j] =
        ta === b[bFrom + j]?.text
          ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0);
    }
  }
  let shared = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ta = a[aFrom + i];
    const tb = b[bFrom + j];
    if (ta && tb && ta.text === tb.text) {
      if (!ta.isSpace) shared += ta.text.length;
      i++;
      j++;
    } else if ((lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0)) {
      aChanged[aFrom + i] = true;
      i++;
    } else {
      bChanged[bFrom + j] = true;
      j++;
    }
  }
  for (; i < n; i++) aChanged[aFrom + i] = true;
  for (; j < m; j++) bChanged[bFrom + j] = true;
  return shared;
}

/** Changed tokens → ranges; ranges separated only by whitespace are merged to reduce noise. */
function toRanges(tokens: readonly WordToken[], changed: readonly boolean[]): WordRange[] {
  const ranges: { start: number; end: number }[] = [];
  let pendingGap: WordToken | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (changed[i]) {
      const last = ranges[ranges.length - 1];
      if (last && (last.end === token.start || (pendingGap && last.end === pendingGap.start))) {
        last.end = token.end;
      } else {
        ranges.push({ start: token.start, end: token.end });
      }
      pendingGap = null;
    } else {
      const last = ranges[ranges.length - 1];
      pendingGap = token.isSpace && last && last.end === token.start ? token : null;
    }
  }
  return ranges;
}

/**
 * Word-level changes between a removed and an added line, or `null` when highlighting is
 * skipped (too long, too expensive or too dissimilar; see the module comment).
 */
export function wordDiff(oldText: string, newText: string, options: WordDiffOptions = {}): WordDiff | null {
  const settings = { ...WORD_DIFF_DEFAULTS, ...options };
  if (oldText.length > settings.maxLineLength || newText.length > settings.maxLineLength) return null;
  if (oldText === newText) return { old: [], new: [], similarity: 1 };

  const a = tokenizeForWordDiff(oldText);
  const b = tokenizeForWordDiff(newText);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix]?.text === b[prefix]?.text) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix]?.text === b[b.length - 1 - suffix]?.text
  ) {
    suffix++;
  }
  const aTo = a.length - suffix;
  const bTo = b.length - suffix;
  if ((aTo - prefix) * (bTo - prefix) > settings.maxCells) return null;

  const aChanged: boolean[] = new Array(a.length).fill(false);
  const bChanged: boolean[] = new Array(b.length).fill(false);
  const sharedMiddle = markChanges(a, b, prefix, aTo, prefix, bTo, aChanged, bChanged);
  const shared = nonSpaceLength(a, 0, prefix) + nonSpaceLength(a, aTo, a.length) + sharedMiddle;
  const total = nonSpaceLength(a) + nonSpaceLength(b);
  const similarity = total === 0 ? 1 : (2 * shared) / total;
  if (similarity < settings.minSimilarity) return null;
  return { old: toRanges(a, aChanged), new: toRanges(b, bChanged), similarity };
}
