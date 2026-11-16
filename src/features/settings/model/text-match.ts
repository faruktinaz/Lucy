/**
 * Search helpers shared by the settings and keyboard-shortcut lists: case- and
 * accent-insensitive, every query word must appear somewhere in the item's text.
 */

/** Lowercase, accents removed, Turkish dotless ı folded to i, so "calis" finds "Çalış". */
export function foldText(text: string): string {
  return text.toLowerCase().replace(/ı/g, "i").normalize("NFKD").replace(/\p{M}/gu, "");
}

/** Splits a query into folded words; an empty result means "match everything". */
export function queryTerms(query: string): string[] {
  return foldText(query).split(/\s+/).filter(Boolean);
}

/** True when every term occurs in at least one of the haystacks. */
export function matchesTerms(terms: readonly string[], haystacks: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const folded = haystacks.map(foldText).join("\n");
  return terms.every((term) => folded.includes(term));
}
