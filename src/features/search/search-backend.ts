/**
 * The search backend the view model talks to, with the `[search]` settings applied:
 *
 * - `search.engine`: "auto" uses the shared `ContentSearch` from the domain services; a
 *   forced engine gets its own `ContentSearch` over the same file index (a forced engine that
 *   cannot run here fails visibly, for example ripgrep when `rg` is not installed).
 * - `search.maxResults`: the result limit of every run.
 * - `search.smartCase`: with it off, "match case" off means case-insensitive instead of smart.
 *
 * Nothing is created until the first search or engine check, so activating the feature
 * starts no process.
 */
import { ContentSearch, type SearchEngineName } from "@/adapters/search";
import type { AppContext } from "@/app/app-context";
import type { SearchBackend } from "./model";

export type EngineSetting = SearchEngineName | "auto";

/** Returns the backend for an engine setting (the default builds real `ContentSearch` objects). */
export type BackendFactory = (engine: EngineSetting) => SearchBackend;

export function contentSearchFactory(ctx: AppContext): BackendFactory {
  const forced = new Map<SearchEngineName, ContentSearch>();
  return (engine) => {
    if (engine === "auto") return ctx.services.contentSearch;
    let search = forced.get(engine);
    if (!search) {
      search = new ContentSearch({ root: ctx.workspace.root, fileIndex: ctx.services.fileIndex, engine });
      forced.set(engine, search);
    }
    return search;
  };
}

export function settingsAwareBackend(ctx: AppContext, factory: BackendFactory): SearchBackend {
  const current = (): SearchBackend => factory(ctx.config.get("search.engine"));
  return {
    resolveEngine: () => current().resolveEngine(),
    ripgrepPath: () => current().ripgrepPath(),
    search: (query, callbacks, signal) => {
      const smartCase = ctx.config.get("search.smartCase");
      return current().search(
        {
          ...query,
          caseMode: query.caseMode === "smart" && !smartCase ? "insensitive" : query.caseMode,
          maxResults: ctx.config.get("search.maxResults"),
        },
        callbacks,
        signal,
      );
    },
  };
}
