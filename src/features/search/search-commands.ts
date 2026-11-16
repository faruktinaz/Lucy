/**
 * The Search commands and their default keybindings.
 *
 * "Find in files" is the workbench's `view.showSearch` (Ctrl+K F, Ctrl+Shift+F, Ctrl+\ F):
 * the feature does not register a second command for it, it only makes that command put the
 * cursor in the pattern field.
 *
 * F4 / Shift+F4 step through matches from anywhere except a terminal (they are not global
 * bindings, so a focused shell keeps its function keys). The toggles use VS Code's Alt+C /
 * Alt+W / Alt+R, which need Option-as-Meta on macOS, plus legacy-safe Ctrl+K sequences; they
 * only apply while the Search view has focus.
 */
import type { AppContext } from "@/app/app-context";
import { errorMessage } from "@/core/errors";
import { type Disposable, DisposableStore } from "@/core/events";
import type { KeybindingDefinition } from "@/core/keybindings";
import { formatCount } from "./model";
import type { SearchController } from "./search-controller";

/** The Search view has keyboard focus. */
export const SEARCH_FOCUS_WHEN = "sidebarFocus && sidebarView == 'search'";

export const SEARCH_KEYBINDINGS: readonly KeybindingDefinition[] = [
  { command: "search.nextResult", keys: ["f4"] },
  { command: "search.previousResult", keys: ["shift+f4"] },
  { command: "search.toggleMatchCase", keys: ["alt+c", "ctrl+k c"], when: SEARCH_FOCUS_WHEN },
  { command: "search.toggleWholeWord", keys: ["alt+w", "ctrl+k w"], when: SEARCH_FOCUS_WHEN },
  { command: "search.toggleRegex", keys: ["alt+r", "ctrl+k r"], when: SEARCH_FOCUS_WHEN },
  { command: "search.toggleDetails", keys: ["ctrl+k d"], when: SEARCH_FOCUS_WHEN },
];

export interface IndexingProgress {
  /** Shows "Indexing files" in the status bar while `work` runs (after a short delay). */
  run<T>(work: Promise<T>): Promise<T>;
}

export function registerSearchCommands(
  ctx: AppContext,
  controller: SearchController,
  indexing: IndexingProgress,
): Disposable {
  const store = new DisposableStore();
  const register = (definition: Parameters<AppContext["commands"]["register"]>[0]) =>
    store.add(ctx.commands.register(definition));
  const model = controller.model;
  const flash = (text: string) => ctx.hints.flash({ text, tone: "muted" });
  const hasResults = () => model.store.get().rowCount > 0;

  const step = (direction: 1 | -1) => {
    if (controller.step(direction)) return;
    const state = model.store.get();
    if (state.status === "searching") flash("Still searching");
    else if (state.query.pattern === "") {
      ctx.hints.flash({
        text: "No search results yet. Find in files",
        keys: ctx.keybindingFor("view.showSearch"),
        tone: "muted",
      });
    } else flash("No search results");
  };
  register({
    id: "search.nextResult",
    title: "Go to Next Search Result",
    category: "Search",
    keywords: ["find", "match", "next"],
    run: () => step(1),
  });
  register({
    id: "search.previousResult",
    title: "Go to Previous Search Result",
    category: "Search",
    keywords: ["find", "match", "previous"],
    run: () => step(-1),
  });

  // Toggling from the palette while the view is hidden still needs visible feedback.
  const toggled = (label: string, on: boolean) => {
    if (!controller.isVisible()) flash(`${label} ${on ? "on" : "off"}`);
  };
  register({
    id: "search.toggleMatchCase",
    title: "Toggle Match Case",
    category: "Search",
    keywords: ["case sensitive"],
    run: () => {
      controller.toggleMatchCase();
      toggled("Match case", model.store.get().query.caseMode === "sensitive");
    },
  });
  register({
    id: "search.toggleWholeWord",
    title: "Toggle Match Whole Word",
    category: "Search",
    keywords: ["word"],
    run: () => {
      controller.toggleWholeWord();
      toggled("Match whole word", model.store.get().query.wholeWord);
    },
  });
  register({
    id: "search.toggleRegex",
    title: "Toggle Regular Expression",
    category: "Search",
    keywords: ["regex", "pattern"],
    run: () => {
      controller.toggleRegex();
      toggled("Regular expression", model.store.get().query.isRegex);
    },
  });
  register({
    id: "search.toggleDetails",
    title: "Toggle Search Details",
    category: "Search",
    description: "Show or hide the files to include and exclude",
    keywords: ["include", "exclude", "glob", "filter"],
    run: () => {
      if (!controller.isVisible()) ctx.layout.showSidebarView("search");
      controller.toggleDetails();
    },
  });

  register({
    id: "search.refresh",
    title: "Refresh Search Results",
    category: "Search",
    keywords: ["rerun", "again"],
    run: () => {
      if (!controller.runNow()) flash("Type a search pattern first");
    },
  });
  register({
    id: "search.cancel",
    title: "Stop Search",
    category: "Search",
    enabled: () => model.store.get().status === "searching",
    run: () => {
      controller.stop();
    },
  });
  register({
    id: "search.clearResults",
    title: "Clear Search Results",
    category: "Search",
    keywords: ["reset"],
    run: () => {
      if (model.store.get().query.pattern === "" && !hasResults()) flash("Nothing to clear");
      controller.clear();
    },
  });
  register({
    id: "search.collapseAll",
    title: "Collapse All Search Results",
    category: "Search",
    run: () => {
      if (!hasResults()) flash("No search results to collapse");
      model.collapseAll();
    },
  });
  register({
    id: "search.expandAll",
    title: "Expand All Search Results",
    category: "Search",
    run: () => {
      if (!hasResults()) flash("No search results to expand");
      model.expandAll();
    },
  });

  register({
    id: "search.rebuildFileIndex",
    title: "Rebuild File Index",
    category: "Search",
    description: "List the workspace files again for Go to File and search",
    keywords: ["reindex", "files", "quick open", "refresh"],
    run: async () => {
      const index = ctx.services.fileIndex;
      index.invalidate();
      // A `git init` or a newly installed ripgrep changes which engine can run.
      ctx.services.contentSearch.resetEngine();
      try {
        const result = await indexing.run(index.list());
        if (result.truncated) {
          ctx.notifications.warn(
            "The file index is incomplete",
            `Only the first ${formatCount(result.files.length)} files are searchable.`,
          );
        } else {
          flash(`Indexed ${formatCount(result.files.length)} files`);
        }
      } catch (error) {
        ctx.notifications.error("Could not index the workspace files", errorMessage(error));
      }
      model.detectEngine().catch((error: unknown) => {
        ctx.log.warn("Detecting the search engine failed", { error });
      });
    },
  });

  // `view.showSearch` is "find in files": land in the pattern field, wherever focus was.
  store.add(
    ctx.commands.onDidExecute(({ id, ok }) => {
      if (ok && id === "view.showSearch") controller.focusPattern();
    }),
  );
  return store;
}
