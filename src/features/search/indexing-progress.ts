/**
 * "Indexing files" in the status bar while the file index is being built (the first Quick
 * Open on a large workspace, Rebuild File Index). It appears only after a short delay, like
 * every spinner, so a fast listing never flashes it.
 */
import type { AppContext } from "@/app/app-context";
import type { StatusItemHandle } from "@/app/workbench/status-bar";
import type { Disposable } from "@/core/events";
import type { IndexingProgress } from "./search-commands";

export const INDEXING_DELAY_MS = 300;

export function createIndexingProgress(
  ctx: AppContext,
  delayMs = INDEXING_DELAY_MS,
): IndexingProgress & Disposable {
  let pending = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let item: StatusItemHandle | null = null;

  const hide = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    item?.dispose();
    item = null;
  };

  return {
    run<T>(work: Promise<T>): Promise<T> {
      pending++;
      if (pending === 1 && !item) {
        timer = setTimeout(() => {
          timer = null;
          if (pending === 0 || item) return;
          item = ctx.statusBar.register({
            id: "search.indexing",
            alignment: "left",
            priority: 5,
            text: "Indexing files…",
            icon: "sync",
            tone: "muted",
            tooltip: "Listing the workspace files for Go to File and search",
          });
        }, delayMs);
      }
      const done = () => {
        pending--;
        if (pending === 0) hide();
      };
      work.then(done, done);
      return work;
    },
    dispose: hide,
  };
}
