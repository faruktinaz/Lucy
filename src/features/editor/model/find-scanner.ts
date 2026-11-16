/**
 * In-thread match scanning in time slices: yields to the event loop between slices so typing
 * and redraws stay smooth, observes cancellation at every yield, and stops at a match cap and
 * an optional time budget.
 *
 * The budget is checked between lines, so it bounds slow-but-finite searches only; a single
 * catastrophic `exec` cannot be interrupted on this thread. That is why user regexes run in
 * the worker (`src/core/regex-worker/client.ts`) and this scanner serves literal queries, whose
 * compiled patterns cannot backtrack.
 */
import { LucyError } from "@/core/errors";
import { collectLineMatches, type FindMatch } from "./find-matches";

export interface ScanOptions {
  readonly maxMatches: number;
  /** Work per slice before yielding. Default 8 ms. */
  readonly sliceMs?: number;
  /** Stop (with `timedOut`) once the whole scan has run this long. Default: no budget. */
  readonly budgetMs?: number;
  readonly signal?: AbortSignal;
  /** Receives each slice's matches in document order. */
  readonly onBatch: (matches: FindMatch[]) => void;
}

export interface ScanOutcome {
  readonly limitHit: boolean;
  readonly timedOut: boolean;
}

/** Reading the clock is not free: check it every this many lines. */
const CLOCK_EVERY = 64;

function cancelled(): LucyError {
  return new LucyError("CANCELLED", "Find was cancelled");
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Scans `lines`. The first slice runs synchronously, so small documents are done before this
 * returns its promise (no "Searching…" flash). Rejects with `CANCELLED` when `signal` aborts.
 */
export async function scanLines(
  lines: readonly string[],
  regex: RegExp,
  options: ScanOptions,
): Promise<ScanOutcome> {
  const sliceMs = options.sliceMs ?? 8;
  const started = performance.now();
  const deadline = options.budgetMs === undefined ? Number.POSITIVE_INFINITY : started + options.budgetMs;
  // One match beyond the cap tells "exactly 10000" apart from "more than 10000".
  const probe = options.maxMatches + 1;
  // Untrusted regexes can take milliseconds per line: check the clock after every line then.
  const clockEvery = options.budgetMs === undefined ? CLOCK_EVERY : 1;
  let total = 0;
  let line = 0;
  while (line < lines.length) {
    if (options.signal?.aborted) throw cancelled();
    const sliceEnd = performance.now() + sliceMs;
    const batch: FindMatch[] = [];
    let timedOut = false;
    while (line < lines.length) {
      collectLineMatches(regex, lines[line] as string, line, batch, probe - total);
      line++;
      if (total + batch.length >= probe) break;
      if (line % clockEvery === 0) {
        const now = performance.now();
        if (now >= deadline) {
          timedOut = true;
          break;
        }
        if (now >= sliceEnd) break;
      }
    }
    const limitHit = total + batch.length > options.maxMatches;
    if (limitHit) batch.length = options.maxMatches - total;
    total += batch.length;
    if (batch.length > 0) options.onBatch(batch);
    if (limitHit) return { limitHit: true, timedOut: false };
    if (timedOut && line < lines.length) return { limitHit: false, timedOut: true };
    if (line < lines.length) await nextMacrotask();
  }
  return { limitHit: false, timedOut: false };
}
