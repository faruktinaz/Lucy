/**
 * Collects engine output: enforces `maxResults`, counts files, forwards batches to the
 * caller, and stops delivering once the search is cancelled or settled.
 */
import { log } from "@/core/log";
import type { SearchLimitHit, SearchMatch } from "./search-types";

const logger = log.child("search:content");

export class MatchSink {
  matchCount = 0;
  fileCount = 0;
  /** More matches existed than were delivered, or a limit stopped or cut the scan. */
  truncated = false;
  private stopped = false;
  private readonly hits = new Set<SearchLimitHit>();
  private readonly files = new Set<string>();

  constructor(
    private readonly max: number,
    private readonly deliver: (matches: readonly SearchMatch[]) => void,
    private readonly signal: AbortSignal,
  ) {}

  get isStopped(): boolean {
    return this.stopped || this.signal.aborted;
  }

  /** Matches that can still be delivered. */
  get remaining(): number {
    return Math.max(0, this.max - this.matchCount);
  }

  /**
   * Delivers a batch (normally one file's matches). Returns false once the engine should
   * stop: a match beyond `maxResults` was seen (so the result is truncated) or the search
   * was cancelled.
   */
  push(matches: readonly SearchMatch[]): boolean {
    if (this.isStopped) return false;
    if (matches.length === 0) return true;
    let batch = matches;
    if (batch.length > this.remaining) {
      batch = batch.slice(0, this.remaining);
      this.markTruncated("max-results");
      this.stopped = true;
    }
    if (batch.length > 0) {
      for (const match of batch) {
        if (!this.files.has(match.path)) {
          this.files.add(match.path);
          this.fileCount++;
        }
      }
      this.matchCount += batch.length;
      try {
        this.deliver(batch);
      } catch (error) {
        logger.warn("onMatches listener threw", { error });
      }
    }
    return !this.stopped;
  }

  /** Records that the result is incomplete, and why. */
  markTruncated(reason: SearchLimitHit): void {
    this.truncated = true;
    this.hits.add(reason);
  }

  /** The reasons given to `markTruncated`, in the order first seen. */
  get limitsHit(): readonly SearchLimitHit[] {
    return [...this.hits];
  }

  /** No delivery happens after this (the search promise is about to settle). */
  close(): void {
    this.stopped = true;
  }
}
