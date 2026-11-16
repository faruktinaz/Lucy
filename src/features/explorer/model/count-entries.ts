/**
 * Counts what a folder delete would remove, for the confirmation dialog. Bounded by entry
 * count and time so a huge `node_modules` never stalls the dialog; never follows symlinks.
 */
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface EntryCount {
  readonly count: number;
  /** Counting stopped at the limit or the time budget: the real number is larger. */
  readonly capped: boolean;
}

export async function countEntries(
  absDir: string,
  options: { limit?: number; timeBudgetMs?: number; signal?: AbortSignal } = {},
): Promise<EntryCount> {
  const limit = options.limit ?? 10_000;
  const deadline = performance.now() + (options.timeBudgetMs ?? 1000);
  const stack = [absDir];
  let count = 0;
  while (stack.length > 0) {
    if (options.signal?.aborted || performance.now() > deadline) return { count, capped: true };
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // Unreadable: the delete moves it as a whole anyway.
    }
    for (const entry of entries) {
      count++;
      if (count >= limit) return { count: limit, capped: true };
      if (entry.isDirectory()) stack.push(join(dir, String(entry.name)));
    }
  }
  return { count, capped: false };
}
