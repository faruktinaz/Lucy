/**
 * The Search sidebar view (VS Code's search panel, in cells):
 *
 *   ▸ ⌕ TaskStore           Aa ab .*
 *
 *   12 results in 4 files          git grep
 *   ▾ TS task-store.ts src/server/store   3
 *       11 export class TaskStore {
 *
 * Rendering only: state lives in the `SearchController` (focus inside the view, details,
 * recall) and the `SearchViewModel` (query, runs, rows, selection).
 */
import { type ReactNode, useEffect, useRef } from "react";
import { useFocusTarget, useKeyHandler, useStore } from "@/app/react";
import type { ViewComponent, ViewProps } from "@/app/workbench/views";
import { useMeasure } from "@/ui/primitives/measure";
import { useDensity } from "@/ui/theme/theme-context";
import type { SearchController } from "../search-controller";
import { GlobRow, InvalidPatternLine, PatternRow } from "./search-inputs";
import { SearchResults, useResultRows } from "./search-results";
import { SearchFailed, SearchIdleState, SearchNoResults, SearchSummary } from "./search-states";

export interface SearchViewProps extends ViewProps {
  readonly controller: SearchController;
}

export function SearchView({ visible, focused, controller }: SearchViewProps) {
  const density = useDensity();
  const state = useStore(controller.model.store);
  const ui = useStore(controller.ui);
  const { size: listSize, onSizeChange } = useMeasure();
  const target = useRef(controller.focusTarget);
  useFocusTarget(target, visible);
  useKeyHandler((stroke) => controller.handleKey(stroke, listSize.height), {
    enabled: visible,
    whileInputFocused: true,
  });
  useEffect(() => {
    if (visible) controller.onVisible();
  }, [visible, controller]);

  const rows = useResultRows(controller, state.rowsVersion, state.rowCount);
  const error = state.error;
  const showHint = ui.runs <= 1;
  const hasRows = state.rowCount > 0;
  const noResults = state.status === "done" && state.matchCount === 0;
  const showSummary =
    error === null &&
    !noResults &&
    (state.status === "searching" || state.status === "done" || hasRows || ui.stopped);

  let body: ReactNode = null;
  if (error?.kind === "failed") body = <SearchFailed message={error.message} controller={controller} />;
  else if (hasRows) {
    body = (
      <box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="column" onSizeChange={onSizeChange}>
        <SearchResults
          controller={controller}
          rows={rows}
          selectedIndex={state.selectedIndex}
          focused={focused && ui.focus === "results"}
        />
      </box>
    );
  } else if (noResults) body = <SearchNoResults state={state} controller={controller} />;
  else if (state.status === "idle" && error === null)
    body = <SearchIdleState state={state} showHint={showHint} />;

  return (
    <box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="column">
      <box flexDirection="column" flexShrink={0} paddingX={density.rowPaddingX}>
        <PatternRow
          controller={controller}
          query={state.query}
          focused={focused && ui.focus === "pattern"}
          detailsOpen={ui.detailsOpen}
          invalid={error?.kind === "invalid-pattern"}
        />
        {ui.detailsOpen ? (
          <>
            <GlobRow
              controller={controller}
              target="include"
              value={state.query.include}
              focused={focused && ui.focus === "include"}
            />
            <GlobRow
              controller={controller}
              target="exclude"
              value={state.query.exclude}
              focused={focused && ui.focus === "exclude"}
            />
          </>
        ) : null}
        {error?.kind === "invalid-pattern" ? <InvalidPatternLine message={error.message} /> : null}
      </box>
      <box height={density.sectionGap} flexShrink={0} />
      {showSummary ? <SearchSummary state={state} stopped={ui.stopped} showHint={showHint} /> : null}
      {body}
    </box>
  );
}

/** The registered component: the view bound to the feature's controller. */
export function createSearchView(controller: SearchController): ViewComponent<ViewProps> {
  return (props) => <SearchView {...props} controller={controller} />;
}
