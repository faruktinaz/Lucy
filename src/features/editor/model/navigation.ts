/**
 * Pure navigation transitions for the read-only viewer: moving the active line and keeping it
 * visible. Every function returns the same reference when nothing changes, so a Store update
 * with the result does not notify listeners for no-op key presses at the document edges.
 *
 * Rows: these functions treat one document line as one screen row. With word wrap on, a line
 * can span several rows; the view then passes the number of *lines* that fit (a conservative
 * estimate is fine: the margin absorbs the difference).
 */
import type { ViewerState } from "./viewer-state";

/** Lines kept between the active line and the viewport edge, like Vim's `scrolloff`. */
export const DEFAULT_SCROLL_MARGIN = 2;

export interface ViewportMetrics {
  readonly lineCount: number;
  /** Visible lines (at least 1 is assumed). */
  readonly viewportHeight: number;
  /** Defaults to `DEFAULT_SCROLL_MARGIN`. Shrinks automatically for tiny viewports. */
  readonly margin?: number;
}

export type ViewerMove =
  | { readonly kind: "lines"; readonly delta: number }
  | { readonly kind: "pages"; readonly delta: number }
  | { readonly kind: "start" }
  | { readonly kind: "end" }
  /** Jump to a line (go to line, find): centers it when it was off screen. */
  | { readonly kind: "line"; readonly line: number };

function rows(height: number): number {
  return Math.max(1, Math.floor(height));
}

export function clampLine(line: number, lineCount: number): number {
  if (lineCount <= 0 || !Number.isFinite(line)) return 0;
  return Math.max(0, Math.min(lineCount - 1, Math.trunc(line)));
}

/** Largest useful scroll position: the last line sits at the bottom of the viewport. */
export function maxScrollTop(lineCount: number, viewportHeight: number): number {
  return Math.max(0, lineCount - rows(viewportHeight));
}

export function clampScrollTop(scrollTop: number, lineCount: number, viewportHeight: number): number {
  if (!Number.isFinite(scrollTop)) return 0;
  return Math.max(0, Math.min(maxScrollTop(lineCount, viewportHeight), Math.trunc(scrollTop)));
}

/** Lines moved by Page Up/Down: one line of overlap keeps the reader oriented. */
export function pageSize(viewportHeight: number): number {
  return Math.max(1, rows(viewportHeight) - 1);
}

function effectiveMargin(metrics: ViewportMetrics): number {
  const margin = Math.max(0, Math.floor(metrics.margin ?? DEFAULT_SCROLL_MARGIN));
  // With a margin of half the viewport or more the line could never be revealed in place.
  return Math.min(margin, Math.floor((rows(metrics.viewportHeight) - 1) / 2));
}

/**
 * The scroll position that shows `line` with `margin` lines of context, moving as little as
 * possible ("nearest"), or centering the line when it is outside the viewport ("center").
 */
export function scrollToReveal(
  scrollTop: number,
  line: number,
  metrics: ViewportMetrics,
  align: "nearest" | "center" = "nearest",
): number {
  const height = rows(metrics.viewportHeight);
  const target = clampLine(line, metrics.lineCount);
  const top = clampScrollTop(scrollTop, metrics.lineCount, height);
  if (align === "center" && (target < top || target > top + height - 1)) {
    return clampScrollTop(target - Math.floor((height - 1) / 2), metrics.lineCount, height);
  }
  const margin = effectiveMargin(metrics);
  let next = top;
  if (target < top + margin) next = target - margin;
  else if (target > top + height - 1 - margin) next = target - height + 1 + margin;
  return clampScrollTop(next, metrics.lineCount, height);
}

function withPosition(state: ViewerState, activeLine: number, scrollTop: number): ViewerState {
  return activeLine === state.activeLine && scrollTop === state.scrollTop
    ? state
    : { ...state, activeLine, scrollTop };
}

/** Applies a move and scrolls just enough to keep the active line visible. */
export function moveActiveLine(state: ViewerState, move: ViewerMove, metrics: ViewportMetrics): ViewerState {
  const { lineCount } = metrics;
  const height = rows(metrics.viewportHeight);
  const current = clampLine(state.activeLine, lineCount);
  switch (move.kind) {
    case "lines": {
      const line = clampLine(current + Math.trunc(move.delta), lineCount);
      return withPosition(state, line, scrollToReveal(state.scrollTop, line, metrics));
    }
    case "pages": {
      // Scroll by the same amount as the cursor so the active line keeps its screen row, as
      // in VS Code and less(1); at the document edges the cursor still reaches the first/last line.
      const delta = Math.trunc(move.delta) * pageSize(height);
      const line = clampLine(current + delta, lineCount);
      const scrolled = clampScrollTop(state.scrollTop + delta, lineCount, height);
      return withPosition(state, line, scrollToReveal(scrolled, line, metrics));
    }
    case "start":
      return withPosition(state, 0, 0);
    case "end": {
      const line = clampLine(lineCount - 1, lineCount);
      return withPosition(state, line, maxScrollTop(lineCount, height));
    }
    case "line": {
      const line = clampLine(move.line, lineCount);
      return withPosition(state, line, scrollToReveal(state.scrollTop, line, metrics, "center"));
    }
  }
}

/** Mouse wheel / scrollbar: scrolls without moving the active line. */
export function scrollBy(state: ViewerState, delta: number, metrics: ViewportMetrics): ViewerState {
  const scrollTop = clampScrollTop(
    state.scrollTop + Math.trunc(delta),
    metrics.lineCount,
    metrics.viewportHeight,
  );
  return scrollTop === state.scrollTop ? state : { ...state, scrollTop };
}

/** Horizontal scroll in cells; never negative. Ignored while wrapping. */
export function scrollHorizontally(state: ViewerState, delta: number): ViewerState {
  if (state.wrap) return state;
  const scrollLeft = Math.max(0, Math.trunc(state.scrollLeft + delta));
  return scrollLeft === state.scrollLeft ? state : { ...state, scrollLeft };
}

/**
 * Fits restored or pre-reload state to a (new) document: the active line and scroll position
 * are kept when still valid and clamped otherwise. Without a viewport height, the scroll
 * position is only clamped to the last line (the view re-clamps once it knows its size).
 */
export function clampViewerState(
  state: ViewerState,
  lineCount: number,
  viewportHeight?: number,
): ViewerState {
  const activeLine = clampLine(state.activeLine, lineCount);
  const scrollTop =
    viewportHeight === undefined
      ? Math.max(0, Math.min(Math.trunc(state.scrollTop), Math.max(0, lineCount - 1)))
      : clampScrollTop(state.scrollTop, lineCount, viewportHeight);
  return withPosition(state, activeLine, scrollTop);
}
