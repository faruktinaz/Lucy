/**
 * Concurrency primitives for the Git layer.
 *
 * Git serializes writers through `index.lock`; two of our own mutations racing would make one
 * fail spuriously, so they go through a `SerialQueue`. Status requests are frequent (file
 * watcher, focus, after each mutation) and idempotent, so a `Coalescer` collapses bursts.
 */

/** Runs tasks one at a time in submission order. A failing task does not stop later ones. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  get size(): number {
    return this.pending;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.pending++;
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => {
        this.pending--;
      },
      () => {
        this.pending--;
      },
    );
    return result;
  }
}

/**
 * At most one run in flight plus at most one trailing run. Callers arriving while a run is in
 * flight share the trailing run, which starts after the current one settles, so every caller
 * gets a result that reflects the state at (or after) the moment it asked.
 */
export class Coalescer<T> {
  private inflight: Promise<T> | null = null;
  private trailing: Promise<T> | null = null;

  constructor(private readonly task: () => Promise<T>) {}

  get isRunning(): boolean {
    return this.inflight !== null;
  }

  run(): Promise<T> {
    if (!this.inflight) return this.start();
    if (!this.trailing) {
      const settle = () => {
        this.trailing = null;
        return this.start();
      };
      this.trailing = this.inflight.then(settle, settle);
    }
    return this.trailing;
  }

  private start(): Promise<T> {
    const promise = this.task().finally(() => {
      if (this.inflight === promise) this.inflight = null;
    });
    this.inflight = promise;
    return promise;
  }
}

/** Retries `task` while `shouldRetry` says so, with exponential backoff. */
export async function withRetry<T>(
  task: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  delaysMs: readonly number[] = [75, 150, 300],
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      const delay = delaysMs[attempt];
      if (delay === undefined || !shouldRetry(error)) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    }
  }
}
