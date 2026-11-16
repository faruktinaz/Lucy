/**
 * Explorer ordering: natural ("file2" before "file10"), case-insensitive at the primary
 * level, locale-aware (so "çay" sits next to "cay" and Turkish dotless "ı" sorts after "i").
 */

export type NameComparator = (a: string, b: string) => number;

/**
 * Comparator for file names. Ties under the collator (case variants, or canonically
 * equivalent NFC/NFD spellings, which can coexist on Linux) are broken by code units so the
 * order is total and deterministic.
 */
export function createNameComparator(locale?: string): NameComparator {
  const collator = new Intl.Collator(locale, { numeric: true, usage: "sort" });
  return (a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Directories first, then names. */
export function compareEntries(
  compareNames: NameComparator,
  a: { readonly name: string; readonly kind: "file" | "directory" },
  b: { readonly name: string; readonly kind: "file" | "directory" },
): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  return compareNames(a.name, b.name);
}
