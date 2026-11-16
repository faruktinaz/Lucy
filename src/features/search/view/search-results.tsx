/**
 * The results: one virtualized list of file rows and match rows.
 *
 *   ▾ TS task-store.ts src/server/store       3     chevron, file icon, name, dimmed folder, count
 *      11 export class TaskStore {                  line number, preview with highlighted matches
 *     124 …const store = new TaskStore(clock);      the window slides so the first match shows
 *
 * Line numbers share one right-aligned column across the whole list. A click opens a match
 * as a preview tab (or toggles a file), a double-click keeps the tab; selection, hover and
 * scrolling come from the design system's `List`.
 */
import { type ReactNode, useMemo } from "react";
import type { SearchFileRow, SearchMatchRow, SearchRow } from "@/features/search/model";
import { sanitizeWithRanges } from "@/features/search/model";
import { formatCount } from "@/ui/primitives/badge";
import { FileIcon } from "@/ui/primitives/icon";
import { List, type ListRowState } from "@/ui/primitives/list";
import { attrs } from "@/ui/primitives/text";
import { TreeRowContent } from "@/ui/primitives/tree";
import { usePointer } from "@/ui/primitives/use-pointer";
import { useTheme } from "@/ui/theme/theme-context";
import { layoutPreview, PREVIEW_ELLIPSIS } from "../preview-layout";
import type { SearchController } from "../search-controller";

/** Match rows are indented under the file icon column. */
const MATCH_INDENT = 2;

export interface ResultRows {
  readonly rows: readonly SearchRow[];
  /** Digits of the largest line number, so line numbers line up in one column. */
  readonly gutter: number;
}

export function useResultRows(
  controller: SearchController,
  rowsVersion: number,
  rowCount: number,
): ResultRows {
  // biome-ignore lint/correctness/useExhaustiveDependencies: rowsVersion is the model's change counter.
  return useMemo(() => {
    const rows = controller.model.getRows(0, rowCount);
    let maxLine = 0;
    for (const row of rows) if (row.type === "match" && row.line > maxLine) maxLine = row.line;
    return { rows, gutter: Math.max(2, String(maxLine).length) };
  }, [controller, rowsVersion, rowCount]);
}

/** Claims clicks on a row's content so the list does not also handle them. */
function RowPointer({
  index,
  controller,
  children,
}: {
  index: number;
  controller: SearchController;
  children: ReactNode;
}) {
  const pointer = usePointer({
    onClick: () => controller.clickRow(index),
    onDoubleClick: () => controller.doubleClickRow(index),
  });
  return (
    <box flexGrow={1} flexShrink={1} minWidth={0} flexDirection="row" {...pointer.props}>
      {children}
    </box>
  );
}

function FileRowContent({ row, state }: { row: SearchFileRow; state: ListRowState }) {
  const theme = useTheme();
  return (
    <TreeRowContent
      depth={0}
      expandable
      expanded={!row.collapsed}
      icon={<FileIcon name={row.name} />}
      label={row.name}
      description={row.directory}
      status={formatCount(row.matchCount, 4)}
      statusColor={state.active ? theme.colors.state.selectedFg : theme.colors.fg.muted}
      state={state}
    />
  );
}

function MatchRowContent({
  row,
  state,
  gutter,
}: {
  row: SearchMatchRow;
  state: ListRowState;
  gutter: number;
}) {
  const theme = useTheme();
  const c = theme.colors;
  const lineNumber = String(row.line).padStart(gutter, " ");
  const room = Math.max(0, state.width - MATCH_INDENT - gutter - 1);
  // The engine already made the excerpt display-safe; sanitizing again keeps that guarantee
  // local to the view (it never changes lengths here, so the ranges stay valid).
  const safe = sanitizeWithRanges(row.preview, row.ranges);
  const layout = layoutPreview(safe.text, safe.ranges, room, row.clippedStart, row.clippedEnd);
  const textColor = state.active ? c.state.selectedFg : c.fg.default;
  return (
    <text flexGrow={1} flexShrink={1} selectable={false} wrapMode="none">
      <span fg={state.active ? c.fg.muted : c.fg.subtle}>{`${" ".repeat(MATCH_INDENT)}${lineNumber} `}</span>
      {layout.leading ? <span fg={c.fg.subtle}>{PREVIEW_ELLIPSIS}</span> : null}
      {layout.runs.map((run, i) =>
        run.match ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional and never reordered.
          <span key={i} fg={textColor} bg={c.editor.findMatchBg} attributes={attrs({ bold: true })}>
            {run.text}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional and never reordered.
          <span key={i} fg={textColor}>
            {run.text}
          </span>
        ),
      )}
      {layout.trailing ? <span fg={c.fg.subtle}>{PREVIEW_ELLIPSIS}</span> : null}
    </text>
  );
}

export interface SearchResultsProps {
  controller: SearchController;
  rows: ResultRows;
  selectedIndex: number;
  focused: boolean;
}

export function SearchResults({ controller, rows, selectedIndex, focused }: SearchResultsProps) {
  return (
    <List
      items={rows.rows}
      selectedIndex={selectedIndex}
      focused={focused}
      keyboard={false}
      onSelect={(index) => controller.selectRow(index)}
      onActivate={(index) => controller.doubleClickRow(index)}
      renderRow={(row, state) => (
        <RowPointer index={state.index} controller={controller}>
          {row.type === "file" ? (
            <FileRowContent row={row} state={state} />
          ) : (
            <MatchRowContent row={row} state={state} gutter={rows.gutter} />
          )}
        </RowPointer>
      )}
    />
  );
}
