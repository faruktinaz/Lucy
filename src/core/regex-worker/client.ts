/**
 * Runs user regexes in a worker with a hard time budget. Shared by Find in the editor and the
 * builtin project-search engine.
 *
 * A JavaScript `exec` cannot be interrupted, and patterns like `(a+)+$` backtrack for
 * minutes on a 40-character line. On the UI thread that would freeze Lucy, so regex queries
 * run in a worker that is terminated when the budget runs out, the signal aborts, or a new run
 * starts while the previous one is still busy. The worker is reused across runs (it caches the
 * lines per version) and released after a minute of inactivity.
 *
 * One run at a time per client: starting a run supersedes (terminates) the active one. Callers
 * with several texts in flight must queue them (see `builtin-engine.ts`).
 *
 * Packaging note: `bun build --compile` must list `worker-entry.ts` as an additional entry
 * point for the URL below to resolve inside a single binary. If the worker cannot start,
 * `run()` rejects with `UNSUPPORTED` and callers fall back to an in-thread scanner.
 */
import { LucyError } from "../errors";
import type { Disposable } from "../events";
import type { LineMatch } from "./line-matches";
import { isWorkerResponse, type WorkerResponse, type WorkerSearchRequest } from "./protocol";

export interface RegexRunRequest {
  readonly lines: readonly string[];
  /** Changes whenever `lines` changes; lets the worker keep its copy between queries. */
  readonly version: number;
  readonly source: string;
  readonly flags: string;
  readonly maxMatches: number;
  /** See `WorkerSearchRequest.maxMatchesPerLine`. */
  readonly maxMatchesPerLine?: number;
  /** See `WorkerSearchRequest.maxLines`. */
  readonly maxLines?: number;
  readonly budgetMs: number;
  readonly signal?: AbortSignal;
  readonly onBatch: (matches: LineMatch[]) => void;
}

export interface RegexRunOutcome {
  /** A match or line cap stopped the scan early. */
  readonly limitHit: boolean;
  /** The time budget ran out and the worker was terminated; matches so far were delivered. */
  readonly timedOut: boolean;
}

const IDLE_RELEASE_MS = 60_000;

interface ActiveRun {
  readonly id: number;
  readonly request: RegexRunRequest;
  readonly resolve: (outcome: RegexRunOutcome) => void;
  readonly reject: (error: unknown) => void;
  readonly cleanup: () => void;
}

function unref(handle: { unref?: () => void } | undefined): void {
  handle?.unref?.();
}

function cancelled(reason: string): LucyError {
  return new LucyError("CANCELLED", `The regular expression search was ${reason}`);
}

export class RegexWorkerClient implements Disposable {
  #worker: Worker | null = null;
  #workerVersion = -1;
  #active: ActiveRun | null = null;
  #nextId = 1;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #unavailable = false;
  #disposed = false;

  /** False once the worker failed to start; callers then use an in-thread scanner. */
  get available(): boolean {
    return !this.#unavailable && !this.#disposed;
  }

  run(request: RegexRunRequest): Promise<RegexRunOutcome> {
    if (!this.available) {
      return Promise.reject(new LucyError("UNSUPPORTED", "The regex worker is not available"));
    }
    if (request.signal?.aborted) return Promise.reject(cancelled("cancelled"));
    // A run still in flight is stuck or superseded: the only way to stop it is to terminate.
    if (this.#active) this.#fail(this.#active, cancelled("superseded"), true);
    clearTimeout(this.#idleTimer);

    let worker: Worker;
    try {
      worker = this.#ensureWorker();
    } catch (cause) {
      this.#unavailable = true;
      return Promise.reject(new LucyError("UNSUPPORTED", "The regex worker could not start", { cause }));
    }

    return new Promise<RegexRunOutcome>((resolve, reject) => {
      const id = this.#nextId++;
      const budget = setTimeout(() => {
        if (this.#active?.id !== id) return;
        this.#terminate();
        this.#finish(run, { limitHit: false, timedOut: true });
      }, request.budgetMs);
      unref(budget as { unref?: () => void });
      const onAbort = (): void => {
        if (this.#active?.id === id) this.#fail(run, cancelled("cancelled"), true);
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      const run: ActiveRun = {
        id,
        request,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(budget);
          request.signal?.removeEventListener("abort", onAbort);
        },
      };
      this.#active = run;
      const message: WorkerSearchRequest = {
        type: "search",
        id,
        version: request.version,
        lines: this.#workerVersion === request.version ? undefined : request.lines,
        source: request.source,
        flags: request.flags,
        maxMatches: request.maxMatches,
        maxMatchesPerLine: request.maxMatchesPerLine,
        maxLines: request.maxLines,
      };
      this.#workerVersion = request.version;
      worker.postMessage(message);
    });
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#active) this.#fail(this.#active, cancelled("disposed"), false);
    this.#terminate();
  }

  #ensureWorker(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(new URL("./worker-entry.ts", import.meta.url).href);
    unref(worker as unknown as { unref?: () => void });
    worker.onmessage = (event: MessageEvent) => this.#onMessage(event.data);
    worker.onerror = (event: ErrorEvent) => {
      // A worker that fails to load or crashes is not retried: fall back for this client's lifetime.
      this.#unavailable = true;
      const error = new LucyError(
        "UNSUPPORTED",
        `The regex worker failed: ${event.message || "unknown error"}`,
      );
      if (this.#active) this.#fail(this.#active, error, true);
      else this.#terminate();
    };
    this.#worker = worker;
    this.#workerVersion = -1;
    return worker;
  }

  #onMessage(data: unknown): void {
    if (!isWorkerResponse(data)) return;
    const run = this.#active;
    if (!run || run.id !== data.id) return; // A late message from a superseded run.
    this.#handle(run, data);
  }

  #handle(run: ActiveRun, message: WorkerResponse): void {
    switch (message.type) {
      case "batch": {
        const { data } = message;
        const batch: LineMatch[] = new Array(data.length / 3);
        for (let i = 0; i < batch.length; i++) {
          batch[i] = {
            line: data[i * 3] as number,
            start: data[i * 3 + 1] as number,
            end: data[i * 3 + 2] as number,
          };
        }
        run.request.onBatch(batch);
        return;
      }
      case "done":
        this.#finish(run, { limitHit: message.limitHit, timedOut: false });
        return;
      case "error":
        this.#workerVersion = -1;
        this.#fail(run, new LucyError("INTERNAL", message.message), false);
        return;
    }
  }

  #finish(run: ActiveRun, outcome: RegexRunOutcome): void {
    run.cleanup();
    if (this.#active === run) this.#active = null;
    this.#scheduleIdleRelease();
    run.resolve(outcome);
  }

  #fail(run: ActiveRun, error: unknown, terminate: boolean): void {
    run.cleanup();
    if (this.#active === run) this.#active = null;
    if (terminate) this.#terminate();
    run.reject(error);
  }

  #terminate(): void {
    clearTimeout(this.#idleTimer);
    const worker = this.#worker;
    this.#worker = null;
    this.#workerVersion = -1;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }
  }

  #scheduleIdleRelease(): void {
    clearTimeout(this.#idleTimer);
    if (!this.#worker) return;
    this.#idleTimer = setTimeout(() => {
      if (!this.#active) this.#terminate();
    }, IDLE_RELEASE_MS);
    unref(this.#idleTimer as { unref?: () => void });
  }
}
