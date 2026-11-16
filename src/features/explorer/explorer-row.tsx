/**
 * The explorer's tree rows, built from the design system's tree helpers (`TreeIndent`,
 * `Chevron`, `FileIcon`) with the same metrics as `TreeRowContent`: 2 cells per depth, a
 * 2-cell chevron slot, an icon and a space, the name truncated to fit, a right-aligned status
 * column. The explorer needs a few things the generic row does not have (a bold active file,
 * error and link annotations, the inline input), hence its own composition.
 */
import type { BoxRenderable } from "@opentui/core";
import type { Ref } from "react";
import { displayWidth, sanitizeForDisplay, truncateEnd } from "@/core/text";
import { icon } from "@/themes";
import { FileIcon, Icon } from "@/ui/primitives/icon";
import type { ListRowState } from "@/ui/primitives/list";
import { Spinner, useDelayedFlag } from "@/ui/primitives/spinner";
import { Span } from "@/ui/primitives/text";
import { TextField, type TextFieldHandle } from "@/ui/primitives/text-field";
import { Chevron, TreeIndent } from "@/ui/primitives/tree";
import { useTheme } from "@/ui/theme/theme-context";
import { colorOf } from "@/ui/theme/ui-theme";
import { SIZE } from "@/ui/tokens/spacing";
import type { ExplorerEditRow, ExplorerEntryRow, ExplorerMoreRow, ValidationMessage } from "./model";

/** Cells before the name: indentation, chevron slot, icon and its space. */
export function prefixWidth(depth: number): number {
  return depth * SIZE.treeIndent + 2 + 2;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Where a symlink leads, in words: shown muted after the name. */
function linkNote(row: ExplorerEntryRow): string {
  if (row.symlink === "broken") return "broken link";
  if (row.symlink === "outside") return "link outside workspace";
  if (row.symlink === "inside") return "link";
  return "";
}

export function EntryRowContent({
  row,
  state,
  rowRef,
}: {
  row: ExplorerEntryRow;
  state: ListRowState;
  rowRef?: Ref<BoxRenderable>;
}) {
  const theme = useTheme();
  const c = theme.colors;
  const spinning = useDelayedFlag(row.loading);
  const isDirectory = row.kind === "directory";
  const labelColor = state.active ? c.state.selectedFg : row.dimmed ? c.fg.subtle : c.fg.default;

  // Status column: a spinner while a folder loads, an error mark, else the Git letter.
  let status = "";
  let statusColor = c.fg.muted;
  if (row.error) {
    status = icon("error", theme.icons);
    statusColor = c.status.error;
  } else if (row.git) {
    status = row.git.text;
    statusColor = colorOf(theme, row.git.color);
  }
  const statusWidth = spinning ? 2 : status ? displayWidth(status) + 1 : 0;
  const room = Math.max(1, state.width - prefixWidth(row.depth) - statusWidth);
  const label = truncateEnd(row.name, room);
  const note = row.error ? row.error : linkNote(row);
  const noteRoom = room - displayWidth(label) - 1;
  const shownNote = note && noteRoom >= 4 ? truncateEnd(sanitizeForDisplay(note), noteRoom) : "";
  const noteColor = row.error ? (state.active ? c.state.selectedFg : c.status.error) : c.fg.subtle;
  const iconColor = state.active ? c.state.selectedFg : row.dimmed ? c.fg.subtle : undefined;
  return (
    <box ref={rowRef} flexGrow={1} flexShrink={1} flexDirection="row">
      <text flexGrow={1} flexShrink={1} selectable={false} wrapMode="none" fg={labelColor}>
        <TreeIndent depth={row.depth} />
        <Chevron expandable={isDirectory} expanded={row.expanded} />
        <FileIcon
          name={baseName(row.path)}
          kind={isDirectory ? (row.expanded ? "directory-open" : "directory") : "file"}
          color={iconColor}
        />
        <Span color={labelColor} bold={row.active}>
          {label}
        </Span>
        {shownNote ? <Span color={noteColor}>{` ${shownNote}`}</Span> : null}
      </text>
      {spinning ? (
        <text flexShrink={0} selectable={false} fg={c.fg.subtle}>
          {" "}
          <Spinner delayMs={0} />
        </text>
      ) : status ? (
        <text flexShrink={0} selectable={false} fg={statusColor}>
          {` ${status}`}
        </text>
      ) : null}
    </box>
  );
}

export function MoreRowContent({
  row,
  state,
  rowRef,
}: {
  row: ExplorerMoreRow;
  state: ListRowState;
  rowRef?: Ref<BoxRenderable>;
}) {
  const theme = useTheme();
  const c = theme.colors;
  const color = state.active ? c.state.selectedFg : state.hovered ? c.fg.default : c.fg.muted;
  const label = truncateEnd(`Show ${row.label}`, Math.max(1, state.width - prefixWidth(row.depth)));
  return (
    <box ref={rowRef} flexGrow={1} flexShrink={1} flexDirection="row">
      <text flexGrow={1} flexShrink={1} selectable={false} wrapMode="none" fg={color}>
        <TreeIndent depth={row.depth} />
        <Span>{"  "}</Span>
        <Icon name="more" color={state.active ? c.state.selectedFg : c.fg.subtle} />
        <Span color={color} italic>
          {label}
        </Span>
      </text>
    </box>
  );
}

export function EditRowContent({
  row,
  initialValue,
  fieldRef,
  onInput,
  onSubmit,
  rowRef,
}: {
  row: ExplorerEditRow;
  initialValue: string;
  fieldRef: Ref<TextFieldHandle>;
  onInput: (value: string) => void;
  onSubmit: () => void;
  rowRef?: Ref<BoxRenderable>;
}) {
  const folder = row.entryKind === "directory";
  const name = baseName(row.value) || (folder ? "folder" : "file");
  return (
    <box ref={rowRef} flexGrow={1} flexShrink={1} flexDirection="row">
      <text flexShrink={0} selectable={false} wrapMode="none">
        <TreeIndent depth={row.depth} />
        <Chevron expandable={false} expanded={false} />
        <FileIcon name={name} kind={folder ? "directory" : "file"} />
      </text>
      <box flexGrow={1} flexShrink={1} flexDirection="row">
        <TextField
          ref={fieldRef}
          value={initialValue}
          focused
          width="100%"
          invalid={row.message?.severity === "error"}
          onInput={onInput}
          onSubmit={() => onSubmit()}
        />
      </box>
    </box>
  );
}

/** Wraps a validation message into lines that fit `width` cells after `indent` cells. */
export function wrapMessage(text: string, width: number): string[] {
  const room = Math.max(8, width);
  const lines: string[] = [];
  let line = "";
  for (const word of sanitizeForDisplay(text).split(" ")) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (displayWidth(candidate) <= room) {
      line = candidate;
      continue;
    }
    if (line !== "") lines.push(line);
    line = displayWidth(word) > room ? truncateEnd(word, room) : word;
  }
  if (line !== "") lines.push(line);
  return lines.length > 0 ? lines : [""];
}

/** One line of the inline input's validation message, aligned under the input text. */
export function MessageRowContent({
  message,
  line,
  first,
  depth,
}: {
  message: ValidationMessage;
  line: string;
  first: boolean;
  depth: number;
}) {
  const theme = useTheme();
  const c = theme.colors;
  const color = message.severity === "error" ? c.status.error : c.status.warning;
  return (
    <text flexGrow={1} selectable={false} wrapMode="none" fg={color}>
      {" ".repeat(prefixWidth(depth) - 2)}
      {first ? <Icon name={message.severity === "error" ? "error" : "warning"} color={color} /> : "  "}
      <Span color={color}>{line}</Span>
    </text>
  );
}
