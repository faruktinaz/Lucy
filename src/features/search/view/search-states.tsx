/**
 * What the Search view shows around and instead of the results:
 *
 * - the status lines: the summary ("12 results in 4 files", a delayed spinner while
 *   searching, "Stopped"), the engine in use on the right, the ripgrep hint (until the second
 *   search of the session) and the truncated notice;
 * - idle: one sentence and the keys that matter, with their real bindings;
 * - no results: what was searched with which filters, and a way to turn the filters off;
 * - failure: what happened, Retry and the log location.
 */
import { useApp } from "@/app/react";
import { displayWidth } from "@/core/text";
import type { SearchViewState } from "@/features/search/model";
import { Icon } from "@/ui/primitives/icon";
import { formatKeys, KeyHint } from "@/ui/primitives/key-hint";
import { useMeasure } from "@/ui/primitives/measure";
import { Spinner, useDelayedFlag } from "@/ui/primitives/spinner";
import { EmptyState, ErrorState } from "@/ui/primitives/states";
import { usePointer } from "@/ui/primitives/use-pointer";
import { useDensity, useTheme } from "@/ui/theme/theme-context";
import type { SearchController } from "../search-controller";

export interface SummaryProps {
  state: SearchViewState;
  stopped: boolean;
  showHint: boolean;
}

/**
 * Breaks a sentence at spaces only (the renderer's word wrap also breaks after "(", which
 * split "(rg)" across lines). Without a measured width it stays one line.
 */
function wrapWords(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line === "" ? word : `${line} ${word}`;
    if (line !== "" && displayWidth(next) > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** The summary row plus the optional hint and truncated notice rows. */
export function SearchSummary({ state, stopped, showHint }: SummaryProps) {
  const theme = useTheme();
  const density = useDensity();
  const c = theme.colors;
  const { size, onSizeChange } = useMeasure();
  const searching = state.status === "searching";
  const slow = useDelayedFlag(searching);
  const engine = state.engineLabel;
  const hint = showHint ? state.engineHint : null;
  const pointer = usePointer({
    hint: engine
      ? {
          text: state.engineHint
            ? `Searching with ${engine}. ${state.engineHint}`
            : `Searching with ${engine}`,
        }
      : null,
  });
  let text: string;
  if (searching) text = state.matchCount > 0 ? state.summary : slow ? "Searching" : "";
  else if (state.status === "cancelled" && stopped) {
    text = state.matchCount > 0 ? `Stopped · ${state.summary}` : "Search stopped";
  } else text = state.summary;
  const spinnerWidth = searching && slow ? 2 : 0;
  const room = size.width - density.rowPaddingX * 2;
  // The engine sits quietly on the right when it fits and the hint line does not name it.
  const showEngine =
    engine !== "" && hint === null && spinnerWidth + displayWidth(text) + 2 + displayWidth(engine) <= room;
  return (
    <box flexDirection="column" flexShrink={0} paddingX={density.rowPaddingX} onSizeChange={onSizeChange}>
      <box height={1} flexDirection="row" {...pointer.props}>
        <text flexGrow={1} flexShrink={1} fg={c.fg.muted} selectable={false} wrapMode="none">
          {searching ? <Spinner active tone="subtle" /> : null}
          {spinnerWidth > 0 ? " " : ""}
          {text}
        </text>
        {showEngine ? (
          <text flexShrink={0} fg={c.fg.subtle} selectable={false}>
            {`  ${engine}`}
          </text>
        ) : null}
      </box>
      {hint
        ? wrapWords(engine ? `${engine} · ${hint}` : hint, room).map((line) => (
            <text key={line} fg={c.fg.subtle} selectable={false} wrapMode="none">
              {line}
            </text>
          ))
        : null}
      {state.truncatedNotice ? (
        <text fg={c.fg.muted} selectable={false} wrapMode="word">
          <Icon name="warning" color={c.status.warning} />
          {state.truncatedNotice}
        </text>
      ) : null}
    </box>
  );
}

function KeyRow({ label, keys, command }: { label: string; keys?: string; command?: string }) {
  const theme = useTheme();
  return (
    <box height={1} flexDirection="row" flexShrink={0}>
      <text flexGrow={1} flexShrink={1} fg={theme.colors.fg.muted} selectable={false} wrapMode="none">
        {label}
      </text>
      <text flexShrink={0} selectable={false}>
        <KeyHint keys={keys} command={command} />
      </text>
    </box>
  );
}

export interface IdleStateProps {
  state: SearchViewState;
  showHint: boolean;
}

/** Before the first search: what the view does and the keys that matter. */
export function SearchIdleState({ state, showHint }: IdleStateProps) {
  const theme = useTheme();
  const density = useDensity();
  const c = theme.colors;
  const pattern = state.query.pattern;
  return (
    <box flexDirection="column" flexShrink={0} paddingX={density.rowPaddingX}>
      <text fg={c.fg.muted} selectable={false} wrapMode="word">
        {pattern === ""
          ? "Find text in every file of this workspace. Results appear as you type."
          : `Press ${formatKeys("enter")} to search for the restored query.`}
      </text>
      <box flexDirection="column" marginTop={density.sectionGap} flexShrink={0}>
        <KeyRow label="Search now" keys="enter" />
        {state.recentQueries.length > 0 ? <KeyRow label="Recent searches" keys="up" /> : null}
        <KeyRow label="Next result" command="search.nextResult" />
        <KeyRow label="Previous result" command="search.previousResult" />
        <KeyRow label="Files to include" command="search.toggleDetails" />
      </box>
      {state.engineLabel ? (
        <text fg={c.fg.subtle} selectable={false} wrapMode="word" marginTop={density.sectionGap}>
          {`Searching with ${state.engineLabel}.`}
          {showHint && state.engineHint ? ` ${state.engineHint}` : ""}
        </text>
      ) : null}
    </box>
  );
}

const FILTER_NAMES = {
  caseMode: "match case",
  wholeWord: "whole word",
  include: "files to include",
  exclude: "files to exclude",
} as const;

function activeFilters(state: SearchViewState): string[] {
  const query = state.query;
  const out: string[] = [];
  if (query.caseMode === "sensitive") out.push(FILTER_NAMES.caseMode);
  if (query.wholeWord) out.push(FILTER_NAMES.wholeWord);
  if (query.include !== "") out.push(FILTER_NAMES.include);
  if (query.exclude !== "") out.push(FILTER_NAMES.exclude);
  return out;
}

function sentenceList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function SearchNoResults({
  state,
  controller,
}: {
  state: SearchViewState;
  controller: SearchController;
}) {
  const filters = activeFilters(state);
  const what = state.query.isRegex ? "the regular expression" : "the text";
  const description =
    filters.length > 0
      ? `No file matches ${what}. Filters are on: ${sentenceList(filters)}.`
      : `No file in this workspace matches ${what}.`;
  return (
    <EmptyState
      title="No results"
      description={description}
      actions={
        filters.length > 0 ? [{ label: "Turn off filters", onPress: () => controller.resetFilters() }] : []
      }
    />
  );
}

export function SearchFailed({ message, controller }: { message: string; controller: SearchController }) {
  const app = useApp();
  return (
    <ErrorState
      title="Search failed"
      message={message}
      actions={[
        { label: "Retry", onPress: () => controller.runNow() },
        { label: "Show log location", onPress: () => void app.run("developer.showLogPath") },
      ]}
    />
  );
}
