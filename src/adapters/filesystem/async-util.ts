/**
 * Cooperative-scheduling helpers for long-running work on the UI thread.
 *
 * The TUI renders on the same event loop as every service, so CPU-bound loops (sorting
 * 50k names, fuzzy-scoring 200k paths) must hand control back regularly or typing stutters.
 */
import { LucyError } from "@/core/errors";

export function cancelledError(): LucyError {
  return new LucyError("CANCELLED", "Operation cancelled");
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledError();
}

/**
 * Resolves on the next macrotask turn. `setImmediate` runs after pending I/O callbacks,
 * which is exactly what lets keystrokes and redraws through.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Tracks how long the current slice of synchronous work has run. Hot loops check
 * `shouldYield` every few hundred iterations (reading the clock is not free) and call
 * `yieldNow()` when the slice is used up; cancellation is observed at every yield.
 */
export class TimeSlicer {
  private sliceStart = performance.now();

  constructor(
    private readonly sliceMs = 8,
    private readonly signal?: AbortSignal,
  ) {}

  get shouldYield(): boolean {
    return performance.now() - this.sliceStart >= this.sliceMs;
  }

  async maybeYield(): Promise<void> {
    if (this.shouldYield) await this.yieldNow();
    else throwIfAborted(this.signal);
  }

  async yieldNow(): Promise<void> {
    await yieldToEventLoop();
    throwIfAborted(this.signal);
    this.sliceStart = performance.now();
  }
}

/**
 * Runs `fn` over `items` with at most `limit` calls in flight. Rejects with the first
 * error thrown by `fn` (remaining workers stop picking up new items).
 */
export async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed) {
      throwIfAborted(signal);
      const index = next++;
      if (index >= items.length) return;
      try {
        await fn(items[index] as T, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.max(1, Math.min(limit, items.length)); i++) workers.push(worker());
  await Promise.all(workers);
}

const RUN_LENGTH = 1024;

/**
 * Stable sort that yields to the event loop between slices of work. Small inputs are
 * sorted synchronously. Returns a new array; the input is not modified.
 *
 * Exists because `Intl.Collator#compare` costs ~0.15 µs per call: sorting a 50k-entry
 * directory synchronously would freeze the UI for over 100 ms.
 */
export async function sortAsync<T>(
  items: readonly T[],
  compare: (a: T, b: T) => number,
  options: { signal?: AbortSignal; sliceMs?: number; syncThreshold?: number } = {},
): Promise<T[]> {
  const n = items.length;
  if (n <= (options.syncThreshold ?? 4096)) return items.slice().sort(compare);
  const slicer = new TimeSlicer(options.sliceMs ?? 8, options.signal);
  let src = items.slice();
  for (let lo = 0; lo < n; lo += RUN_LENGTH) {
    const run = src.slice(lo, lo + RUN_LENGTH).sort(compare);
    for (let k = 0; k < run.length; k++) src[lo + k] = run[k] as T;
    if (slicer.shouldYield) await slicer.yieldNow();
  }
  let dst = new Array<T>(n);
  for (let width = RUN_LENGTH; width < n; width *= 2) {
    for (let lo = 0; lo < n; lo += 2 * width) {
      const mid = Math.min(lo + width, n);
      const hi = Math.min(lo + 2 * width, n);
      let i = lo;
      let j = mid;
      let k = lo;
      while (i < mid && j < hi) {
        // Take from the right run only when strictly smaller: keeps the sort stable.
        dst[k++] = compare(src[j] as T, src[i] as T) < 0 ? (src[j++] as T) : (src[i++] as T);
        if ((k & 2047) === 0 && slicer.shouldYield) await slicer.yieldNow();
      }
      while (i < mid) dst[k++] = src[i++] as T;
      while (j < hi) dst[k++] = src[j++] as T;
    }
    const swap = src;
    src = dst;
    dst = swap;
  }
  return src;
}
