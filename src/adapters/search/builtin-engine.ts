/**
 * Pure JavaScript content search over the `FileIndex` file list: used when neither ripgrep
 * nor a Git repository is available.
 *
 * - Skips symlinks, non-regular files, files over `maxFileBytes`, and binaries (NUL in the
 *   first 8 KiB, as Git and ripgrep do).
 * - Literal search scans the whole file on this thread in time slices (`indexOf`, or the
 *   escaped-literal regex for case-insensitive / whole-word, which cannot backtrack
 *   catastrophically) and maps hits to lines.
 * - Regex search runs per line in the shared regex worker (`src/core/regex-worker/client.ts`),
 *   one file at a time: a user pattern meeting adversarial content (`(a+)+$`) blocks only the
 *   worker, which is terminated when the file's budget runs out or the search is cancelled. Only
 *   if the worker cannot start does the in-thread scanner run, with budgets checked between lines.
 * - Bounded read concurrency, yields to the event loop between files and every few hundred
 *   lines, per-file and overall time budgets (a budget hit marks the result truncated with
 *   `time-budget`).
 */
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { forEachConcurrent, TimeSlicer } from "@/adapters/filesystem/async-util";
import { SNIFF_BYTES } from "@/adapters/filesystem/file-sniff";
import { isLucyError } from "@/core/errors";
import { RegexWorkerClient } from "@/core/regex-worker/client";
import type { LineMatch } from "@/core/regex-worker/line-matches";
import { type CompiledQuery, createPathFilter, findRanges, requireRegex } from "./compile-query";
import { buildMatch } from "./line-preview";
import type { MatchSink } from "./match-sink";
import type { SearchMatch } from "./search-types";

export interface BuiltinLimits {
  /** Larger files are skipped. Default 1 MiB. */
  readonly maxFileBytes: number;
  /** Files read in parallel. Default 8. */
  readonly concurrency: number;
  /** Scanning one file stops after this long. Default 1 s. */
  readonly perFileBudgetMs: number;
  /** The whole search stops after this long. Default 60 s. */
  readonly overallBudgetMs: number;
}

export const DEFAULT_BUILTIN_LIMITS: BuiltinLimits = {
  maxFileBytes: 1024 * 1024,
  concurrency: 8,
  perFileBudgetMs: 1000,
  overallBudgetMs: 60_000,
};

interface ScanState {
  readonly query: CompiledQuery;
  readonly regex: RegExp;
  readonly slicer: TimeSlicer;
  readonly deadline: number;
  /** Stop collecting after this many matching lines (cap + 1 detects truncation). */
  readonly room: number;
  budgetHit: boolean;
}

interface LineHits {
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly ranges: Array<[number, number]>;
}

/** Literal search over the whole text, hits grouped into lines. */
async function scanLiteral(path: string, text: string, state: ScanState): Promise<SearchMatch[]> {
  const out: SearchMatch[] = [];
  const { query, regex } = state;
  const plain = query.caseSensitive && !query.wholeWord ? query.pattern : null;
  const emit = (hits: LineHits | null): void => {
    if (!hits) return;
    const match = buildMatch(path, hits.line, text.slice(hits.start, hits.end), hits.ranges);
    if (match) out.push(match);
  };
  let lineNumber = 1;
  let lineStart = 0;
  let current: LineHits | null = null;
  let from = 0;
  regex.lastIndex = 0;
  for (let hits = 0; ; hits++) {
    let start: number;
    let end: number;
    if (plain !== null) {
      start = text.indexOf(plain, from);
      if (start === -1) break;
      end = start + plain.length;
      from = end > start ? end : start + 1;
    } else {
      const found = regex.exec(text);
      if (!found) break;
      start = found.index;
      end = start + found[0].length;
      if (end === start) regex.lastIndex = start + 1;
    }
    // Advance the line counter to the hit.
    for (let newline = text.indexOf("\n", lineStart); newline !== -1 && newline < start; ) {
      lineNumber++;
      lineStart = newline + 1;
      newline = text.indexOf("\n", lineStart);
    }
    if (current === null || current.line !== lineNumber) {
      emit(current);
      current = null;
      if (out.length >= state.room) break;
      const lineEnd = text.indexOf("\n", start);
      current = {
        line: lineNumber,
        start: lineStart,
        end: lineEnd === -1 ? text.length : lineEnd,
        ranges: [],
      };
    }
    if (current.ranges.length < 100) {
      current.ranges.push([start - current.start, Math.min(end, current.end) - current.start]);
    }
    if ((hits & 255) === 255) {
      if (performance.now() > state.deadline) {
        state.budgetHit = true;
        break;
      }
      if (state.slicer.shouldYield) await state.slicer.yieldNow();
    }
  }
  regex.lastIndex = 0;
  emit(current);
  return out.slice(0, state.room);
}

/** Regex search line by line (patterns may use ^, $ and look-around per line). */
async function scanRegex(path: string, text: string, state: ScanState): Promise<SearchMatch[]> {
  const out: SearchMatch[] = [];
  let lineNumber = 0;
  let start = 0;
  while (start <= text.length && out.length < state.room) {
    lineNumber++;
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    if (end === text.length && start === end && lineNumber > 1) break; // Trailing newline.
    const line = text.slice(start, end);
    const ranges = findRanges(state.regex, line.endsWith("\r") ? line.slice(0, -1) : line, 100);
    if (ranges.length > 0) {
      const match = buildMatch(path, lineNumber, line, ranges);
      if (match) out.push(match);
    }
    if ((lineNumber & 255) === 0) {
      if (performance.now() > state.deadline) {
        state.budgetHit = true;
        break;
      }
      if (state.slicer.shouldYield) await state.slicer.yieldNow();
    }
    if (newline === -1) break;
    start = newline + 1;
  }
  return out;
}

/** Matches kept per line, as in the other engines (`buildMatch` keeps at most 100 ranges). */
const MAX_RANGES_PER_LINE = 100;

/** Lines for matching: split on "\n", a trailing "\r" removed, no phantom line after a final newline. */
function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.endsWith("\r")) lines[i] = line.slice(0, -1);
  }
  return lines;
}

/** Turns the worker's per-match results (document order) into one `SearchMatch` per line. */
function groupMatches(path: string, lines: readonly string[], found: readonly LineMatch[]): SearchMatch[] {
  const out: SearchMatch[] = [];
  let index = 0;
  while (index < found.length) {
    const line = (found[index] as LineMatch).line;
    const ranges: Array<[number, number]> = [];
    for (; index < found.length && (found[index] as LineMatch).line === line; index++) {
      const match = found[index] as LineMatch;
      ranges.push([match.start, match.end]);
    }
    const built = buildMatch(path, line + 1, lines[line] ?? "", ranges);
    if (built) out.push(built);
  }
  return out;
}

/**
 * The search's regex worker. A client runs one regex at a time, so files queue here; each file's
 * budget starts when its turn comes, not while it waits.
 */
class RegexLane {
  readonly client = new RegexWorkerClient();
  private tail: Promise<unknown> = Promise.resolve();
  private version = 0;

  nextVersion(): number {
    return ++this.version;
  }

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => {});
    return result;
  }
}

/**
 * Regex search of one file in the worker. Returns `null` when the worker is unavailable (the
 * caller then scans in-thread).
 */
async function scanRegexInWorker(
  path: string,
  text: string,
  regex: RegExp,
  lane: RegexLane,
  sink: MatchSink,
  budget: { readonly perFileMs: number; readonly overallDeadline: number },
  signal: AbortSignal,
): Promise<{ matches: SearchMatch[]; budgetHit: boolean } | null> {
  return lane.enqueue(async () => {
    if (!lane.client.available) return null;
    if (sink.isStopped) return { matches: [], budgetHit: false };
    const budgetMs = Math.min(budget.perFileMs, budget.overallDeadline - performance.now());
    if (budgetMs <= 0) return { matches: [], budgetHit: true };
    const lines = splitLines(text);
    // One line more than can be delivered tells the sink that the result is truncated.
    const room = sink.remaining + 1;
    const found: LineMatch[] = [];
    try {
      const outcome = await lane.client.run({
        lines,
        version: lane.nextVersion(),
        source: regex.source,
        flags: regex.flags,
        maxMatches: room * MAX_RANGES_PER_LINE,
        maxMatchesPerLine: MAX_RANGES_PER_LINE,
        maxLines: room,
        budgetMs,
        signal,
        onBatch: (batch) => {
          for (const match of batch) found.push(match);
        },
      });
      return { matches: groupMatches(path, lines, found), budgetHit: outcome.timedOut };
    } catch (error) {
      if (isLucyError(error, "UNSUPPORTED")) return null;
      throw error;
    }
  });
}

export async function searchBuiltin(
  root: string,
  files: readonly string[],
  query: CompiledQuery,
  sink: MatchSink,
  signal: AbortSignal,
  limits: Partial<BuiltinLimits> = {},
): Promise<void> {
  const config = { ...DEFAULT_BUILTIN_LIMITS, ...limits };
  const regex = requireRegex(query);
  const accept = createPathFilter(query.include, query.exclude);
  const candidates = files.filter(accept);
  const overallDeadline = performance.now() + config.overallBudgetMs;
  const slicer = new TimeSlicer(8, signal);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const lane = query.isRegex ? new RegexLane() : null;
  let stop = false;

  try {
    await forEachConcurrent(
      candidates,
      config.concurrency,
      async (path) => {
        if (stop || sink.isStopped) return;
        if (performance.now() > overallDeadline) {
          sink.markTruncated("time-budget");
          stop = true;
          return;
        }
        const abs = join(root, ...path.split("/"));
        let bytes: Uint8Array;
        try {
          const info = await lstat(abs);
          if (!info.isFile() || info.size > config.maxFileBytes) return;
          bytes = await readFile(abs);
        } catch {
          return; // Vanished or unreadable since listing.
        }
        if (stop || sink.isStopped) return;
        if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return;
        const text = decoder.decode(bytes);
        let scanned: { matches: SearchMatch[]; budgetHit: boolean } | null = null;
        if (lane) {
          const budget = { perFileMs: config.perFileBudgetMs, overallDeadline };
          scanned = await scanRegexInWorker(path, text, regex, lane, sink, budget, signal);
        }
        if (scanned === null) {
          const state: ScanState = {
            query,
            // Each concurrent scan needs its own lastIndex.
            regex: new RegExp(regex.source, regex.flags),
            slicer,
            deadline: Math.min(overallDeadline, performance.now() + config.perFileBudgetMs),
            room: sink.remaining + 1,
            budgetHit: false,
          };
          // In-thread fallback for regexes only when the worker cannot run (soft budget).
          const matches = query.isRegex
            ? await scanRegex(path, text, state)
            : await scanLiteral(path, text, state);
          scanned = { matches, budgetHit: state.budgetHit };
        }
        if (scanned.budgetHit) sink.markTruncated("time-budget");
        if (!sink.push(scanned.matches)) stop = true;
        if (slicer.shouldYield) await slicer.yieldNow();
      },
      signal,
    );
  } finally {
    lane?.client.dispose();
  }
}
