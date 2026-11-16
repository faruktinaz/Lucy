/** Messages between `RegexWorkerClient` and `worker-entry.ts`. Types only. */

export interface WorkerSearchRequest {
  readonly type: "search";
  readonly id: number;
  /** Text version; `lines` is sent only when the worker does not have this version yet. */
  readonly version: number;
  readonly lines?: readonly string[];
  readonly source: string;
  readonly flags: string;
  /** Total matches reported at most (one more is looked for, to set `limitHit`). */
  readonly maxMatches: number;
  /** Matches reported per line at most; further matches on that line are skipped. Default: no cap. */
  readonly maxMatchesPerLine?: number;
  /** Stop after this many lines with a match (sets `limitHit`). Default: no cap. */
  readonly maxLines?: number;
}

export type WorkerResponse =
  /** Flat `[line, start, end, line, start, end, ...]`, transferred, in document order. */
  | { readonly type: "batch"; readonly id: number; readonly data: Int32Array }
  | { readonly type: "done"; readonly id: number; readonly limitHit: boolean }
  | { readonly type: "error"; readonly id: number; readonly message: string };

export function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (typeof value !== "object" || value === null) return false;
  const { type, id } = value as { type?: unknown; id?: unknown };
  return typeof id === "number" && (type === "batch" || type === "done" || type === "error");
}
