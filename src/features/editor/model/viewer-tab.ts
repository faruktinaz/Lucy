/**
 * One viewer tab: the loaded document plus its viewer state, both in `Store`s, and the
 * read-only reload policy (a changed file is reloaded automatically, keeping the position).
 *
 * The tab does not watch the filesystem itself. The workspace watcher calls
 * `checkForChanges()` for open tabs; after the terminal editor returns, the caller does too.
 */
import type { ViewerLimits } from "@/adapters/filesystem";
import { errorMessage, isLucyError } from "@/core/errors";
import type { Disposable } from "@/core/events";
import { Store } from "@/core/store";
import { decideReload, type FileObservation, observeFile, type ReloadDecision } from "./change-detection";
import { isLoadedDocument, type ViewerDocument } from "./document-types";
import { loadDocument, type SyntaxFacts, unavailableDocument } from "./load-document";
import { toggleMarkdownPreview } from "./markdown";
import { clampViewerState, moveActiveLine, type ViewerMove } from "./navigation";
import {
  createViewerState,
  exportViewerState,
  type ViewerState,
  type ViewerStateSnapshot,
} from "./viewer-state";

export interface ViewerTabOptions {
  /** Absolute workspace root. */
  readonly root: string;
  /** Workspace-relative POSIX path. */
  readonly path: string;
  readonly syntax: SyntaxFacts;
  readonly maxFileSizeMb?: number;
  readonly limits?: Partial<ViewerLimits>;
  /** Restored state (see `restoreViewerState`); clamped once the document has loaded. */
  readonly viewer?: ViewerState;
  /** `editor.wrap`, used when no state is restored. */
  readonly wrap?: boolean;
}

export interface ViewerTabState {
  readonly status: "idle" | "loading" | "ready";
  readonly document: ViewerDocument | null;
  /** Increments every time `document` is replaced; views key caches on it. */
  readonly revision: number;
  /** What the latest load did, for a quiet "Reloaded" or "Deleted" hint. */
  readonly lastChange: "loaded" | "reloaded" | "deleted" | null;
}

export class ViewerTab implements Disposable {
  readonly root: string;
  readonly path: string;
  readonly state = new Store<ViewerTabState>({
    status: "idle",
    document: null,
    revision: 0,
    lastChange: null,
  });
  readonly viewer: Store<ViewerState>;
  readonly #options: ViewerTabOptions;
  #viewportHeight: number | undefined;
  #generation = 0;
  #controller: AbortController | null = null;
  #disposed = false;

  constructor(options: ViewerTabOptions) {
    this.root = options.root;
    this.path = options.path;
    this.#options = options;
    this.viewer = new Store<ViewerState>(options.viewer ?? createViewerState({ wrap: options.wrap }));
  }

  get document(): ViewerDocument | null {
    return this.state.get().document;
  }

  /** Visible lines, so reloads and moves clamp the scroll position precisely. */
  setViewportHeight(height: number): void {
    this.#viewportHeight = Math.max(1, Math.floor(height));
    this.#clampViewer();
  }

  /** (Re)loads the file. A newer call supersedes an older one still in flight. */
  async load(): Promise<ViewerDocument> {
    return this.#load(false);
  }

  /**
   * Compares the file on disk with what the tab shows and reloads when it changed. Pass the
   * watcher's observation when it has one; otherwise the file is stat'ed.
   */
  async checkForChanges(observation?: FileObservation): Promise<ReloadDecision> {
    if (this.#disposed) return "unchanged";
    const current = this.document;
    const next = observation === undefined ? await observeFile(this.root, this.path) : observation;
    if (this.#disposed) return "unchanged";
    const stamp = isLoadedDocument(current) ? current.stamp : null;
    // A tab still showing "deleted" or "not found" picks the file up again once it reappears.
    const decision = current === null ? "reload" : decideReload(stamp, next);
    if (decision === "deleted") {
      this.#cancel();
      this.#publish(unavailableDocument(this.path, "deleted"), "deleted");
    } else if (decision === "reload") {
      await this.#load(true);
    }
    return decision;
  }

  move(move: ViewerMove, viewportHeight = this.#viewportHeight ?? 1): void {
    const document = this.document;
    const lineCount = document?.kind === "text" ? document.lineCount : 1;
    this.viewer.set((state) => moveActiveLine(state, move, { lineCount, viewportHeight }));
  }

  toggleWrap(): void {
    this.viewer.set((state) => ({ ...state, wrap: !state.wrap }));
  }

  toggleMarkdownPreview(): void {
    this.viewer.set((state) => toggleMarkdownPreview(state, this.document));
  }

  exportState(): ViewerStateSnapshot {
    return exportViewerState(this.viewer.get());
  }

  dispose(): void {
    this.#disposed = true;
    this.#cancel();
  }

  #cancel(): void {
    this.#generation++;
    this.#controller?.abort();
    this.#controller = null;
  }

  async #load(isReload: boolean): Promise<ViewerDocument> {
    this.#cancel();
    const generation = this.#generation;
    const controller = new AbortController();
    this.#controller = controller;
    const previous = this.document;
    // A reload keeps showing the current content until the new one is ready: no flicker.
    if (previous === null) this.state.update({ status: "loading" });
    let document: ViewerDocument;
    try {
      document = await loadDocument(this.root, this.path, {
        syntax: this.#options.syntax,
        maxFileSizeMb: this.#options.maxFileSizeMb,
        limits: this.#options.limits,
        wasLoaded: isLoadedDocument(previous) || previous?.reason === "deleted",
        signal: controller.signal,
      });
    } catch (error) {
      if (isLucyError(error, "CANCELLED") || generation !== this.#generation) {
        return this.document ?? unavailableDocument(this.path, "io-error", "Loading was cancelled");
      }
      document = unavailableDocument(this.path, "io-error", errorMessage(error));
    }
    if (generation !== this.#generation || this.#disposed) return this.document ?? document;
    this.#controller = null;
    const change =
      document.kind === "unavailable" && document.reason === "deleted"
        ? "deleted"
        : isReload
          ? "reloaded"
          : "loaded";
    this.#publish(document, change);
    return document;
  }

  #publish(document: ViewerDocument, change: ViewerTabState["lastChange"]): void {
    this.state.set((prev) => ({
      status: "ready",
      document,
      revision: prev.revision + 1,
      lastChange: change,
    }));
    this.#clampViewer();
  }

  #clampViewer(): void {
    const document = this.document;
    // Keep the position while the file is missing or unreadable: it comes back when the file does.
    if (document?.kind !== "text") return;
    this.viewer.set((state) => clampViewerState(state, document.lineCount, this.#viewportHeight));
  }
}
