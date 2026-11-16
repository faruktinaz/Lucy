/**
 * Per-tab viewer state: what workspace restore saves and what navigation transforms.
 *
 * Lines are 0-based indices here and everywhere in the model; only text shown to the user
 * (and external editors) is 1-based.
 */
import { Store } from "@/core/store";

export interface ViewerState {
  /** 0-based index of the active (highlighted) line. */
  readonly activeLine: number;
  /** 0-based index of the first visible line. */
  readonly scrollTop: number;
  /** Horizontal scroll in terminal cells (ignored while wrapping). */
  readonly scrollLeft: number;
  readonly wrap: boolean;
  /** Markdown: show the rendered preview instead of the source. */
  readonly markdownPreview: boolean;
}

/** JSON-safe form for workspace restore. `v` lets a later format migrate old snapshots. */
export interface ViewerStateSnapshot {
  readonly v: 1;
  readonly activeLine: number;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly wrap: boolean;
  readonly markdownPreview: boolean;
}

export interface ViewerStateDefaults {
  /** `editor.wrap`. */
  readonly wrap?: boolean;
}

export function createViewerState(defaults: ViewerStateDefaults = {}): ViewerState {
  return { activeLine: 0, scrollTop: 0, scrollLeft: 0, wrap: defaults.wrap ?? false, markdownPreview: false };
}

export function createViewerStore(initial?: ViewerState): Store<ViewerState> {
  return new Store<ViewerState>(initial ?? createViewerState());
}

export function exportViewerState(state: ViewerState): ViewerStateSnapshot {
  return {
    v: 1,
    activeLine: state.activeLine,
    scrollTop: state.scrollTop,
    scrollLeft: state.scrollLeft,
    wrap: state.wrap,
    markdownPreview: state.markdownPreview,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function index(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Rebuilds state from a saved snapshot. Restore data is user-editable on disk, so every field
 * is validated on its own and a bad field falls back to its default instead of discarding
 * the rest. Clamp to the document with `clampViewerState` once it has loaded.
 */
export function restoreViewerState(snapshot: unknown, defaults: ViewerStateDefaults = {}): ViewerState {
  const base = createViewerState(defaults);
  if (!isRecord(snapshot) || snapshot.v !== 1) return base;
  return {
    activeLine: index(snapshot.activeLine, base.activeLine),
    scrollTop: index(snapshot.scrollTop, base.scrollTop),
    scrollLeft: index(snapshot.scrollLeft, base.scrollLeft),
    wrap: flag(snapshot.wrap, base.wrap),
    markdownPreview: flag(snapshot.markdownPreview, base.markdownPreview),
  };
}
