/**
 * Pure list-navigation transitions. They work on an index and accessor functions so they never
 * need the rows materialized (the explorer list is virtualized and can be very long).
 */
import { foldQuery, foldString } from "@/adapters/filesystem";

export function clampIndex(index: number, count: number): number {
  if (count <= 0) return -1;
  return Math.max(0, Math.min(count - 1, index));
}

/** Up/down: moves by `delta` without wrapping. From "nothing selected" down goes to the first row. */
export function moveIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta >= 0 ? 0 : count - 1;
  return clampIndex(current + delta, count);
}

/** Page up/down by a viewport height (at least one row). */
export function pageIndex(current: number, direction: 1 | -1, pageSize: number, count: number): number {
  return moveIndex(current, direction * Math.max(1, pageSize - 1), count);
}

/** Nearest preceding row with a smaller depth (the parent folder's row), or -1. */
export function parentIndex(depthAt: (index: number) => number, index: number): number {
  if (index <= 0) return -1;
  const depth = depthAt(index);
  for (let i = index - 1; i >= 0; i--) if (depthAt(i) < depth) return i;
  return -1;
}

/** The first child row of an expanded folder at `index`, or -1 when it shows no children. */
export function firstChildIndex(depthAt: (index: number) => number, index: number, count: number): number {
  return index + 1 < count && depthAt(index + 1) > depthAt(index) ? index + 1 : -1;
}

/**
 * Type-ahead: the next row (after `start`, wrapping) whose name starts with `prefix`, case-
 * and accent-insensitively. Typing the same letter repeatedly cycles through matches, as in
 * VS Code and Finder. `nameAt` returns null for rows that cannot be matched.
 */
export function findTypeAhead(
  nameAt: (index: number) => string | null,
  count: number,
  start: number,
  prefix: string,
): number {
  const needle = foldQuery(prefix);
  if (count <= 0 || needle === "") return -1;
  const repeated = needle.length > 1 && [...needle].every((char) => char === needle[0]);
  const target = repeated ? needle.slice(0, 1) : needle;
  // A longer prefix refines the current match, so the current row itself is checked first.
  const first = repeated || needle.length === 1 ? start + 1 : Math.max(start, 0);
  for (let offset = 0; offset < count; offset++) {
    const index = (((first + offset) % count) + count) % count;
    const name = nameAt(index);
    if (name !== null && foldString(name).startsWith(target)) return index;
  }
  return -1;
}
