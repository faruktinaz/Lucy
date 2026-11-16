/** Test doubles for the search models: a scriptable search backend and file index. */
import type {
  ContentSearchQuery,
  FileIndexResult,
  SearchCallbacks,
  SearchEngineName,
  SearchMatch,
  SearchSummary,
} from "@/adapters/search";
import { LucyError } from "@/core/errors";
import type { QuickOpenIndex, SearchBackend } from "@/features/search/model";

export interface FakeCall {
  readonly query: ContentSearchQuery;
  readonly signal: AbortSignal | undefined;
  emit(batch: readonly SearchMatch[]): void;
  finish(summary?: Partial<SearchSummary>): void;
  fail(error: unknown): void;
}

/** A search backend whose runs the test drives by hand. Aborting a run rejects it like the real one. */
export class FakeSearch implements SearchBackend {
  readonly calls: FakeCall[] = [];
  engine: SearchEngineName = "builtin";
  rg: string | null = null;

  resolveEngine = async (): Promise<SearchEngineName> => this.engine;

  ripgrepPath = (): string | null => this.rg;

  search = (
    query: ContentSearchQuery,
    callbacks: SearchCallbacks,
    signal?: AbortSignal,
  ): Promise<SearchSummary> =>
    new Promise<SearchSummary>((resolve, reject) => {
      let matchCount = 0;
      const files = new Set<string>();
      signal?.addEventListener("abort", () => reject(new LucyError("CANCELLED", "Operation cancelled")), {
        once: true,
      });
      this.calls.push({
        query,
        signal,
        emit: (batch) => {
          matchCount += batch.length;
          for (const match of batch) files.add(match.path);
          callbacks.onMatches(batch);
        },
        finish: (summary = {}) =>
          resolve({
            engine: this.engine,
            matchCount,
            fileCount: files.size,
            truncated: false,
            durationMs: 1,
            ...summary,
          }),
        fail: reject,
      });
    });

  last(): FakeCall {
    const call = this.calls[this.calls.length - 1];
    if (!call) throw new Error("no search started");
    return call;
  }
}

export function match(path: string, line: number, text = `needle on line ${line}`): SearchMatch {
  const start = text.indexOf("needle");
  return {
    path,
    line,
    column: start + 1,
    lineText: text,
    ranges: start === -1 ? [] : [{ start, end: start + 6 }],
    lineTextStart: 0,
    clippedStart: false,
    clippedEnd: false,
  };
}

/** A file index whose first listing can be held back with `gate`. */
export class FakeIndex implements QuickOpenIndex {
  listCalls = 0;
  invalidations = 0;
  private cached: FileIndexResult | null = null;
  private release: (() => void) | null = null;
  private gate: Promise<void> | null = null;

  constructor(
    private files: readonly string[],
    private readonly truncated = false,
  ) {}

  hold(): void {
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  open(): void {
    this.release?.();
    this.gate = null;
  }

  setFiles(files: readonly string[]): void {
    this.files = files;
  }

  peek = (): FileIndexResult | null => this.cached;

  invalidate = (): void => {
    this.invalidations++;
    this.cached = null;
  };

  list = async (signal?: AbortSignal): Promise<FileIndexResult> => {
    this.listCalls++;
    if (this.gate) {
      const gate = this.gate;
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new LucyError("CANCELLED", "Operation cancelled")), {
          once: true,
        });
        void gate.then(resolve);
      });
    }
    this.cached = { files: this.files, truncated: this.truncated, strategy: "walk", durationMs: 1 };
    return this.cached;
  };
}
