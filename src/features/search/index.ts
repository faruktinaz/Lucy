/**
 * Search feature: the Search sidebar view (project-wide content search with streamed,
 * grouped results), Quick Open (the quick pick's no-prefix files provider), their commands
 * and keybindings.
 *
 * Activation creates no service and starts no process: the content search, the file index
 * and engine detection are created on first use (or after the first frame, when the view is
 * visible).
 */

import type { AppContext } from "@/app/app-context";
import type { FeatureModule } from "@/app/feature";
import { derived } from "@/app/workbench/readable";
import { DisposableStore } from "@/core/events";
import { createIndexingProgress } from "./indexing-progress";
import type { QuickOpenIndex, SearchBackend } from "./model";
import { registerQuickOpen } from "./quick-open-provider";
import { contentSearchFactory, settingsAwareBackend } from "./search-backend";
import { registerSearchCommands, SEARCH_KEYBINDINGS } from "./search-commands";
import { SearchController } from "./search-controller";
import { createSearchView } from "./view/search-view";

export { SEARCH_FOCUS_WHEN, SEARCH_KEYBINDINGS } from "./search-commands";
export type { SearchController, SearchFocusTarget } from "./search-controller";

export interface SearchFeatureOptions {
  /** Replaces the content search (tests drive a fake engine). Settings still apply on top. */
  readonly backend?: (ctx: AppContext) => SearchBackend;
  /** Replaces the file index behind Quick Open. */
  readonly fileIndex?: (ctx: AppContext) => QuickOpenIndex;
  /** Delay after a query edit before searching. Default 300 ms. */
  readonly debounceMs?: number;
  /** Coalescing window for streamed results. Default 50 ms. */
  readonly flushIntervalMs?: number;
  /** Receives the controller (tests inspect the view's state through it). */
  readonly onController?: (controller: SearchController) => void;
}

export function createSearchFeature(options: SearchFeatureOptions = {}): FeatureModule {
  return {
    id: "search",
    keybindings: SEARCH_KEYBINDINGS,
    activate(ctx) {
      const store = new DisposableStore();
      const custom = options.backend;
      let fake: SearchBackend | null = null;
      const factory = custom ? () => (fake ??= custom(ctx)) : contentSearchFactory(ctx);
      const controller = store.add(
        new SearchController(ctx, {
          backend: settingsAwareBackend(ctx, factory),
          debounceMs: options.debounceMs,
          flushIntervalMs: options.flushIntervalMs,
        }),
      );
      options.onController?.(controller);
      const indexing = store.add(createIndexingProgress(ctx));
      store.add(registerSearchCommands(ctx, controller, indexing));
      const fileIndex = options.fileIndex;
      store.add(
        registerQuickOpen(ctx, indexing, { fileIndex: fileIndex ? () => fileIndex(ctx) : undefined }),
      );

      const badge = derived([controller.model.store] as const, (state) =>
        state.status !== "idle" && state.matchCount > 0 ? state.matchCount : undefined,
      );
      store.add(
        ctx.views.registerSidebarView({
          id: "search",
          title: "Search",
          icon: "search",
          order: 20,
          command: "view.showSearch",
          badge,
          actions: [
            { command: "search.refresh", icon: "refresh" },
            { command: "search.collapseAll", icon: "collapseAll" },
            { command: "search.clearResults", icon: "close" },
          ],
          component: createSearchView(controller),
        }),
      );
      return store;
    },
  };
}

export const searchFeature: FeatureModule = createSearchFeature();
