/**
 * Worker entry point for user regexes (never imported by the app; loaded by URL from
 * `client.ts`). Registering the message handler at the top level is how a worker starts, so
 * this module has an effect on load.
 *
 * Isolation is the whole point: a catastrophically backtracking pattern blocks only this
 * thread, and the main thread terminates the worker when its time budget runs out. The scan
 * itself is synchronous; cancellation is likewise a termination.
 */
import { collectLineMatches, type LineMatch } from "./line-matches";
import type { WorkerResponse, WorkerSearchRequest } from "./protocol";

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerSearchRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: ArrayBuffer[]): void;
}

const scope = globalThis as unknown as WorkerScope;

/** Results are streamed so the first matches show while a slow regex is still running. */
const FLUSH_MS = 25;
const CLOCK_EVERY = 64;

let cachedVersion = -1;
let cachedLines: readonly string[] = [];

function flush(id: number, batch: LineMatch[]): void {
  if (batch.length === 0) return;
  const data = new Int32Array(batch.length * 3);
  batch.forEach((match, i) => {
    data[i * 3] = match.line;
    data[i * 3 + 1] = match.start;
    data[i * 3 + 2] = match.end;
  });
  batch.length = 0;
  scope.postMessage({ type: "batch", id, data }, [data.buffer]);
}

function search(request: WorkerSearchRequest): void {
  if (request.lines !== undefined) {
    cachedLines = request.lines;
    cachedVersion = request.version;
  }
  if (request.version !== cachedVersion) {
    scope.postMessage({ type: "error", id: request.id, message: "The text is not loaded in the worker" });
    return;
  }
  const regex = new RegExp(request.source, request.flags);
  const probe = request.maxMatches + 1;
  const perLine = request.maxMatchesPerLine ?? Number.POSITIVE_INFINITY;
  const maxLines = request.maxLines ?? Number.POSITIVE_INFINITY;
  const batch: LineMatch[] = [];
  let total = 0;
  let matchedLines = 0;
  let linesLimitHit = false;
  let nextFlush = performance.now() + FLUSH_MS;
  for (let line = 0; line < cachedLines.length; line++) {
    const before = batch.length;
    collectLineMatches(
      regex,
      cachedLines[line] as string,
      line,
      batch,
      before + Math.min(probe - total, perLine),
    );
    const added = batch.length - before;
    total += added;
    if (total >= probe) break;
    if (added > 0 && ++matchedLines >= maxLines) {
      linesLimitHit = line < cachedLines.length - 1;
      break;
    }
    if (line % CLOCK_EVERY === 0 && performance.now() >= nextFlush) {
      flush(request.id, batch);
      nextFlush = performance.now() + FLUSH_MS;
    }
  }
  const limitHit = total > request.maxMatches || linesLimitHit;
  if (total > request.maxMatches) batch.length -= total - request.maxMatches;
  flush(request.id, batch);
  scope.postMessage({ type: "done", id: request.id, limitHit });
}

scope.onmessage = (event) => {
  try {
    search(event.data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scope.postMessage({ type: "error", id: event.data.id, message });
  }
};
