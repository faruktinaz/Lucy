/**
 * Subsequence matching for the command palette.
 *
 * A query matches when its characters appear in the candidate in order. The score
 * rewards matches at word starts and consecutive runs, which is what people expect
 * when they type "nn" for "New note" or "tdm" for "Toggle dark mode".
 */

export interface FuzzyMatch {
  score: number;
  /** Indices into the candidate string, for highlighting. */
  positions: number[];
}

const WORD_START_BONUS = 8;
const CONSECUTIVE_BONUS = 5;
const FIRST_CHARACTER_BONUS = 10;
const GAP_PENALTY = 1;

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text[index - 1]!;
  return previous === " " || previous === "-" || previous === "_" || previous === ".";
}

export function fuzzyMatch(query: string, candidate: string): FuzzyMatch | null {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return { score: 0, positions: [] };
  const haystack = candidate.toLocaleLowerCase();

  const positions: number[] = [];
  let score = 0;
  let searchFrom = 0;

  for (const character of needle) {
    const index = haystack.indexOf(character, searchFrom);
    if (index === -1) return null;

    const previous = positions.at(-1);
    if (index === 0) score += FIRST_CHARACTER_BONUS;
    if (isWordStart(candidate, index)) score += WORD_START_BONUS;
    if (previous !== undefined && index === previous + 1) score += CONSECUTIVE_BONUS;
    if (previous !== undefined) score -= (index - previous - 1) * GAP_PENALTY;

    positions.push(index);
    searchFrom = index + 1;
  }

  return { score, positions };
}

/** Returns the matching items, best first; ties keep their original order. */
export function rankByFuzzyMatch<T>(items: T[], query: string, text: (item: T) => string): T[] {
  return items
    .map((item, order) => ({ item, order, match: fuzzyMatch(query, text(item)) }))
    .filter((entry) => entry.match !== null)
    .sort((a, b) => b.match!.score - a.match!.score || a.order - b.order)
    .map((entry) => entry.item);
}
