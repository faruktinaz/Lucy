/**
 * Tree-row building blocks for List rows: indentation with quiet indent guides (2 cells per
 * depth), chevrons, and the standard explorer-style row (icon, label, muted description,
 * right-aligned status letter).
 *
 *   <List items={rows} renderRow={(row, state) => (
 *     <TreeRowContent depth={row.depth} expandable={row.isDir} expanded={row.open}
 *       icon={<FileIcon name={row.name} kind={row.isDir ? "directory" : "file"} />}
 *       label={row.name} status={row.letter} statusColor={...} state={state} />
 *   )} />
 */
import type { RGBA } from "@opentui/core";
import type { ReactNode } from "react";
import { displayWidth, sanitizeForDisplay, truncateEnd } from "@/core/text";
import { icon } from "@/themes/icons";
import { useTheme } from "../theme/theme-context";
import { SIZE } from "../tokens/spacing";
import type { ListRowState } from "./list";
import { Span, toneColor } from "./text";

const GUIDE = "│";

/** Indentation for `depth` levels; `guides[level]` draws a guide line at that level. */
export function treeIndent(depth: number, guides?: readonly boolean[]): string {
  let out = "";
  for (let level = 0; level < depth; level++) {
    out += (guides?.[level] ?? true) && level > 0 ? `${GUIDE} ` : "  ";
  }
  return out;
}

export function TreeIndent({ depth, guides }: { depth: number; guides?: readonly boolean[] }) {
  const theme = useTheme();
  if (depth <= 0) return null;
  return <Span color={theme.colors.editor.indentGuide}>{treeIndent(depth, guides)}</Span>;
}

/** A chevron for expandable rows, or blank space of the same width. */
export function Chevron({
  expandable,
  expanded,
  color,
}: {
  expandable: boolean;
  expanded: boolean;
  color?: RGBA;
}) {
  const theme = useTheme();
  if (!expandable) return <Span>{"  "}</Span>;
  return (
    <Span
      color={color ?? theme.colors.fg.subtle}
    >{`${icon(expanded ? "chevronDown" : "chevronRight", theme.icons)} `}</Span>
  );
}

export interface TreeRowContentProps {
  depth: number;
  expandable?: boolean;
  expanded?: boolean;
  guides?: readonly boolean[];
  /** An `<Icon>` or `<FileIcon>` (already followed by a space). */
  icon?: ReactNode;
  label: string;
  /** Muted text after the label (a folder path, a count). */
  description?: string;
  /** Right-aligned status letter ("M", "U") or count. */
  status?: string;
  statusColor?: RGBA;
  /** Draw the label dimmed (ignored files). */
  dimmed?: boolean;
  /** Draw the label struck through (deleted files). */
  strikethrough?: boolean;
  state: ListRowState;
}

/** The standard tree/list row. Truncates the label (then the description) to fit. */
export function TreeRowContent({
  depth,
  expandable = false,
  expanded = false,
  guides,
  icon: iconNode,
  label,
  description,
  status,
  statusColor,
  dimmed = false,
  strikethrough = false,
  state,
}: TreeRowContentProps) {
  const theme = useTheme();
  const c = theme.colors;
  const labelColor = state.active ? c.state.selectedFg : dimmed ? c.fg.subtle : c.fg.default;
  const safeLabel = sanitizeForDisplay(label);
  const safeDescription = description ? sanitizeForDisplay(description) : "";
  const indentWidth = depth * SIZE.treeIndent + 2 + (iconNode ? 2 : 0);
  const statusWidth = status ? displayWidth(status) + 1 : 0;
  const room = Math.max(1, state.width - indentWidth - statusWidth);
  const shownLabel = truncateEnd(safeLabel, room);
  const descriptionRoom = room - displayWidth(shownLabel) - 1;
  const shownDescription =
    safeDescription && descriptionRoom >= 4 ? truncateEnd(safeDescription, descriptionRoom) : "";
  return (
    <>
      <text flexGrow={1} flexShrink={1} selectable={false} fg={labelColor}>
        <TreeIndent depth={depth} guides={guides} />
        <Chevron expandable={expandable} expanded={expanded} />
        {iconNode}
        <Span color={labelColor} strikethrough={strikethrough}>
          {shownLabel}
        </Span>
        {shownDescription ? <Span tone="subtle">{` ${shownDescription}`}</Span> : null}
      </text>
      {status ? (
        <text flexShrink={0} selectable={false} fg={statusColor ?? toneColor(theme, "muted")}>
          {` ${status}`}
        </text>
      ) : null}
    </>
  );
}
