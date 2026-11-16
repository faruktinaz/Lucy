/**
 * Fuzzy matcher for file paths (Quick Open), in the spirit of fzf v2 and VS Code.
 *
 * Matching: every query character must appear in order (subsequence), case- and
 * accent-insensitive via `foldCode` (see case-fold.ts for the Unicode decisions: Turkish
 * "İ"/"ı" fold to "i", Latin diacritics fold to the base letter, locale never matters).
 *
 * Scoring: a dynamic program finds the alignment with the best score, where
 * - each matched character scores, gaps cost (opening a gap more than extending it);
 * - characters after "/" (path segment start), after "_ - . space" (word start) and camelCase
 *   humps get bonuses; consecutive runs inherit the bonus of where the run started;
 * - the first query character's bonus counts double;
 * - typing an uppercase or accented letter that matches exactly earns a small bonus
 *   (smart-case), without ever being required.
 * Path semantics: the query is split on whitespace into terms that must all match (AND).
 * A term without "/" is matched against the basename first (large bonus, more for a
 * basename prefix, the stem ("button" for "button.tsx") or the exact name); if it does not
 * fit in the basename it may match anywhere in the path. A term containing "/" always matches
 * against the full path. Ties are broken by shorter path, then original order.
 */
import { cancelledError, sortAsync, TimeSlicer, throwIfAborted } from "@/adapters/filesystem/async-util";
import { foldCode, isCombiningMark } from "@/adapters/filesystem/case-fold";

export interface FuzzyMatch {
  readonly score: number;
  /** Sorted UTF-16 indices of matched characters in the candidate. */
  readonly positions: readonly number[];
}

export interface FuzzyResult<T> extends FuzzyMatch {
  readonly item: T;
  /** Index in the input array. */
  readonly index: number;
}

export interface FuzzyFilterOptions {
  /** Keep only the best N results. Default: all. */
  limit?: number;
  signal?: AbortSignal;
  /** Work slice before yielding to the event loop. Default 8 ms. */
  sliceMs?: number;
}

const SCORE_MATCH = 16;
const GAP_START = -3;
const GAP_EXTENSION = -1;
const BONUS_PATH_BOUNDARY = 10;
const BONUS_BOUNDARY = 8;
const BONUS_CAMEL = 7;
const BONUS_CONSECUTIVE = 4;
const FIRST_CHAR_MULTIPLIER = 2;
const BONUS_EXACT_CHAR = 1;
// Basename tiers dominate the alignment score (which stays well under 2000 for realistic
// terms), like VS Code's label-over-description rule: any basename match outranks a match
// that needs the directory part.
const BONUS_IN_BASENAME = 2000;
const BONUS_BASENAME_PREFIX = 4000;
const BONUS_BASENAME_STEM = 6000;
const BONUS_BASENAME_EXACT = 8000;

/** Candidates longer than this are scored greedily (keeps the DP bounded). */
const MAX_DP_TEXT = 512;
/** Terms longer than this are scored greedily. */
const MAX_DP_TERM = 128;

const NEG = -1_000_000;
const NEG_LIMIT = -500_000;

const CLASS_PATH = 0;
const CLASS_SEPARATOR = 1;
const CLASS_LOWER = 2;
const CLASS_UPPER = 3;
const CLASS_DIGIT = 4;

let nonAsciiClasses: Uint8Array | null = null;

function charClass(code: number): number {
  if (code < 128) {
    if (code >= 97 && code <= 122) return CLASS_LOWER;
    if (code >= 65 && code <= 90) return CLASS_UPPER;
    if (code >= 48 && code <= 57) return CLASS_DIGIT;
    if (code === 47 || code === 92) return CLASS_PATH;
    return CLASS_SEPARATOR;
  }
  if (!nonAsciiClasses) {
    nonAsciiClasses = new Uint8Array(65536);
    for (let c = 128; c < 65536; c++) {
      const char = String.fromCharCode(c);
      nonAsciiClasses[c] = char !== char.toLowerCase() && !isCombiningMark(c) ? CLASS_UPPER : CLASS_LOWER;
    }
  }
  return nonAsciiClasses[code] as number;
}

function bonusFor(previous: number, current: number): number {
  if (current === CLASS_PATH || current === CLASS_SEPARATOR) return BONUS_BOUNDARY;
  if (previous === CLASS_PATH) return BONUS_PATH_BOUNDARY;
  if (previous === CLASS_SEPARATOR) return BONUS_BOUNDARY;
  if (previous === CLASS_LOWER && current === CLASS_UPPER) return BONUS_CAMEL;
  if (previous !== CLASS_DIGIT && current === CLASS_DIGIT) return BONUS_CAMEL;
  return 0;
}

interface Term {
  readonly folded: Uint16Array;
  readonly raw: Uint16Array;
  /** 1 where an exact (unfolded) match earns the smart-case bonus. */
  readonly exactBonus: Uint8Array;
  readonly hasSlash: boolean;
}

export interface PreparedFuzzyQuery {
  readonly text: string;
  readonly terms: readonly Term[];
}

/** Parses a query once for scoring many candidates. */
export function prepareFuzzyQuery(query: string): PreparedFuzzyQuery {
  const terms: Term[] = [];
  for (const part of query.split(/\s+/)) {
    const codes: number[] = [];
    for (let i = 0; i < part.length; i++) {
      const code = part.charCodeAt(i);
      if (!isCombiningMark(code)) codes.push(code);
    }
    if (codes.length === 0) continue;
    const folded = new Uint16Array(codes.length);
    const raw = new Uint16Array(codes.length);
    const exactBonus = new Uint8Array(codes.length);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i] as number;
      raw[i] = code;
      folded[i] = foldCode(code);
      exactBonus[i] = (code >= 65 && code <= 90) || code >= 128 ? 1 : 0;
    }
    terms.push({ folded, raw, exactBonus, hasSlash: codes.includes(47) });
  }
  return { text: query, terms };
}

// Scratch buffers reused across calls: scoring runs synchronously, so sharing is safe.
let textBuf = new Uint16Array(MAX_DP_TEXT);
let rawBuf = new Uint16Array(MAX_DP_TEXT);
let bonusBuf = new Int8Array(MAX_DP_TEXT);
const firstBuf = new Int32Array(MAX_DP_TERM);
const lastBuf = new Int32Array(MAX_DP_TERM);
let scoreBuf = new Int32Array(0);
let runBuf = new Int8Array(0);
let predBuf = new Int32Array(0);

function ensureText(n: number): void {
  if (textBuf.length >= n) return;
  const size = Math.max(n, textBuf.length * 2);
  textBuf = new Uint16Array(size);
  rawBuf = new Uint16Array(size);
  bonusBuf = new Int8Array(size);
}

function ensureMatrix(cells: number): void {
  if (scoreBuf.length >= cells) return;
  const size = Math.max(cells, scoreBuf.length * 2, 4096);
  scoreBuf = new Int32Array(size);
  runBuf = new Int8Array(size);
  predBuf = new Int32Array(size);
}

/**
 * Best score of `term` within `candidate[lo, hi)`, or NEG when it does not match. Writes
 * absolute positions into `positions` when given.
 */
function matchRange(
  term: Term,
  candidate: string,
  lo: number,
  hi: number,
  positions: number[] | null,
): number {
  const m = term.folded.length;
  const n = hi - lo;
  if (m > n) return NEG;
  const query = term.folded;
  ensureText(n);
  const text = textBuf;
  const raw = rawBuf;
  // Fold lazily during the forward scan; most candidates are rejected there.
  let qi = 0;
  const greedy = m > MAX_DP_TERM ? new Int32Array(m) : firstBuf;
  for (let j = 0; j < n; j++) {
    const code = candidate.charCodeAt(lo + j);
    raw[j] = code;
    const folded = code < 128 ? (code >= 65 && code <= 90 ? code + 32 : code) : foldCode(code);
    text[j] = folded;
    if (qi < m && folded === query[qi]) greedy[qi++] = j;
  }
  if (qi < m) return NEG;

  if (n > MAX_DP_TEXT || m > MAX_DP_TERM) return greedyScore(term, candidate, lo, n, greedy, positions);

  const first = firstBuf;
  const last = lastBuf;
  qi = m - 1;
  for (let j = n - 1; j >= 0 && qi >= 0; j--) if (text[j] === query[qi]) last[qi--] = j;

  const bonus = bonusBuf;
  const from = first[0] as number;
  const to = last[m - 1] as number;
  let previousClass = from === 0 ? CLASS_PATH : charClass(candidate.charCodeAt(lo + from - 1));
  if (lo + from === 0) previousClass = CLASS_PATH;
  for (let j = from; j <= to; j++) {
    const current = charClass(raw[j] as number);
    bonus[j] = bonusFor(previousClass, current);
    previousClass = current;
  }

  ensureMatrix(m * n);
  const H = scoreBuf;
  const R = runBuf;
  const P = predBuf;

  for (let i = 0; i < m; i++) {
    const row = i * n;
    const prevRow = row - n;
    const qc = query[i] as number;
    const exactCode = term.exactBonus[i] ? (term.raw[i] as number) : -1;
    const start = first[i] as number;
    const end = last[i] as number;
    const prevStart = i > 0 ? (first[i - 1] as number) : 0;
    const prevEnd = i > 0 ? (last[i - 1] as number) : -1;
    // gap = best over k <= j-2 of H[i-1][k] + GAP_START + GAP_EXTENSION * (j-2-k)
    let gap = NEG;
    let gapFrom = -1;
    if (i > 0) {
      for (let k = prevStart; k <= Math.min(start - 2, prevEnd); k++) {
        const value = H[prevRow + k] as number;
        if (value <= NEG_LIMIT) continue;
        const candidateGap = value + GAP_START + GAP_EXTENSION * (start - 2 - k);
        if (candidateGap > gap) {
          gap = candidateGap;
          gapFrom = k;
        }
      }
    }
    for (let j = start; j <= end; j++) {
      let score = NEG;
      let run = 0;
      let pred = -1;
      if (text[j] === qc) {
        const b = bonus[j] as number;
        const exact = raw[j] === exactCode ? BONUS_EXACT_CHAR : 0;
        if (i === 0) {
          score = SCORE_MATCH + b * FIRST_CHAR_MULTIPLIER + exact;
          run = b;
        } else {
          if (j - 1 >= prevStart && j - 1 <= prevEnd) {
            const previous = H[prevRow + j - 1] as number;
            if (previous > NEG_LIMIT) {
              const runBonus = R[prevRow + j - 1] as number;
              score = previous + SCORE_MATCH + Math.max(b, runBonus, BONUS_CONSECUTIVE) + exact;
              run = Math.max(runBonus, b);
              pred = j - 1;
            }
          }
          if (gap > NEG_LIMIT) {
            const gapScore = gap + SCORE_MATCH + b + exact;
            if (gapScore > score) {
              score = gapScore;
              run = b;
              pred = gapFrom;
            }
          }
        }
      }
      H[row + j] = score;
      R[row + j] = run;
      P[row + j] = pred;
      if (i > 0) {
        // Advance the gap window to j+1: k = j-1 becomes eligible.
        const k = j - 1;
        const value = k >= prevStart && k <= prevEnd ? (H[prevRow + k] as number) : NEG;
        if (value > NEG_LIMIT && value + GAP_START > gap + GAP_EXTENSION) {
          gap = value + GAP_START;
          gapFrom = k;
        } else if (gap > NEG_LIMIT) {
          gap += GAP_EXTENSION;
        }
      }
    }
  }

  const lastRow = (m - 1) * n;
  let best = NEG;
  let bestJ = -1;
  for (let j = first[m - 1] as number; j <= to; j++) {
    const value = H[lastRow + j] as number;
    if (value > best) {
      best = value;
      bestJ = j;
    }
  }
  if (best <= NEG_LIMIT) return NEG;
  if (positions) {
    const found = new Array<number>(m);
    let j = bestJ;
    for (let i = m - 1; i >= 0; i--) {
      found[i] = lo + j;
      j = P[i * n + j] as number;
    }
    for (const position of found) positions.push(position);
  }
  return best;
}

/** Linear fallback for very long candidates or terms: earliest positions, simple bonuses. */
function greedyScore(
  term: Term,
  candidate: string,
  lo: number,
  n: number,
  greedy: Int32Array,
  positions: number[] | null,
): number {
  const m = term.folded.length;
  let score = 0;
  let previous = -2;
  for (let i = 0; i < m; i++) {
    const j = greedy[i] as number;
    const before = lo + j === 0 ? CLASS_PATH : charClass(candidate.charCodeAt(lo + j - 1));
    const b = bonusFor(before, charClass(candidate.charCodeAt(lo + j)));
    score += SCORE_MATCH + (i === 0 ? b * FIRST_CHAR_MULTIPLIER : b);
    if (j === previous + 1) score += BONUS_CONSECUTIVE;
    else if (i > 0) score += GAP_START + GAP_EXTENSION * Math.min(n, j - previous - 2);
    previous = j;
    positions?.push(lo + j);
  }
  return score;
}

function basenameStart(candidate: string): number {
  const slash = candidate.lastIndexOf("/");
  return slash === -1 ? 0 : slash + 1;
}

/** Bonus for how the term relates to the whole basename (prefix, stem, exact). */
function basenameBonus(term: Term, candidate: string, start: number): number {
  const m = term.folded.length;
  const length = candidate.length - start;
  if (m > length) return BONUS_IN_BASENAME;
  for (let i = 0; i < m; i++) {
    if (foldCode(candidate.charCodeAt(start + i)) !== term.folded[i]) return BONUS_IN_BASENAME;
  }
  if (m === length) return BONUS_BASENAME_EXACT;
  if (candidate.charCodeAt(start + m) === 46) return BONUS_BASENAME_STEM; // "."
  return BONUS_BASENAME_PREFIX;
}

function scoreTerm(term: Term, candidate: string, base: number, positions: number[] | null): number {
  if (!term.hasSlash) {
    const mark = positions?.length ?? 0;
    const inBase = matchRange(term, candidate, base, candidate.length, positions);
    if (inBase > NEG_LIMIT) return inBase + basenameBonus(term, candidate, base);
    if (positions) positions.length = mark;
    if (base === 0) return NEG;
  }
  return matchRange(term, candidate, 0, candidate.length, positions);
}

/** Scores a candidate against a prepared query; `null` when it does not match. */
export function fuzzyMatchPrepared(
  query: PreparedFuzzyQuery,
  candidate: string,
  withPositions = true,
): FuzzyMatch | null {
  if (query.terms.length === 0) return { score: 0, positions: [] };
  const base = basenameStart(candidate);
  const positions: number[] | null = withPositions ? [] : null;
  let total = 0;
  for (const term of query.terms) {
    const score = scoreTerm(term, candidate, base, positions);
    if (score <= NEG_LIMIT) return null;
    total += score;
  }
  if (!positions) return { score: total, positions: [] };
  if (query.terms.length > 1) {
    positions.sort((a, b) => a - b);
    let write = 0;
    for (let read = 0; read < positions.length; read++) {
      if (read === 0 || positions[read] !== positions[read - 1])
        positions[write++] = positions[read] as number;
    }
    positions.length = write;
  }
  return { score: total, positions };
}

/** Scores one candidate. An empty query matches everything with score 0. */
export function fuzzyMatch(query: string, candidate: string): FuzzyMatch | null {
  return fuzzyMatchPrepared(prepareFuzzyQuery(query), candidate);
}

interface Ranked {
  score: number;
  length: number;
  index: number;
}

/** Higher score first, then shorter candidate, then earlier input position. */
function compareRanked(a: Ranked, b: Ranked): number {
  return b.score - a.score || a.length - b.length || a.index - b.index;
}

/** Bounded collection of the best `limit` entries (a max-heap on "worst"). */
class TopK {
  private readonly heap: Ranked[] = [];

  constructor(private readonly limit: number) {}

  push(entry: Ranked): void {
    const heap = this.heap;
    if (heap.length < this.limit) {
      heap.push(entry);
      this.siftUp(heap.length - 1);
    } else if (compareRanked(entry, heap[0] as Ranked) < 0) {
      heap[0] = entry;
      this.siftDown(0);
    }
  }

  sorted(): Ranked[] {
    return this.heap.slice().sort(compareRanked);
  }

  private siftUp(index: number): void {
    const heap = this.heap;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (compareRanked(heap[index] as Ranked, heap[parent] as Ranked) <= 0) return;
      [heap[index], heap[parent]] = [heap[parent] as Ranked, heap[index] as Ranked];
      index = parent;
    }
  }

  private siftDown(index: number): void {
    const heap = this.heap;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worst = index;
      if (left < heap.length && compareRanked(heap[left] as Ranked, heap[worst] as Ranked) > 0) worst = left;
      if (right < heap.length && compareRanked(heap[right] as Ranked, heap[worst] as Ranked) > 0)
        worst = right;
      if (worst === index) return;
      [heap[index], heap[worst]] = [heap[worst] as Ranked, heap[index] as Ranked];
      index = worst;
    }
  }
}

/**
 * Filters and ranks `items` by `key(item)`. Asynchronous and chunked: yields to the event
 * loop every `sliceMs` so typing stays responsive on 200k paths; rejects with a `CANCELLED`
 * LucyError once `signal` aborts. An empty query returns items in the given order (callers
 * pass recently opened files first).
 */
export async function fuzzyFilterBy<T>(
  query: string,
  items: readonly T[],
  key: (item: T) => string,
  options: FuzzyFilterOptions = {},
): Promise<FuzzyResult<T>[]> {
  const { signal } = options;
  throwIfAborted(signal);
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  if (limit <= 0) return [];
  const prepared = prepareFuzzyQuery(query);
  if (prepared.terms.length === 0) {
    const count = Math.min(items.length, limit);
    const out: FuzzyResult<T>[] = new Array(count);
    for (let i = 0; i < count; i++) out[i] = { item: items[i] as T, index: i, score: 0, positions: [] };
    return out;
  }
  const slicer = new TimeSlicer(options.sliceMs ?? 8, signal);
  const bounded = Number.isFinite(limit) ? new TopK(limit) : null;
  const all: Ranked[] = [];
  for (let i = 0; i < items.length; i++) {
    if ((i & 255) === 255 && slicer.shouldYield) await slicer.yieldNow();
    const candidate = key(items[i] as T);
    const match = fuzzyMatchPrepared(prepared, candidate, false);
    if (!match) continue;
    const entry = { score: match.score, length: candidate.length, index: i };
    if (bounded) bounded.push(entry);
    else all.push(entry);
  }
  if (signal?.aborted) throw cancelledError();
  const ranked = bounded ? bounded.sorted() : await sortAsync(all, compareRanked, { signal });
  const out: FuzzyResult<T>[] = new Array(ranked.length);
  for (let r = 0; r < ranked.length; r++) {
    if ((r & 255) === 255 && slicer.shouldYield) await slicer.yieldNow();
    const { index } = ranked[r] as Ranked;
    const item = items[index] as T;
    const match = fuzzyMatchPrepared(prepared, key(item), true) as FuzzyMatch;
    out[r] = { item, index, score: match.score, positions: match.positions };
  }
  return out;
}

/** `fuzzyFilterBy` for plain strings. */
export function fuzzyFilter(
  query: string,
  items: readonly string[],
  options: FuzzyFilterOptions = {},
): Promise<FuzzyResult<string>[]> {
  return fuzzyFilterBy(query, items, (item) => item, options);
}
