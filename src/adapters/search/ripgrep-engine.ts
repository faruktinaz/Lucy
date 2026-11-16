/**
 * Content search with ripgrep: `rg --json`, streamed line by line, killed as soon as the
 * result cap is exceeded or the search is cancelled.
 *
 * Dialect: Rust regex syntax (no look-around or backreferences). Case-insensitive matching
 * uses Unicode simple case folding, so "ğ" matches "Ğ" but ASCII "i" does not match Turkish
 * "İ" or "ı". Whole word uses Unicode word boundaries. Hidden files are searched; `.git`
 * and Git-ignored files are not (ripgrep honors ignore files inside repositories).
 *
 * Limits: files above `maxFileBytes` are skipped by ripgrep (`--max-filesize`). ripgrep's own
 * `--max-columns` is ignored in `--json` mode (verified with ripgrep 14.1.1), so line length is
 * bounded while reading the stream instead: a JSON record longer than `maxLineBytes` is cut by
 * `runStreaming`, cannot be decoded, and is counted as a `long-line` limit hit.
 */
import { LucyError } from "@/core/errors";
import { runStreaming } from "@/core/process";
import type { CompiledQuery } from "./compile-query";
import { buildMatch, utf8ToUtf16Offsets } from "./line-preview";
import type { MatchSink } from "./match-sink";
import {
  DEFAULT_SEARCH_LIMITS,
  InvalidPatternError,
  type SearchLimits,
  type SearchMatch,
} from "./search-types";

const FLUSH_EVERY = 200;
/** Safety net only: the UI cancels searches it no longer needs. */
export const SEARCH_TIMEOUT_MS = 5 * 60_000;

interface DecodedText {
  readonly text: string;
  /** Raw bytes when ripgrep had to base64-encode invalid UTF-8. */
  readonly bytes: Uint8Array | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function decodeData(value: unknown): DecodedText | null {
  const data = record(value);
  if (!data) return null;
  if (typeof data.text === "string") return { text: data.text, bytes: null };
  if (typeof data.bytes === "string") {
    const bytes = Uint8Array.from(Buffer.from(data.bytes, "base64"));
    return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), bytes };
  }
  return null;
}

function toUtf16(decoded: DecodedText, offsets: number[]): number[] {
  if (!decoded.bytes) return utf8ToUtf16Offsets(decoded.text, offsets);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const bytes = decoded.bytes;
  return offsets.map((offset) => decoder.decode(bytes.subarray(0, offset)).length);
}

export function ripgrepArgs(
  rg: string,
  query: CompiledQuery,
  limits: Pick<SearchLimits, "maxFileBytes"> = DEFAULT_SEARCH_LIMITS,
): string[] {
  const args = [rg, "--json", "--no-config", "--hidden", "--no-messages", "--glob", "!.git"];
  // A plain byte count: ripgrep also accepts K/M/G suffixes, but needs none.
  args.push("--max-filesize", String(Math.max(1, Math.floor(limits.maxFileBytes))));
  args.push(query.caseSensitive ? "--case-sensitive" : "--ignore-case");
  if (query.wholeWord) args.push("--word-regexp");
  if (!query.isRegex) args.push("--fixed-strings");
  for (const glob of query.include) args.push("--glob", glob);
  for (const glob of query.exclude) args.push("--glob", `!${glob}`);
  args.push("-e", query.pattern, "--", ".");
  return args;
}

export async function searchWithRipgrep(
  rg: string,
  root: string,
  query: CompiledQuery,
  sink: MatchSink,
  signal: AbortSignal,
  env?: Record<string, string | undefined>,
  limits: SearchLimits = DEFAULT_SEARCH_LIMITS,
): Promise<void> {
  let buffer: SearchMatch[] = [];
  let stop = false;
  let kill: (() => void) | null = null;
  const flush = (): void => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    if (!sink.push(batch) && !stop) {
      stop = true;
      kill?.();
    }
  };
  const onLine = (line: string, truncated: boolean): void => {
    if (stop || line.length === 0) return;
    if (truncated) {
      // Only a match (or context) record carries line text, so only those grow this large.
      sink.markTruncated("long-line");
      return;
    }
    let message: Record<string, unknown> | null;
    try {
      message = record(JSON.parse(line));
    } catch {
      return;
    }
    if (!message) return;
    if (message.type === "end") {
      flush();
      return;
    }
    if (message.type !== "match") return;
    const data = record(message.data);
    const path = decodeData(data?.path);
    const lines = decodeData(data?.lines);
    const lineNumber = data?.line_number;
    const submatches = data?.submatches;
    if (!path || !lines || typeof lineNumber !== "number" || !Array.isArray(submatches)) return;
    const byteRanges: number[] = [];
    for (const submatch of submatches) {
      const entry = record(submatch);
      if (entry && typeof entry.start === "number" && typeof entry.end === "number") {
        byteRanges.push(entry.start, entry.end);
      }
    }
    if (byteRanges.length === 0) return;
    const offsets = toUtf16(lines, byteRanges);
    const ranges: Array<[number, number]> = [];
    for (let i = 0; i < offsets.length; i += 2) ranges.push([offsets[i] as number, offsets[i + 1] as number]);
    const rel = path.text.startsWith("./") ? path.text.slice(2) : path.text;
    const match = buildMatch(rel, lineNumber, lines.text, ranges);
    if (match) buffer.push(match);
    if (buffer.length >= FLUSH_EVERY || buffer.length > sink.remaining) flush();
  };

  const handle = runStreaming(ripgrepArgs(rg, query, limits), {
    cwd: root,
    env,
    signal,
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxLineBytes: limits.maxLineBytes,
    onLine,
  });
  kill = handle.kill;
  const result = await handle.done;
  flush();
  if (stop || signal.aborted) return;
  if (result.timedOut) {
    sink.markTruncated("time-budget");
    return;
  }
  // 0: matches, 1: no match, 2: an error (possibly alongside matches, e.g. unreadable files).
  if (
    result.code === 2 &&
    /regex parse error|error parsing|unclosed|unopened|repetition/i.test(result.stderr)
  ) {
    const reason =
      result.stderr
        .split("\n")
        .find((line) => /^error:/.test(line.trim()))
        ?.trim() ?? "";
    throw new InvalidPatternError(query.pattern, reason.replace(/^error:\s*/, "") || result.stderr.trim());
  }
  if (result.code !== 0 && result.code !== 1 && result.code !== 2) {
    throw new LucyError("PROCESS_FAILED", "ripgrep failed", {
      details: { code: result.code, signal: result.signal, stderr: result.stderr.slice(0, 500) },
    });
  }
}
