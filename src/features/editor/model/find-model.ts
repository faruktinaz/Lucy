/**
 * In-file find for the viewer: query and options in, matches and the current match out, all
 * in a `Store`.
 *
 * Matching runs off the critical path: literal queries scan in 8 ms slices on this thread
 * (the first slice synchronously, so small files never show "Searching…"); regex queries run
 * in a worker with a hard time budget (see `src/core/regex-worker/client.ts`). Changing the query,
 * options or document cancels the running search. Results are capped (`maxMatches`).
 */
import { isLucyError } from "@/core/errors";
import type { Disposable } from "@/core/events";
import { RegexWorkerClient } from "@/core/regex-worker/client";
import { Store } from "@/core/store";
import { type FindMatch, firstMatchAtOrAfter, lineMatchRange, matchesOnLine } from "./find-matches";
import {
  type CompiledFindQuery,
  compileFindQuery,
  DEFAULT_FIND_OPTIONS,
  type FindOptions,
} from "./find-query";
import { type ScanOutcome, scanLines } from "./find-scanner";

export type FindStatus =
  /** No query. */
  | "idle"
  | "searching"
  | "done"
  /** The regex does not compile; see `error`. */
  | "invalid"
  /** The regex ran out of time; `matches` holds what was found until then. */
  | "stopped";

export interface FindPosition {
  readonly line: number;
  readonly column: number;
}

export interface FindState {
  readonly query: string;
  readonly options: FindOptions;
  readonly matches: readonly FindMatch[];
  /** Index into `matches`, or -1. */
  readonly current: number;
  readonly status: FindStatus;
  /** More matches exist than `maxMatches`. */
  readonly limitHit: boolean;
  /** Invalid-regex or time-budget message, display-ready. */
  readonly error: string | null;
  /** "3 of 17", "No results", "10000+", "Searching…" or "" (no query). */
  readonly label: string;
}

export interface FindModelOptions {
  /** Default 10,000. */
  readonly maxMatches?: number;
  /** Hard limit for one regex search. Default 2,000 ms. */
  readonly regexBudgetMs?: number;
  /** Slice length of the in-thread scanner. Default 8 ms. */
  readonly sliceMs?: number;
  /** "inline" skips the worker (soft budget only); for environments without workers. */
  readonly regexEngine?: "worker" | "inline";
}

export const DEFAULT_MAX_FIND_MATCHES = 10_000;
export const DEFAULT_REGEX_BUDGET_MS = 2_000;

export function formatFindLabel(
  state: Pick<FindState, "query" | "status" | "matches" | "current" | "limitHit">,
): string {
  if (state.query === "") return "";
  if (state.status === "invalid") return "No results";
  const count = state.matches.length;
  if (count === 0) return state.status === "searching" ? "Searching…" : "No results";
  const total = state.limitHit ? `${count}+` : String(count);
  if (state.current >= 0) return `${state.current + 1} of ${total}`;
  return state.status === "searching" ? `${total}…` : total;
}

function withLabel(state: Omit<FindState, "label">): FindState {
  return { ...state, label: formatFindLabel(state) };
}

const EMPTY_LINES: readonly string[] = Object.freeze([""]);

export class FindModel implements Disposable {
  readonly store: Store<FindState>;
  readonly #maxMatches: number;
  readonly #budgetMs: number;
  readonly #sliceMs: number;
  readonly #engine: "worker" | "inline";
  #worker: RegexWorkerClient | null = null;
  #lines: readonly string[] = EMPTY_LINES;
  #version = 0;
  #anchor: FindPosition = { line: 0, column: 0 };
  #controller: AbortController | null = null;
  #running: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(options: FindModelOptions = {}) {
    this.#maxMatches = Math.max(1, Math.floor(options.maxMatches ?? DEFAULT_MAX_FIND_MATCHES));
    this.#budgetMs = options.regexBudgetMs ?? DEFAULT_REGEX_BUDGET_MS;
    this.#sliceMs = options.sliceMs ?? 8;
    this.#engine = options.regexEngine ?? "worker";
    this.store = new Store<FindState>(
      withLabel({
        query: "",
        options: DEFAULT_FIND_OPTIONS,
        matches: [],
        current: -1,
        status: "idle",
        limitHit: false,
        error: null,
      }),
    );
  }

  get currentMatch(): FindMatch | null {
    const { matches, current } = this.store.get();
    return current >= 0 ? (matches[current] ?? null) : null;
  }

  /**
   * Sets the document (viewer lines, see `documentLines`). A reload re-runs the query and keeps
   * the current match's position as the anchor, so the selection stays where the reader was.
   */
  setDocument(lines: readonly string[]): void {
    if (lines === this.#lines) return;
    this.#lines = lines.length === 0 ? EMPTY_LINES : lines;
    this.#version++;
    const current = this.currentMatch;
    if (current) this.#anchor = { line: current.line, column: current.start };
    this.#restart();
  }

  /**
   * Updates the query. `from` is where the first "current" match is searched from (usually
   * the active line); it is kept for later queries when omitted.
   */
  setQuery(query: string, from?: FindPosition): void {
    if (from) this.#anchor = from;
    if (query === this.store.get().query && !from) return;
    this.store.update({ query });
    this.#restart();
  }

  setOptions(options: Partial<FindOptions>): void {
    const next = { ...this.store.get().options, ...options };
    const prev = this.store.get().options;
    if (
      next.caseSensitive === prev.caseSensitive &&
      next.wholeWord === prev.wholeWord &&
      next.regex === prev.regex
    ) {
      return;
    }
    const current = this.currentMatch;
    if (current) this.#anchor = { line: current.line, column: current.start };
    this.store.update({ options: next });
    this.#restart();
  }

  toggleOption(name: keyof FindOptions): void {
    this.setOptions({ [name]: !this.store.get().options[name] });
  }

  /** Selects the next match (wrapping around at the end). Returns it, or `null` without matches. */
  next(): FindMatch | null {
    return this.#step(1);
  }

  previous(): FindMatch | null {
    return this.#step(-1);
  }

  /** Makes the match at `index` current (e.g. a click on a highlighted match). */
  select(index: number): FindMatch | null {
    const { matches } = this.store.get();
    if (index < 0 || index >= matches.length) return null;
    this.#setCurrent(index);
    return matches[index] ?? null;
  }

  /** Matches on a 0-based line; O(log n). */
  matchesOnLine(line: number): readonly FindMatch[] {
    return matchesOnLine(this.store.get().matches, line);
  }

  /** `[from, to)` indices into `matches` for a line, without allocating. */
  lineMatchRange(line: number): readonly [number, number] {
    return lineMatchRange(this.store.get().matches, line);
  }

  /** Resolves when the current search (if any) has finished, failed or been superseded. */
  async whenIdle(): Promise<void> {
    let running: Promise<void>;
    do {
      running = this.#running;
      await running;
    } while (running !== this.#running);
  }

  clear(): void {
    this.setQuery("");
  }

  dispose(): void {
    this.#disposed = true;
    this.#controller?.abort();
    this.#controller = null;
    this.#worker?.dispose();
    this.#worker = null;
  }

  #step(direction: 1 | -1): FindMatch | null {
    const { matches, current, status } = this.store.get();
    if (matches.length === 0) return null;
    const complete = status !== "searching";
    let index: number;
    if (current < 0) {
      const after = firstMatchAtOrAfter(matches, this.#anchor.line, this.#anchor.column);
      if (direction === 1) index = after >= 0 ? after : complete ? 0 : matches.length - 1;
      else
        index =
          after > 0 ? after - 1 : after === 0 ? (complete ? matches.length - 1 : 0) : matches.length - 1;
    } else {
      index = current + direction;
      // While still searching, the ends of the list are not the ends of the document: stay put.
      if (index >= matches.length) index = complete ? 0 : current;
      else if (index < 0) index = complete ? matches.length - 1 : current;
    }
    this.#setCurrent(index);
    const match = matches[index] as FindMatch;
    this.#anchor = { line: match.line, column: match.start };
    return match;
  }

  #setCurrent(current: number): void {
    this.store.set((state) => (state.current === current ? state : withLabel({ ...state, current })));
  }

  #restart(): void {
    this.#controller?.abort();
    this.#controller = null;
    if (this.#disposed) return;
    const { query, options } = this.store.get();
    const compiled = compileFindQuery(query, options);
    const base = { query, options, matches: [] as FindMatch[], current: -1, limitHit: false };
    if (compiled.kind === "empty") {
      this.store.set(withLabel({ ...base, status: "idle", error: null }));
      return;
    }
    if (compiled.kind === "invalid") {
      this.store.set(withLabel({ ...base, status: "invalid", error: compiled.message }));
      return;
    }
    this.store.set(withLabel({ ...base, status: "searching", error: null }));
    const controller = new AbortController();
    this.#controller = controller;
    this.#running = this.#search(compiled, controller);
  }

  async #search(
    compiled: Extract<CompiledFindQuery, { kind: "ok" }>,
    controller: AbortController,
  ): Promise<void> {
    const lines = this.#lines;
    const anchor = this.#anchor;
    const onBatch = (batch: FindMatch[]): void => {
      if (controller.signal.aborted) return;
      this.store.set((state) => {
        const matches = state.matches.concat(batch);
        let current = state.current;
        if (current < 0) {
          // Matches arrive in document order, so the first one at or after the anchor is final.
          const index = firstMatchAtOrAfter(batch, anchor.line, anchor.column);
          if (index >= 0) current = state.matches.length + index;
        }
        return withLabel({ ...state, matches, current });
      });
    };
    let outcome: ScanOutcome;
    try {
      outcome = await this.#scan(compiled, lines, controller.signal, onBatch);
    } catch (error) {
      if (isLucyError(error, "CANCELLED") || controller.signal.aborted) return;
      this.store.set((state) =>
        withLabel({ ...state, status: "invalid", error: "Find failed: the pattern could not be evaluated." }),
      );
      return;
    }
    if (controller.signal.aborted) return;
    if (this.#controller === controller) this.#controller = null;
    this.store.set((state) => {
      const current = state.current < 0 && state.matches.length > 0 ? 0 : state.current;
      const seconds = (this.#budgetMs / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 });
      return withLabel({
        ...state,
        current,
        limitHit: outcome.limitHit,
        status: outcome.timedOut ? "stopped" : "done",
        error: outcome.timedOut
          ? `The regular expression took longer than ${seconds} s and was stopped; results may be incomplete.`
          : null,
      });
    });
  }

  async #scan(
    compiled: Extract<CompiledFindQuery, { kind: "ok" }>,
    lines: readonly string[],
    signal: AbortSignal,
    onBatch: (batch: FindMatch[]) => void,
  ): Promise<ScanOutcome> {
    if (compiled.untrusted && this.#engine === "worker") {
      this.#worker ??= new RegexWorkerClient();
      if (this.#worker.available) {
        try {
          return await this.#worker.run({
            lines,
            version: this.#version,
            source: compiled.source,
            flags: compiled.flags,
            maxMatches: this.#maxMatches,
            budgetMs: this.#budgetMs,
            signal,
            onBatch,
          });
        } catch (error) {
          // A worker that cannot start degrades to the in-thread scanner with a soft budget.
          if (!isLucyError(error, "UNSUPPORTED")) throw error;
          if (signal.aborted) throw error;
          // Drop anything a crashed worker delivered before failing; the rescan reports it again.
          this.store.set((state) => withLabel({ ...state, matches: [], current: -1 }));
        }
      }
    }
    return scanLines(lines, new RegExp(compiled.source, compiled.flags), {
      maxMatches: this.#maxMatches,
      sliceMs: this.#sliceMs,
      budgetMs: compiled.untrusted ? this.#budgetMs : undefined,
      signal,
      onBatch,
    });
  }
}
