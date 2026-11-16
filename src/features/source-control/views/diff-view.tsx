/**
 * The diff editor: our own virtualized rows over a `DiffDocument`, in unified or split layout.
 *
 * Reading order of a row: a 1-cell cursor margin, line numbers (old and new in unified, one per
 * pane in split), the sign, then the content with syntax colors. Added and removed lines get
 * the quiet `diff.*LineBg` tints over the whole row; changed words inside a paired line get the
 * stronger `diff.*WordBg`. Hunk headers sit on `diff.hunkHeaderBg` so boundaries are obvious.
 *
 * Only the visible rows are mounted (keyed by slot). The document reloads whenever Git status
 * refreshes (file watcher, after staging or committing); the cursor and scroll position stay
 * where they were when still valid.
 */
import type { MouseEvent, RGBA } from "@opentui/core";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useApp, useKeyHandler, useStore } from "@/app/react";
import type { EditorViewProps } from "@/app/workbench/views";
import { isLucyError, type LucyError } from "@/core/errors";
import { normalizeKey } from "@/core/keybindings";
import { displayWidth, plural, sanitizeForDisplay, truncateEnd } from "@/core/text";
import { Icon } from "@/ui/primitives/icon";
import { useMeasure } from "@/ui/primitives/measure";
import { Spinner } from "@/ui/primitives/spinner";
import { EmptyState, ErrorState } from "@/ui/primitives/states";
import { usePointer } from "@/ui/primitives/use-pointer";
import { useTheme } from "@/ui/theme/theme-context";
import type { UiTheme } from "@/ui/theme/ui-theme";
import type { DiffAction, ScmController } from "../controller";
import { diffSideLabel, diffTargetOf, isDiffTab } from "../diff-input";
import {
  type DiffDocument,
  type DiffViewKind,
  loadDiffDocument,
  type SplitCell,
  type SplitRow,
  type UnifiedRow,
} from "../model";
import { displayLength, lineSegments, type Segment } from "./diff-segments";

/** Below this editor width "auto" shows the unified layout: each split pane needs ~50 columns. */
export const SPLIT_MIN_WIDTH = 110;
const HORIZONTAL_STEP = 8;
const WHEEL_STEP = 3;

export type DiffLayoutSetting = "auto" | "split" | "unified";

export function resolveDiffLayout(setting: DiffLayoutSetting, width: number): DiffViewKind {
  if (setting === "auto") return width >= SPLIT_MIN_WIDTH ? "split" : "unified";
  return setting;
}

interface LoadState {
  readonly doc: DiffDocument | null;
  readonly error: LucyError | null;
  readonly loading: boolean;
}

function digits(value: number): number {
  return Math.max(2, String(Math.max(0, value)).length);
}

function pad(value: number | null, width: number): string {
  return value === null ? " ".repeat(width) : String(value).padStart(width, " ");
}

/** The 1-based new-file line a row stands for, for "open file at this line". */
function newLineAt(doc: DiffDocument, layout: DiffViewKind, rowIndex: number): number {
  const rows = layout === "unified" ? doc.unified : doc.split;
  const row = rows[rowIndex];
  if (!row) return 1;
  const hunk = doc.diff.hunks[row.hunkIndex];
  if (!hunk) return 1;
  const lines = hunk.lines;
  let lineIndex = -1;
  if (row.kind === "line") lineIndex = row.lineIndex;
  else if (row.kind === "pair") lineIndex = row.right?.lineIndex ?? row.left?.lineIndex ?? -1;
  if (lineIndex < 0) return Math.max(1, hunk.newStart);
  for (let i = lineIndex; i < lines.length; i++) {
    const line = lines[i]?.newLine;
    if (line) return line;
  }
  for (let i = lineIndex; i >= 0; i--) {
    const line = lines[i]?.newLine;
    if (line) return line + 1;
  }
  return Math.max(1, hunk.newStart);
}

/** Maps a row to the equivalent row of the other layout (keeps the place when toggling). */
function mapRow(doc: DiffDocument, from: DiffViewKind, rowIndex: number): number {
  const source = from === "unified" ? doc.unified[rowIndex] : doc.split[rowIndex];
  if (!source) return 0;
  const lineIndex =
    source.kind === "line"
      ? source.lineIndex
      : source.kind === "pair"
        ? (source.left?.lineIndex ?? source.right?.lineIndex)
        : undefined;
  const target: readonly (UnifiedRow | SplitRow)[] = from === "unified" ? doc.split : doc.unified;
  const found = target.findIndex((row) => {
    if (row.hunkIndex !== source.hunkIndex) return false;
    if (lineIndex === undefined) return row.kind === "hunk";
    if (row.kind === "line") return row.lineIndex === lineIndex;
    if (row.kind === "pair") return row.left?.lineIndex === lineIndex || row.right?.lineIndex === lineIndex;
    return false;
  });
  return Math.max(0, found);
}

interface RowColors {
  readonly bg: RGBA | undefined;
  readonly wordBg: RGBA | undefined;
  readonly fg: RGBA;
  readonly sign: RGBA;
}

function colorsFor(theme: UiTheme, kind: "added" | "removed" | "context"): RowColors {
  const d = theme.colors.diff;
  if (kind === "added") return { bg: d.addedLineBg, wordBg: d.addedWordBg, fg: d.addedFg, sign: d.addedFg };
  if (kind === "removed")
    return { bg: d.removedLineBg, wordBg: d.removedWordBg, fg: d.removedFg, sign: d.removedFg };
  return { bg: undefined, wordBg: undefined, fg: theme.colors.fg.default, sign: theme.colors.fg.subtle };
}

function SegmentSpans({ segments }: { segments: readonly Segment[] }) {
  return (
    <>
      {segments.map((segment, index) => (
        // Segments are positional within one row; the index is their identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above.
        <span key={index} fg={segment.fg} bg={segment.bg}>
          {segment.text}
        </span>
      ))}
    </>
  );
}

interface SlotProps {
  readonly doc: DiffDocument;
  readonly layout: DiffViewKind;
  readonly index: number;
  readonly width: number;
  readonly numberWidth: number;
  readonly scrollLeft: number;
  readonly cursor: boolean;
  readonly focused: boolean;
  readonly onPick: (index: number) => void;
  readonly onOpen: (index: number) => void;
}

/** One visible row, at a fixed slot; keyed by slot so scrolling only changes props. */
function DiffRowSlot(props: SlotProps) {
  const { doc, layout, index } = props;
  const theme = useTheme();
  const c = theme.colors;
  const pointer = usePointer({
    onClick: () => props.onPick(index),
    onDoubleClick: () => props.onOpen(index),
  });
  const row = layout === "unified" ? doc.unified[index] : doc.split[index];
  const margin = (
    <text width={1} flexShrink={0} selectable={false} fg={props.focused ? c.accent.primary : c.fg.subtle}>
      {props.cursor ? "▎" : " "}
    </text>
  );
  if (!row) return <box height={1} flexShrink={0} />;

  if (row.kind === "hunk") {
    const gutter = layout === "unified" ? props.numberWidth * 2 + 2 : props.numberWidth + 1;
    const room = Math.max(0, props.width - 1 - gutter);
    // "@@ -12,7 +12,8 @@" without the section heading, which is drawn quieter after it.
    const header = /^@@ [^@]*@@/.exec(row.header)?.[0] ?? row.header;
    const shown = truncateEnd(`${header}${row.section ? ` ${sanitizeForDisplay(row.section)}` : ""}`, room);
    const split = shown.indexOf(" @@");
    const head = split === -1 ? shown : shown.slice(0, split + 3);
    const tail = split === -1 ? "" : shown.slice(split + 3);
    return (
      <box
        height={1}
        flexShrink={0}
        flexDirection="row"
        backgroundColor={c.diff.hunkHeaderBg}
        {...pointer.props}
      >
        {margin}
        <text flexGrow={1} flexShrink={1} selectable={false} wrapMode="none" fg={c.diff.hunkHeaderFg}>
          {" ".repeat(gutter)}
          {head}
          <span fg={c.fg.subtle}>{tail}</span>
        </text>
      </box>
    );
  }

  const numberColor = props.cursor ? c.editor.lineNumberActive : c.editor.lineNumber;
  if (row.kind === "line") {
    const colors = colorsFor(theme, row.type);
    const ref = { hunk: row.hunkIndex, line: row.lineIndex };
    const contentWidth = Math.max(0, props.width - 1 - (props.numberWidth * 2 + 2) - 2);
    const segments = lineSegments(theme, row.text, {
      tokens: doc.tokensForUnifiedRow(row),
      words: row.type === "context" ? null : doc.model.wordRanges(ref),
      baseFg: doc.old.highlighted || doc.new.highlighted ? c.fg.default : colors.fg,
      lineBg: colors.bg,
      wordBg: colors.wordBg,
      scrollLeft: props.scrollLeft,
      width: contentWidth,
    });
    return (
      <box height={1} flexShrink={0} flexDirection="row" backgroundColor={colors.bg} {...pointer.props}>
        {margin}
        <text flexShrink={0} selectable={false} wrapMode="none" fg={numberColor}>
          {`${pad(row.oldLine, props.numberWidth)} ${pad(row.newLine, props.numberWidth)} `}
          <span fg={colors.sign}>{`${row.sign} `}</span>
        </text>
        <text flexGrow={1} flexShrink={1} selectable={false} wrapMode="none" fg={c.fg.default}>
          <SegmentSpans segments={segments} />
          {row.noNewlineAtEnd ? <span fg={c.fg.subtle}>{" ⊘"}</span> : null}
        </text>
      </box>
    );
  }

  // Split pair: two panes of equal width with a one-cell gap.
  const paneWidth = Math.max(4, Math.floor((props.width - 2) / 2));
  const pane = (cell: SplitCell | null, side: "old" | "new") => {
    if (!cell) {
      return (
        <box width={paneWidth} height={1} flexShrink={0} backgroundColor={c.bg.inset}>
          <text selectable={false}> </text>
        </box>
      );
    }
    const colors = colorsFor(theme, cell.type);
    const contentWidth = Math.max(0, paneWidth - props.numberWidth - 3);
    const segments = lineSegments(theme, cell.text, {
      tokens: doc.tokensForCell(side, cell),
      words:
        cell.type === "context" ? null : doc.model.wordRanges({ hunk: row.hunkIndex, line: cell.lineIndex }),
      baseFg: doc.old.highlighted || doc.new.highlighted ? c.fg.default : colors.fg,
      lineBg: colors.bg,
      wordBg: colors.wordBg,
      scrollLeft: props.scrollLeft,
      width: contentWidth,
    });
    const sign = cell.type === "added" ? "+" : cell.type === "removed" ? "-" : " ";
    return (
      <box width={paneWidth} height={1} flexShrink={0} flexDirection="row" backgroundColor={colors.bg}>
        <text flexShrink={0} selectable={false} wrapMode="none" fg={numberColor}>
          {`${pad(cell.lineNumber, props.numberWidth)} `}
          <span fg={colors.sign}>{`${sign} `}</span>
        </text>
        <text flexGrow={1} flexShrink={1} selectable={false} wrapMode="none" fg={c.fg.default}>
          <SegmentSpans segments={segments} />
        </text>
      </box>
    );
  };
  return (
    <box height={1} flexShrink={0} flexDirection="row" {...pointer.props}>
      {margin}
      {pane(row.left, "old")}
      <box width={1} height={1} flexShrink={0} backgroundColor={c.bg.surface} />
      {pane(row.right, "new")}
    </box>
  );
}

function DiffSummary({ doc, width }: { doc: DiffDocument; width: number }) {
  const theme = useTheme();
  const c = theme.colors;
  const changes = doc.model.changes.length;
  const parts: { text: string; color?: RGBA }[] = [
    { text: diffSideLabel(doc.mode), color: c.fg.muted },
    { text: `+${doc.model.added}`, color: c.git.added },
    { text: `-${doc.model.removed}`, color: c.git.deleted },
    { text: plural(changes, "change"), color: c.fg.subtle },
  ];
  if (doc.diff.status === "renamed" && doc.diff.oldPath) {
    parts.push({ text: `renamed from ${sanitizeForDisplay(doc.diff.oldPath)}`, color: c.fg.subtle });
  }
  if (doc.modeChange) {
    parts.push({ text: `mode ${doc.modeChange.oldMode} → ${doc.modeChange.newMode}`, color: c.fg.subtle });
  }
  let used = 0;
  const shown = parts.filter((part) => {
    const next = used + displayWidth(part.text) + 2;
    if (next > width) return false;
    used = next;
    return true;
  });
  return (
    <box height={1} flexShrink={0} flexDirection="row" paddingLeft={2} backgroundColor={c.bg.base}>
      <text selectable={false} wrapMode="none">
        {shown.map((part, index) => (
          <span key={part.text} fg={part.color}>
            {index === 0 ? "" : "  "}
            {part.text}
          </span>
        ))}
      </text>
    </box>
  );
}

export function DiffEditorView({
  tab,
  focused,
  controller,
}: EditorViewProps & { controller: ScmController }) {
  const app = useApp();
  const theme = useTheme();
  const c = theme.colors;
  const git = controller.git;
  const reloadToken = useStore(git.store, (state) => state.lastUpdated);
  const repoProblem = useStore(git.store, (state) => (state.repo ? null : state.error));
  const setting = useStore(app.config.store, () => app.config.get("git.defaultDiffView"));
  const [load, setLoad] = useState<LoadState>({ doc: null, error: null, loading: true });
  const [attempt, setAttempt] = useState(0);
  const { size, onSizeChange } = useMeasure();

  const valid = isDiffTab(tab);
  const path = valid ? tab.resource : "";
  const staged = tab.params.staged === true;

  // The tab object changes on every view-state write; only its identity, the Git refresh and
  // Retry decide when to reload.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  useEffect(() => {
    if (!valid) return;
    const abort = new AbortController();
    setLoad((current) => ({ ...current, loading: true }));
    const target = diffTargetOf({ ...tab, resource: path }, git.state.status);
    loadDiffDocument(target, { git, syntax: app.services.syntax }, { signal: abort.signal }).then(
      (doc) => {
        if (!abort.signal.aborted) setLoad({ doc, error: null, loading: false });
      },
      (error: unknown) => {
        if (abort.signal.aborted || isLucyError(error, "CANCELLED")) return;
        setLoad((current) => ({
          doc: current.doc,
          error: isLucyError(error) ? error : null,
          loading: false,
        }));
      },
    );
    return () => abort.abort();
  }, [valid, path, staged, reloadToken, attempt, git, app]);

  const doc = load.doc;
  const viewState = tab.viewState;
  const explicit =
    viewState.layout === "split" || viewState.layout === "unified" ? viewState.layout : undefined;
  const layout: DiffViewKind = explicit ?? resolveDiffLayout(setting, size.width);
  const rows = doc ? (layout === "unified" ? doc.unified : doc.split) : [];
  const rowCount = rows.length;
  const headerRows = doc && !doc.isBinary && !doc.isTooLarge && !doc.isEmpty ? 1 : 0;
  const height = Math.max(1, size.height - headerRows);
  const maxTop = Math.max(0, rowCount - height);
  const storedTop = typeof viewState.scrollTop === "number" ? viewState.scrollTop : 0;
  const storedCursor = typeof viewState.cursor === "number" ? viewState.cursor : 0;
  const scrollTop = Math.min(Math.max(0, storedTop), maxTop);
  const cursor = Math.min(Math.max(0, storedCursor), Math.max(0, rowCount - 1));
  const scrollLeft = typeof viewState.scrollLeft === "number" ? viewState.scrollLeft : 0;

  const numberWidth = useMemo(() => {
    if (!doc) return 2;
    let max = 0;
    for (const hunk of doc.diff.hunks)
      max = Math.max(max, hunk.oldStart + hunk.oldCount, hunk.newStart + hunk.newCount);
    return digits(max);
  }, [doc]);

  const maxLeft = useMemo(() => {
    if (!doc) return 0;
    let longest = 0;
    for (const hunk of doc.diff.hunks)
      for (const line of hunk.lines) longest = Math.max(longest, displayLength(line.text));
    const content =
      layout === "unified"
        ? size.width - 1 - (numberWidth * 2 + 4)
        : Math.floor((size.width - 2) / 2) - numberWidth - 3;
    return Math.max(0, longest - Math.max(1, content));
  }, [doc, layout, size.width, numberWidth]);

  // Remember the resolved layout so the breadcrumb toggle can label itself.
  useEffect(() => {
    if (viewState.resolvedLayout !== layout) app.editors.setViewState(tab.id, { resolvedLayout: layout });
  }, [app, tab.id, layout, viewState.resolvedLayout]);

  const update = (patch: {
    cursor?: number;
    scrollTop?: number;
    scrollLeft?: number;
    layout?: DiffViewKind;
  }) => {
    app.editors.setViewState(tab.id, patch);
  };

  const reveal = (row: number, center = false) => {
    const target = Math.min(Math.max(0, row), Math.max(0, rowCount - 1));
    let top = scrollTop;
    if (center && (target < top || target >= top + height)) top = target - Math.floor(height / 3);
    else if (target < top) top = target;
    else if (target >= top + height) top = target - height + 1;
    update({ cursor: target, scrollTop: Math.min(Math.max(0, top), maxTop) });
  };

  const openAt = (row: number) => {
    if (!doc) return;
    if (!doc.new.exists && doc.mode !== "staged") {
      app.notifications.info("The file was deleted", "There is no working-tree file to open.");
      return;
    }
    controller.openFile(path, newLineAt(doc, layout, row));
  };

  const actions = useRef<(action: DiffAction) => void>(() => {});
  actions.current = (action) => {
    if (!doc) return;
    if (action === "nextChange" || action === "previousChange") {
      const next =
        action === "nextChange"
          ? doc.model.nextChange(cursor, layout)
          : doc.model.previousChange(cursor, layout);
      if (next === null)
        app.hints.flash({
          text: action === "nextChange" ? "No more changes below" : "No more changes above",
        });
      else reveal(next, true);
    } else if (action === "toggleLayout") {
      const nextLayout: DiffViewKind = layout === "split" ? "unified" : "split";
      const mapped = mapRow(doc, layout, cursor);
      update({ layout: nextLayout, cursor: mapped, scrollTop: Math.max(0, mapped - Math.floor(height / 3)) });
    } else if (action === "openFile") {
      openAt(cursor);
    }
  };
  useEffect(
    () => controller.onDidRequestDiffAction((action) => actions.current(action)).dispose,
    [controller],
  );

  useKeyHandler((stroke) => {
    if (!doc || stroke.ctrl || stroke.alt || stroke.super) return false;
    const key = normalizeKey(stroke.key) ?? stroke.key;
    const page = Math.max(1, height - 1);
    switch (key) {
      case "down":
      case "j":
        reveal(cursor + 1);
        return true;
      case "up":
      case "k":
        reveal(cursor - 1);
        return true;
      case "pagedown":
      case "space":
        update({
          cursor: Math.min(rowCount - 1, cursor + page),
          scrollTop: Math.min(maxTop, scrollTop + page),
        });
        return true;
      case "pageup":
        update({ cursor: Math.max(0, cursor - page), scrollTop: Math.max(0, scrollTop - page) });
        return true;
      case "home":
      case "g":
        reveal(0);
        return true;
      case "end":
        reveal(rowCount - 1);
        return true;
      case "left":
      case "h":
        update({ scrollLeft: Math.max(0, scrollLeft - HORIZONTAL_STEP) });
        return true;
      case "right":
      case "l":
        update({ scrollLeft: Math.min(maxLeft, scrollLeft + HORIZONTAL_STEP) });
        return true;
      case "]":
      case "n":
        actions.current("nextChange");
        return true;
      case "[":
      case "p":
        actions.current("previousChange");
        return true;
      case "v":
        actions.current("toggleLayout");
        return true;
      case "enter":
      case "o":
        openAt(cursor);
        return true;
      default:
        if (stroke.key === "G" || (stroke.shift && key === "g")) {
          reveal(rowCount - 1);
          return true;
        }
        return false;
    }
  });

  const onWheel = (event: MouseEvent) => {
    const direction = event.scroll?.direction;
    const horizontal = direction === "left" || direction === "right" || (event.modifiers?.shift ?? false);
    if (horizontal) {
      const delta = direction === "left" || direction === "up" ? -HORIZONTAL_STEP : HORIZONTAL_STEP;
      update({ scrollLeft: Math.min(maxLeft, Math.max(0, scrollLeft + delta)) });
      return;
    }
    if (direction !== "up" && direction !== "down") return;
    const delta = direction === "down" ? WHEEL_STEP : -WHEEL_STEP;
    update({ scrollTop: Math.min(maxTop, Math.max(0, scrollTop + delta)) });
  };

  let body: ReactNode;
  if (!valid) {
    body = <EmptyState title="Nothing to compare" description="This tab does not name a file." />;
  } else if (repoProblem) {
    body = (
      <EmptyState
        title="Source Control is not available"
        description={repoProblem.message}
        actions={[{ label: "Refresh", command: "git.refresh" }]}
      />
    );
  } else if (!doc && load.error) {
    body = (
      <ErrorState
        title="The diff could not be loaded"
        message={load.error.message}
        actions={[{ label: "Retry", onPress: () => setAttempt((n) => n + 1) }]}
      />
    );
  } else if (!doc) {
    body = (
      <box paddingLeft={2} paddingTop={1} flexShrink={0}>
        <text selectable={false}>
          <Spinner label="Loading the diff" />
        </text>
      </box>
    );
  } else if (doc.isBinary) {
    body = (
      <EmptyState
        title="Binary file"
        description="Binary changes cannot be shown as text."
        actions={doc.new.exists ? [{ label: "Open File", command: "git.openFile" }] : []}
      />
    );
  } else if (doc.isTooLarge) {
    body = (
      <EmptyState
        title="This diff is too large to show"
        description="Open the file to read it, or use a terminal for the full patch."
        actions={[{ label: "Open File", command: "git.openFile" }]}
      />
    );
  } else if (doc.isEmpty) {
    // A pure rename (similarity 100%) has a patch but no hunks; "No changes" would be wrong.
    const moved =
      (doc.diff.status === "renamed" || doc.diff.status === "copied") && doc.diff.oldPath ? doc.diff : null;
    body = (
      <EmptyState
        title={
          moved
            ? `${moved.status === "renamed" ? "Renamed" : "Copied"} without content changes`
            : doc.modeChange
              ? "Only the file mode changed"
              : "No changes"
        }
        description={
          moved
            ? `From ${moved.oldPath}`
            : doc.modeChange
              ? `${doc.modeChange.oldMode} → ${doc.modeChange.newMode}`
              : staged
                ? "Nothing is staged for this file."
                : "The file matches its staged version."
        }
      />
    );
  } else {
    const slots: ReactNode[] = [];
    for (let slot = 0; slot < height; slot++) {
      const index = scrollTop + slot;
      slots.push(
        <DiffRowSlot
          key={slot}
          doc={doc}
          layout={layout}
          index={index}
          width={size.width}
          numberWidth={numberWidth}
          scrollLeft={scrollLeft}
          cursor={index === cursor}
          focused={focused}
          onPick={(row) => update({ cursor: row })}
          onOpen={openAt}
        />,
      );
    }
    body = (
      <box flexGrow={1} flexDirection="column" minHeight={0} overflow="hidden" onMouseScroll={onWheel}>
        {slots}
      </box>
    );
  }

  return (
    <box
      flexGrow={1}
      flexDirection="column"
      minHeight={0}
      backgroundColor={c.bg.base}
      onSizeChange={onSizeChange}
    >
      {doc && !doc.isBinary && !doc.isTooLarge && !doc.isEmpty ? (
        <DiffSummary doc={doc} width={size.width - 2} />
      ) : null}
      {doc?.truncated ? (
        <box height={1} flexShrink={0} paddingLeft={2}>
          <text selectable={false} fg={c.fg.muted}>
            <Icon name="info" tone="subtle" />
            {`Showing the first ${doc.model.maxRows.toLocaleString("en-US")} rows of this diff.`}
          </text>
        </box>
      ) : null}
      {body}
    </box>
  );
}

/** Tab title: the file name (the shell draws the file-type icon and the "(staged)" suffix). */
export function diffTabTitle(resource: string | undefined): string | undefined {
  return resource?.split("/").filter(Boolean).at(-1);
}
