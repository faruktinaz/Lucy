/**
 * The Settings editor tab: a search field, the config file's problems, then every setting
 * grouped by category, each with its title, description, current value in the right control,
 * a modified marker, its config key and restart note. A footer shows the keys for the current
 * focus and where the file lives.
 *
 * Focus moves between three areas: the search field, the problems banner and the list.
 * Inside the list a setting can open an inline option picker (live preview for theme, accent,
 * density and icons, reverted on Escape), an inline text editor with live validation, or an
 * inline editor for string lists. All state that must survive switching tabs lives in the
 * shared `SettingsViewModel`; only the focus area and the open picker are local.
 */
import type { RGBA } from "@opentui/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useApp, useFocusTarget, useKeyHandler, useStore } from "@/app/react";
import type { EditorViewProps } from "@/app/workbench/views";
import type { SettingPath } from "@/core/config/schema";
import { getSetting } from "@/core/config/values";
import { normalizeKey } from "@/core/keybindings";
import { isTypingStroke, type KeyStroke } from "@/core/keybindings/key-stroke";
import { displayWidth, sanitizeForDisplay, truncateEnd, truncateMiddle } from "@/core/text";
import { icon } from "@/themes/icons";
import { useMeasure } from "@/ui/primitives/measure";
import { attrs } from "@/ui/primitives/text";
import { TextField, type TextFieldHandle } from "@/ui/primitives/text-field";
import { usePointer } from "@/ui/primitives/use-pointer";
import { useDensity, useTheme } from "@/ui/theme/theme-context";
import type { UiTheme } from "@/ui/theme/ui-theme";
import { openConfigFile } from "../config-file";
import type { SettingItemRow, SettingsRow, SettingsState } from "../model/settings-view-model";
import {
  CANVAS_PADDING_X,
  type HintItem,
  HintLine,
  SearchRow,
  TextAction,
  useRendererBridge,
  useSettingsServices,
} from "./shared";
import { controlColumnWidth, fitWidth, wrapText } from "./text-layout";

type Area = "search" | "banner" | "list";

/** The footer's promise (the full statement with the path is `state.file.statement`). */
const PROMISE =
  "Lucy writes only its own files and never edits other tools' configuration, such as your shell, Git, terminal or tmux settings.";

interface PickerOption {
  readonly value: string;
  readonly label: string;
  /** Opens a custom value editor instead of picking. */
  readonly custom?: "color" | "command";
}

interface PickerState {
  readonly path: SettingPath;
  readonly index: number;
  readonly options: readonly PickerOption[];
  /** The picker is previewing (live-preview settings): Escape restores the saved value. */
  readonly previewing: boolean;
}

interface ListEditorState {
  readonly path: SettingPath;
  /** Entry index; `entries.length` is the "Add entry" line. */
  readonly index: number;
}

interface Layout {
  readonly width: number;
  readonly left: number;
  readonly stacked: boolean;
  readonly controlWidth: number;
  readonly textWidth: number;
  readonly gap: number;
}

function layoutFor(width: number, gap: number): Layout {
  const inner = Math.max(20, width - CANVAS_PADDING_X * 2);
  const stacked = inner < 62;
  const controlWidth = stacked ? Math.min(inner - 2, 40) : controlColumnWidth(inner);
  return {
    width,
    left: CANVAS_PADDING_X,
    stacked,
    controlWidth,
    textWidth: stacked ? inner - 2 : inner - controlWidth - 3,
    gap,
  };
}

function pickerOptions(row: SettingItemRow): PickerOption[] {
  const control = row.control;
  if (control.kind === "select") return control.options.map((o) => ({ value: o.value, label: o.label }));
  if (control.kind === "select-or-color") {
    return [
      ...control.options.map((o) => ({ value: o.value, label: o.label })),
      { value: "", label: "Custom color…", custom: "color" },
    ];
  }
  if (control.kind === "select-or-command") {
    return [
      ...control.options.map((o) => ({ value: o.value, label: o.label })),
      { value: "", label: "Custom command…", custom: "command" },
    ];
  }
  return [];
}

function itemEntries(row: SettingItemRow): readonly string[] {
  return Array.isArray(row.value) && row.control.kind === "list" ? (row.value as string[]) : [];
}

/** Lines an item occupies, so the list can window by blocks of known height. */
function itemHeight(
  row: SettingItemRow,
  layout: Layout,
  state: SettingsState,
  picker: PickerState | null,
  listEditor: ListEditorState | null,
): number {
  let lines = 1 + wrapText(row.description, layout.textWidth, 2).length;
  if (row.problem) lines += 1;
  if (row.requiresRestart) lines += 1;
  if (layout.stacked) lines += 1;
  if (state.edit?.path === row.path && state.edit.kind !== "list-entry" && state.edit.error) lines += 1;
  if (picker?.path === row.path) lines += picker.options.length;
  if (listEditor?.path === row.path) {
    lines += itemEntries(row).length + 1;
    if (state.edit?.path === row.path && state.edit.kind === "list-entry" && state.edit.error) lines += 1;
  }
  return lines + layout.gap;
}

// --------------------------------------------------------------------- value controls

function ControlValue({
  row,
  width,
  active,
  onPress,
}: {
  row: SettingItemRow;
  width: number;
  active: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const c = theme.colors;
  const pointer = usePointer({ onClick: onPress });
  const control = row.control;
  const chevron = active ? c.accent.primary : c.fg.subtle;
  let content: ReactNode;
  switch (control.kind) {
    case "toggle": {
      const on = row.value === true;
      content = (
        <text selectable={false}>
          <span
            fg={on ? c.fg.onAccent : c.fg.muted}
            bg={on ? c.accent.primary : c.bg.raised}
            attributes={attrs({ bold: on })}
          >
            {on ? " On  " : " Off "}
          </span>
        </text>
      );
      break;
    }
    case "select":
    case "select-or-color":
    case "select-or-command": {
      const custom = control.kind === "select-or-command" && Array.isArray(row.value);
      const swatch = control.kind === "select-or-color";
      const room = Math.max(4, width - (swatch ? 7 : 4));
      content = (
        <text selectable={false} wrapMode="none">
          {swatch ? <span bg={c.accent.primary}>{"  "}</span> : null}
          {swatch ? " " : null}
          <span fg={chevron}>{`${icon("chevronLeft", theme.icons)} `}</span>
          <span fg={custom ? c.fg.muted : c.fg.default}>
            {truncateEnd(sanitizeForDisplay(row.valueLabel), room)}
          </span>
          <span fg={chevron}>{` ${icon("chevronRight", theme.icons)}`}</span>
        </text>
      );
      break;
    }
    case "number": {
      const unit = control.unit ? ` ${control.unit}` : "";
      content = (
        <text selectable={false} wrapMode="none">
          <span fg={c.fg.default} bg={c.bg.inset}>{` ${String(row.value)} `}</span>
          <span fg={c.fg.subtle}>{truncateEnd(unit, Math.max(0, width - String(row.value).length - 2))}</span>
        </text>
      );
      break;
    }
    case "text": {
      const empty = row.value === "";
      content = (
        <text selectable={false} wrapMode="none">
          <span fg={empty ? c.fg.subtle : c.fg.default} bg={c.bg.inset}>
            {` ${fitWidth(truncateEnd(sanitizeForDisplay(row.valueLabel), width - 2), width - 2)} `}
          </span>
        </text>
      );
      break;
    }
    case "list": {
      const entries = itemEntries(row);
      const label =
        entries.length === 0 ? "None" : `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`;
      const preview = entries.length > 0 ? `  ${entries.join(", ")}` : "";
      content = (
        <text selectable={false} wrapMode="none">
          <span fg={c.fg.default}>{label}</span>
          <span fg={c.fg.subtle}>
            {truncateEnd(sanitizeForDisplay(preview), Math.max(0, width - label.length))}
          </span>
        </text>
      );
      break;
    }
    case "keybindings":
      content = (
        <text selectable={false} wrapMode="none" fg={pointer.hovered ? c.fg.default : c.accent.primary}>
          {`${row.valueLabel}  ${icon("chevronRight", theme.icons)}`}
        </text>
      );
      break;
  }
  return (
    <box height={1} width={width} flexShrink={0} flexDirection="row" {...pointer.props}>
      {content}
    </box>
  );
}

// --------------------------------------------------------------------------- one item

interface ItemProps {
  row: SettingItemRow;
  layout: Layout;
  selected: boolean;
  listFocused: boolean;
  state: SettingsState;
  picker: PickerState | null;
  listEditor: ListEditorState | null;
  editFocused: boolean;
  onSelect: () => void;
  onActivate: () => void;
  onReset: () => void;
  onPick: (index: number) => void;
  onListLine: (index: number) => void;
  onRemoveEntry: (index: number) => void;
  onDraft: (value: string) => void;
}

function rowBg(theme: UiTheme, selected: boolean, active: boolean): RGBA | undefined {
  if (!selected) return undefined;
  return active ? theme.colors.state.selectedBg : theme.colors.state.selectedInactiveBg;
}

function SettingItem(props: ItemProps) {
  const { row, layout, selected, listFocused, state, picker, listEditor, editFocused } = props;
  const theme = useTheme();
  const c = theme.colors;
  const pointer = usePointer({ onClick: props.onSelect, onDoubleClick: props.onActivate });
  const editing = state.edit?.path === row.path ? state.edit : null;
  const innerFocus = picker?.path === row.path || listEditor?.path === row.path || editing !== null;
  // While a picker, list editor or text edit is open the focus is inside it: the item itself
  // only keeps the unfocused selection tint.
  const active = selected && listFocused && !innerFocus;
  const bg = rowBg(theme, selected, active);
  const titleColor = active ? c.state.selectedFg : c.fg.default;
  const descColor = active ? c.fg.default : c.fg.muted;
  const description = wrapText(row.description, layout.textWidth, 2);
  const keyHint = `  ${row.configKey}`;
  const resetLabel = "Reset";
  const showReset =
    row.modified && !innerFocus && (selected || pointer.hovered) && row.control.kind !== "keybindings";
  const titleRoom = layout.stacked ? layout.textWidth : layout.textWidth;
  const titleText = truncateEnd(row.title, titleRoom);
  const keyRoom = titleRoom - displayWidth(titleText) - (showReset ? resetLabel.length + 3 : 0);
  const marker = row.modified ? "▎" : theme.highContrast && selected ? "▌" : " ";
  const markerColor = row.modified ? c.accent.primary : c.fg.muted;
  const control =
    editing && editing.kind !== "list-entry" ? (
      <box width={layout.controlWidth} height={1} flexShrink={0}>
        <TextField
          value={editing.draft}
          focused={editFocused}
          invalid={editing.error !== null}
          onInput={props.onDraft}
        />
      </box>
    ) : (
      <ControlValue row={row} width={layout.controlWidth} active={active} onPress={props.onActivate} />
    );
  const restartPending = state.restartPending.includes(row.path);
  const lines: ReactNode[] = [];
  const textLine = (key: string, node: ReactNode, lineBg: RGBA | undefined = bg) => (
    <box key={key} height={1} flexShrink={0} flexDirection="row" backgroundColor={lineBg}>
      <text width={layout.left} flexShrink={0} selectable={false} fg={markerColor}>
        {fitWidth(marker, layout.left)}
      </text>
      {node}
    </box>
  );

  lines.push(
    textLine(
      "title",
      <>
        <box
          width={layout.stacked ? undefined : layout.textWidth}
          flexGrow={layout.stacked ? 1 : 0}
          flexShrink={0}
          flexDirection="row"
        >
          <text selectable={false} wrapMode="none" flexShrink={1}>
            <span fg={titleColor} attributes={attrs({ bold: selected && theme.highContrast })}>
              {titleText}
            </span>
            {keyRoom > 6 ? <span fg={c.fg.subtle}>{truncateEnd(keyHint, keyRoom)}</span> : null}
          </text>
          {showReset ? (
            <box flexGrow={1} flexDirection="row" justifyContent="flex-end">
              <ResetAction label={resetLabel} onPress={props.onReset} />
            </box>
          ) : null}
        </box>
        {layout.stacked ? null : (
          <>
            <box width={3} flexShrink={0} />
            {control}
          </>
        )}
      </>,
    ),
  );
  description.forEach((line, index) => {
    lines.push(
      textLine(
        `desc-${index}`,
        <text selectable={false} wrapMode="none" fg={descColor}>
          {line}
        </text>,
      ),
    );
  });
  if (row.problem) {
    lines.push(
      textLine(
        "problem",
        <text selectable={false} wrapMode="none" fg={c.status.warning}>
          <span>{`${icon("warning", theme.icons)} `}</span>
          {truncateEnd(`config.toml: ${row.problem}`, layout.textWidth - 2)}
        </text>,
      ),
    );
  }
  if (row.requiresRestart) {
    lines.push(
      textLine(
        "restart",
        <text selectable={false} wrapMode="none" fg={restartPending ? c.status.warning : c.fg.subtle}>
          {restartPending ? "Restart Lucy to apply the new value." : "Takes effect after restarting Lucy."}
        </text>,
      ),
    );
  }
  if (layout.stacked) {
    lines.push(textLine("control", control));
  }
  if (editing && editing.kind !== "list-entry" && editing.error) {
    lines.push(
      textLine(
        "error",
        <text selectable={false} wrapMode="none" fg={c.status.error}>
          {`${icon("error", theme.icons)} ${truncateEnd(editing.error, layout.width - layout.left - 4)}`}
        </text>,
      ),
    );
  }
  if (picker?.path === row.path) {
    // While previewing, the config holds the previewed value; "current" is what is saved.
    const savedValue = state.preview?.path === row.path ? state.preview.original : row.value;
    picker.options.forEach((option, index) => {
      lines.push(
        <PickerLine
          key={`option-${option.label}`}
          left={layout.left}
          label={option.label}
          current={!option.custom && option.value === savedValue}
          highlighted={index === picker.index}
          focused={listFocused}
          custom={option.custom !== undefined}
          onPress={() => props.onPick(index)}
        />,
      );
    });
  }
  if (listEditor?.path === row.path) {
    const entries = itemEntries(row);
    // Entries may repeat; the occurrence number keeps React keys unique and stable.
    const seen = new Map<string, number>();
    entries.forEach((entry, index) => {
      const editingEntry = editing?.kind === "list-entry" && editing.index === index;
      const occurrence = (seen.get(entry) ?? 0) + 1;
      seen.set(entry, occurrence);
      lines.push(
        <ListEntryLine
          key={`entry-${entry}-${occurrence}`}
          left={layout.left}
          width={layout.controlWidth + layout.textWidth}
          label={entry}
          highlighted={listEditor.index === index}
          focused={listFocused}
          editing={editingEntry ? editing.draft : null}
          editFocused={editFocused}
          invalid={editingEntry && editing.error !== null}
          onDraft={props.onDraft}
          onPress={() => props.onListLine(index)}
          onRemove={() => props.onRemoveEntry(index)}
        />,
      );
    });
    const adding = editing?.kind === "list-entry" && editing.index === null;
    lines.push(
      <ListEntryLine
        key="entry-add"
        left={layout.left}
        width={layout.controlWidth + layout.textWidth}
        label="Add entry"
        add
        highlighted={listEditor.index === entries.length}
        focused={listFocused}
        editing={adding && editing ? editing.draft : null}
        editFocused={editFocused}
        invalid={adding && editing?.error !== null && editing?.error !== undefined}
        onDraft={props.onDraft}
        onPress={() => props.onListLine(entries.length)}
      />,
    );
    if (editing?.kind === "list-entry" && editing.error) {
      lines.push(
        textLine(
          "list-error",
          <text selectable={false} wrapMode="none" fg={c.status.error}>
            {`  ${icon("error", theme.icons)} ${editing.error}`}
          </text>,
          undefined,
        ),
      );
    }
  }
  return (
    <box flexDirection="column" flexShrink={0} {...pointer.props}>
      {lines}
      {layout.gap > 0 ? <box height={layout.gap} flexShrink={0} /> : null}
    </box>
  );
}

function ResetAction({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  const c = theme.colors;
  const pointer = usePointer({ onClick: onPress, hint: { text: "Reset to the default value" } });
  return (
    <box
      height={1}
      flexShrink={0}
      paddingX={1}
      backgroundColor={pointer.hovered ? c.state.hover : undefined}
      {...pointer.props}
    >
      <text fg={pointer.hovered ? c.fg.default : c.accent.primary} selectable={false}>
        {label}
      </text>
    </box>
  );
}

function PickerLine({
  left,
  label,
  current,
  highlighted,
  focused,
  custom,
  onPress,
}: {
  left: number;
  label: string;
  current: boolean;
  highlighted: boolean;
  focused: boolean;
  custom: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const c = theme.colors;
  const pointer = usePointer({ onClick: onPress });
  const bg = highlighted
    ? focused
      ? c.state.selectedBg
      : c.state.selectedInactiveBg
    : pointer.hovered
      ? c.state.hover
      : undefined;
  const fg = highlighted && focused ? c.state.selectedFg : custom ? c.fg.muted : c.fg.default;
  return (
    <box height={1} flexShrink={0} flexDirection="row" paddingLeft={left + 2} {...pointer.props}>
      <box flexDirection="row" backgroundColor={bg} paddingX={1} flexShrink={0} minWidth={24}>
        <text selectable={false} wrapMode="none">
          <span fg={highlighted ? c.accent.primary : c.fg.subtle}>
            {highlighted ? `${icon("chevronRight", theme.icons)} ` : "  "}
          </span>
          <span fg={fg} attributes={attrs({ bold: highlighted && theme.highContrast })}>
            {label}
          </span>
          {current ? <span fg={c.fg.subtle}>{`  ${icon("check", theme.icons)} current`}</span> : null}
          {"  "}
        </text>
      </box>
    </box>
  );
}

function ListEntryLine({
  left,
  width,
  label,
  add = false,
  highlighted,
  focused,
  editing,
  editFocused,
  invalid,
  onDraft,
  onPress,
  onRemove,
}: {
  left: number;
  width: number;
  label: string;
  add?: boolean;
  highlighted: boolean;
  focused: boolean;
  editing: string | null;
  editFocused: boolean;
  invalid: boolean;
  onDraft: (value: string) => void;
  onPress: () => void;
  onRemove?: () => void;
}) {
  const theme = useTheme();
  const c = theme.colors;
  const pointer = usePointer({ onClick: onPress });
  const bg =
    highlighted && editing === null
      ? focused
        ? c.state.selectedBg
        : c.state.selectedInactiveBg
      : pointer.hovered
        ? c.state.hover
        : undefined;
  const fg = highlighted && focused ? c.state.selectedFg : add ? c.accent.primary : c.fg.default;
  const fieldWidth = Math.max(16, Math.min(48, width - 4));
  return (
    <box height={1} flexShrink={0} flexDirection="row" paddingLeft={left + 2} {...pointer.props}>
      {editing !== null ? (
        <box width={fieldWidth} flexShrink={0}>
          <TextField
            value={editing}
            focused={editFocused}
            invalid={invalid}
            onInput={onDraft}
            placeholder={add ? "New entry" : undefined}
          />
        </box>
      ) : (
        <box flexDirection="row" backgroundColor={bg} paddingX={1} flexShrink={0} width={fieldWidth}>
          <text selectable={false} wrapMode="none" flexGrow={1} fg={fg}>
            {add ? `+ ${label}` : truncateEnd(sanitizeForDisplay(label), fieldWidth - 6)}
          </text>
          {!add && (highlighted || pointer.hovered) && onRemove ? <RemoveButton onPress={onRemove} /> : null}
        </box>
      )}
    </box>
  );
}

function RemoveButton({ onPress }: { onPress: () => void }) {
  const theme = useTheme();
  const c = theme.colors;
  const pointer = usePointer({ onClick: onPress, hint: { text: "Remove this entry" } });
  return (
    <box
      height={1}
      width={3}
      flexShrink={0}
      justifyContent="center"
      backgroundColor={pointer.hovered ? c.state.hover : undefined}
      {...pointer.props}
    >
      <text fg={pointer.hovered ? c.status.error : c.fg.subtle} selectable={false}>
        {icon("close", theme.icons)}
      </text>
    </box>
  );
}

// ------------------------------------------------------------------- banner and footer

function ProblemsBanner({
  state,
  width,
  focused,
  paddingY,
  onOpen,
}: {
  state: SettingsState;
  width: number;
  focused: boolean;
  paddingY: number;
  onOpen: () => void;
}) {
  const theme = useTheme();
  const c = theme.colors;
  const problems = state.problems;
  const error = state.file.hasSyntaxError || problems.some((p) => p.severity === "error");
  const edge = error ? c.status.error : c.status.warning;
  const count = problems.length;
  const title = state.file.hasSyntaxError
    ? "config.toml has a syntax error"
    : count === 1
      ? "1 problem in config.toml"
      : `${count} problems in config.toml`;
  const inner = Math.max(10, width - CANVAS_PADDING_X * 2 - 3);
  const shown = problems.slice(0, 3);
  // The line number leads, so truncating a long message never hides where to look.
  const details = shown.map((p) => ({
    where: p.line !== undefined ? `line ${p.line}  ` : "",
    text: sanitizeForDisplay(p.message),
  }));
  const note = state.file.saveNote ? wrapText(state.file.saveNote, inner - 2, 3) : [];
  const action = "Open config.toml";
  return (
    <box flexDirection="column" flexShrink={0} paddingX={CANVAS_PADDING_X}>
      <box flexDirection="row" backgroundColor={c.bg.raised} flexShrink={0}>
        {/* The status edge, as on toasts: absolute, so it follows the card's height. */}
        <box position="absolute" left={0} top={0} width={1} height="100%" overflow="hidden">
          <text fg={edge} selectable={false}>
            {"▎\n".repeat(16)}
          </text>
        </box>
        <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingRight={1} paddingY={paddingY}>
          <box height={1} flexDirection="row" flexShrink={0}>
            <text
              flexGrow={1}
              flexShrink={1}
              selectable={false}
              wrapMode="none"
              fg={c.fg.default}
              attributes={attrs({ bold: true })}
            >
              <span fg={edge}>{`${icon(error ? "error" : "warning", theme.icons)} `}</span>
              {truncateEnd(title, Math.max(8, inner - action.length - 4))}
            </text>
            <TextAction label={action} onPress={onOpen} focused={focused} bg={c.bg.raised} />
          </box>
          {details.map((line) => (
            <text key={`${line.where}${line.text}`} selectable={false} wrapMode="none" fg={c.fg.muted}>
              <span fg={c.fg.subtle}>{line.where}</span>
              {truncateEnd(line.text, Math.max(8, inner - 2 - line.where.length))}
            </text>
          ))}
          {count > 3 ? (
            <text selectable={false} fg={c.fg.subtle}>
              {`and ${count - 3} more`}
            </text>
          ) : null}
          {note.map((line) => (
            <text key={line} selectable={false} wrapMode="none" fg={c.fg.subtle}>
              {line}
            </text>
          ))}
        </box>
      </box>
    </box>
  );
}

function hintsFor(
  area: Area,
  state: SettingsState,
  selected: SettingItemRow | null,
  picker: PickerState | null,
  listEditor: ListEditorState | null,
): HintItem[] {
  if (area === "search")
    return [
      { keys: "↓", label: "settings" },
      { keys: "Esc", label: state.query ? "clear" : "list" },
    ];
  if (area === "banner")
    return [
      { keys: "Enter", label: "open config.toml" },
      { keys: "↓", label: "settings" },
    ];
  if (state.edit)
    return [
      { keys: "Enter", label: "save" },
      { keys: "Esc", label: "cancel" },
    ];
  if (picker) {
    return [
      { keys: "↑↓", label: picker.previewing ? "preview" : "choose" },
      { keys: "Enter", label: "apply" },
      { keys: "Esc", label: picker.previewing ? "revert" : "cancel" },
    ];
  }
  if (listEditor)
    return [
      { keys: "Enter", label: "edit" },
      { keys: "Del", label: "remove" },
      { keys: "Esc", label: "done" },
    ];
  const items: HintItem[] = [];
  switch (selected?.control.kind) {
    case "toggle":
      items.push({ keys: "Space", label: "toggle" });
      break;
    case "select":
    case "select-or-color":
    case "select-or-command":
      items.push({ keys: "Enter", label: "choose" }, { keys: "←→", label: "cycle" });
      break;
    case "number":
    case "text":
      items.push({ keys: "Enter", label: "edit" });
      break;
    case "list":
      items.push({ keys: "Enter", label: "edit list" });
      break;
    case "keybindings":
      items.push({ keys: "Enter", label: "open shortcuts" });
      break;
    default:
      break;
  }
  if (selected?.modified && selected.control.kind !== "keybindings")
    items.push({ keys: "Del", label: "reset" });
  items.push({ keys: "/", label: "search" });
  return items;
}

// ------------------------------------------------------------------------ the editor

export function SettingsEditor({ focused }: EditorViewProps) {
  const app = useApp();
  const services = useSettingsServices();
  useRendererBridge(services);
  const vm = services.settings;
  const state = useStore(vm.store);
  const theme = useTheme();
  const density = useDensity();
  const c = theme.colors;
  const { size, onSizeChange } = useMeasure();
  const list = useMeasure();
  const [area, setArea] = useState<Area>("search");
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [listEditor, setListEditor] = useState<ListEditorState | null>(null);
  const [start, setStart] = useState(0);
  const searchRef = useRef<TextFieldHandle>(null);
  useFocusTarget(searchRef, area === "search");

  const hasBanner = state.problems.length > 0 || state.file.saveNote !== null;
  const layout = layoutFor(size.width, density.sectionGap);
  const selectedRow = state.rows[state.selectedIndex];
  const selected = selectedRow?.type === "item" ? selectedRow : null;
  const listFocused = focused && area === "list";
  const editFocused = focused && area === "list" && state.edit !== null;

  // The picker and list editor belong to one setting: drop them when it is filtered away.
  useEffect(() => {
    if (picker && picker.path !== state.selectedPath) setPicker(null);
    if (listEditor && listEditor.path !== state.selectedPath) setListEditor(null);
  }, [picker, listEditor, state.selectedPath]);
  // Leaving the tab with a live preview open restores the saved value.
  useEffect(
    () => () => {
      void vm.cancelPreview();
      vm.cancelEdit();
    },
    [vm],
  );

  const openConfig = (line?: number, column?: number) => void openConfigFile(app, services, { line, column });

  const closePicker = async (apply: boolean) => {
    const current = picker;
    setPicker(null);
    if (!current) return;
    if (current.previewing) {
      if (apply) await vm.commitPreview();
      else await vm.cancelPreview();
    }
  };

  const openPicker = (row: SettingItemRow) => {
    const options = pickerOptions(row);
    const index = Math.max(
      0,
      options.findIndex((o) => !o.custom && o.value === row.value),
    );
    setPicker({ path: row.path, index, options, previewing: false });
  };

  const movePicker = async (delta: number) => {
    if (!picker) return;
    const index = Math.max(0, Math.min(picker.options.length - 1, picker.index + delta));
    const option = picker.options[index];
    const live = selected?.livePreview === true && option !== undefined && !option.custom;
    setPicker({ ...picker, index, previewing: picker.previewing || live });
    if (live && option) await vm.previewOption(picker.path, option.value);
  };

  const applyPicker = async (index = picker?.index ?? 0) => {
    if (!picker) return;
    const option = picker.options[index];
    if (!option) return;
    if (option.custom) {
      await closePicker(false);
      await vm.beginEdit(picker.path);
      return;
    }
    if (picker.previewing) {
      if (option.value !== getSetting(app.config.config, picker.path))
        await vm.previewOption(picker.path, option.value);
      setPicker(null);
      await vm.commitPreview();
      return;
    }
    setPicker(null);
    await vm.pickOption(picker.path, option.value);
  };

  const activate = async (row: SettingItemRow) => {
    setArea("list");
    vm.select(row.path);
    switch (row.control.kind) {
      case "toggle":
        await vm.toggle(row.path);
        return;
      case "select":
      case "select-or-color":
      case "select-or-command":
        openPicker(row);
        return;
      case "list":
        setListEditor({ path: row.path, index: itemEntries(row).length });
        return;
      case "keybindings":
        await app.run("keybindings.open");
        return;
      default:
        await vm.beginEdit(row.path);
    }
  };

  const listLine = async (row: SettingItemRow, index: number) => {
    setListEditor({ path: row.path, index });
    const entries = itemEntries(row);
    if (index >= entries.length) await vm.beginAddEntry(row.path);
    else vm.beginEditEntry(row.path, index);
  };

  const focusSearch = (append?: string) => {
    void closePicker(false);
    vm.cancelEdit();
    setListEditor(null);
    setArea("search");
    if (append) {
      const next = `${state.query}${append}`;
      vm.setQuery(next);
      searchRef.current?.setValue(next);
    }
  };

  const enterList = () => {
    setArea("list");
    if (!selected) vm.moveSelection(0);
  };

  const handleListKey = (stroke: KeyStroke, key: string): boolean => {
    if (state.edit) {
      if (key === "enter") {
        void vm.commitEdit().then((ok) => {
          // After adding, stay on "Add entry" so several entries can be added in a row.
          if (ok && state.edit?.kind === "list-entry" && state.edit.index === null && selected) {
            const added = itemEntries(selected).length + 1;
            setListEditor((current) => (current ? { ...current, index: added } : current));
          }
        });
        return true;
      }
      if (key === "escape") {
        vm.cancelEdit();
        return true;
      }
      return false;
    }
    if (picker) {
      if (key === "up" || key === "left") void movePicker(-1);
      else if (key === "down" || key === "right") void movePicker(1);
      else if (key === "enter" || key === "space") void applyPicker();
      else if (key === "escape") void closePicker(false);
      return true;
    }
    if (listEditor && selected) {
      const entries = itemEntries(selected);
      if (key === "up") setListEditor({ ...listEditor, index: Math.max(0, listEditor.index - 1) });
      else if (key === "down")
        setListEditor({ ...listEditor, index: Math.min(entries.length, listEditor.index + 1) });
      else if (key === "enter") void listLine(selected, listEditor.index);
      else if ((key === "delete" || key === "backspace") && listEditor.index < entries.length) {
        void vm.removeEntry(selected.path, listEditor.index);
      } else if (key === "escape") setListEditor(null);
      return true;
    }
    switch (key) {
      case "up":
        if (state.rows.findIndex((r) => r.type === "item") === state.selectedIndex)
          setArea(hasBanner ? "banner" : "search");
        else vm.moveSelection(-1);
        return true;
      case "down":
        vm.moveSelection(1);
        return true;
      case "pageup":
        vm.moveSelection(-5);
        return true;
      case "pagedown":
        vm.moveSelection(5);
        return true;
      case "home":
        vm.moveSelection(-10_000);
        return true;
      case "end":
        vm.moveSelection(10_000);
        return true;
      case "enter":
        if (selected) void activate(selected);
        return true;
      case "space":
        if (selected?.control.kind === "toggle") void vm.toggle(selected.path);
        else if (selected) void activate(selected);
        return true;
      case "left":
      case "right":
        if (!selected) return true;
        if (selected.control.kind === "toggle") {
          if ((key === "right") !== (selected.value === true)) void vm.toggle(selected.path);
        } else if (pickerOptions(selected).length > 0) {
          void vm.cycleOption(selected.path, key === "right" ? 1 : -1);
        }
        return true;
      case "delete":
      case "backspace":
        if (selected?.modified && selected.control.kind !== "keybindings") void vm.reset(selected.path);
        return true;
      case "escape":
        focusSearch();
        return true;
      case "/":
        focusSearch();
        return true;
      default:
        if (isTypingStroke(stroke) && stroke.key.length > 0) {
          focusSearch(stroke.text ?? stroke.key);
          return true;
        }
        return false;
    }
  };

  useKeyHandler(
    (stroke) => {
      const key = normalizeKey(stroke.key) ?? stroke.key;
      if (stroke.ctrl || stroke.alt || stroke.super) return false;
      if (area === "search") {
        if (key === "down" || key === "enter" || key === "tab") {
          if (hasBanner) setArea("banner");
          else enterList();
          return true;
        }
        if (key === "escape") {
          if (state.query) {
            vm.setQuery("");
            searchRef.current?.setValue("");
          } else enterList();
          return true;
        }
        return false;
      }
      if (area === "banner") {
        if (key === "up" || (key === "tab" && stroke.shift)) setArea("search");
        else if (key === "down" || key === "tab" || key === "escape") enterList();
        else if (key === "enter" || key === "space")
          openConfig(state.problems[0]?.line, state.problems[0]?.column);
        else if (key === "/") focusSearch();
        return true;
      }
      if (state.message) vm.dismissMessage();
      return handleListKey(stroke, key);
    },
    { enabled: focused, whileInputFocused: true },
  );

  // --------------------------------------------------------------- windowing
  const blocks = state.rows.map((row) => ({
    row,
    height: row.type === "header" ? 1 : itemHeight(row, layout, state, picker, listEditor),
  }));
  const footerHints = hintsFor(area, state, selected, picker, listEditor);
  const footerWidth = Math.max(10, size.width - CANVAS_PADDING_X * 2);
  const promise = wrapText(PROMISE, footerWidth, 2);
  const viewport = Math.max(3, list.size.height);
  const selectedBlock = state.selectedIndex;
  let first = Math.max(0, Math.min(start, blocks.length - 1));
  if (selectedBlock >= 0 && list.size.height > 0) {
    // Keep the category header with its first item.
    const headerBefore =
      selectedBlock > 0 && blocks[selectedBlock - 1]?.row.type === "header"
        ? selectedBlock - 1
        : selectedBlock;
    if (headerBefore < first) first = headerBefore;
    let used = 0;
    for (let i = first; i <= selectedBlock; i++) used += blocks[i]?.height ?? 0;
    while (used > viewport && first < selectedBlock) {
      used -= blocks[first]?.height ?? 0;
      first++;
    }
  }
  useEffect(() => {
    // Before the first layout the list has no height; scrolling then would hide the top.
    if (list.size.height > 0 && first !== start) setStart(first);
  });
  const visible: { row: SettingsRow; index: number }[] = [];
  let filled = 0;
  for (let i = first; i < blocks.length && filled < viewport; i++) {
    const block = blocks[i];
    if (!block) break;
    visible.push({ row: block.row, index: i });
    filled += block.height;
  }

  const countLabel = state.query
    ? `${state.rows.filter((r) => r.type === "item").length} found`
    : `${state.rows.filter((r) => r.type === "item").length} settings`;

  return (
    <box
      flexGrow={1}
      flexDirection="column"
      backgroundColor={c.bg.base}
      onSizeChange={onSizeChange}
      onMouseScroll={(event) => {
        const direction = event.scroll?.direction;
        if (direction === "down") setStart(Math.min(blocks.length - 1, first + 2));
        if (direction === "up") setStart(Math.max(0, first - 2));
      }}
    >
      <box height={1} flexShrink={0} />
      <SearchRow
        fieldRef={searchRef}
        placeholder="Search settings by name, description or key"
        value={state.query}
        focused={focused && area === "search"}
        count={countLabel}
        onInput={(value) => vm.setQuery(value)}
        onFocusRequest={() => focusSearch()}
      />
      <box height={1} flexShrink={0} />
      {hasBanner ? (
        <>
          <ProblemsBanner
            state={state}
            width={size.width}
            focused={focused && area === "banner"}
            paddingY={density.overlayPaddingY}
            onOpen={() => openConfig(state.problems[0]?.line, state.problems[0]?.column)}
          />
          <box height={1} flexShrink={0} />
        </>
      ) : null}
      <box
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        flexDirection="column"
        overflow="hidden"
        onSizeChange={list.onSizeChange}
      >
        {visible.length === 0 ? (
          <box paddingX={CANVAS_PADDING_X} flexShrink={0}>
            <text fg={c.fg.muted} selectable={false}>
              {`No settings match "${sanitizeForDisplay(state.query)}".`}
            </text>
          </box>
        ) : null}
        {visible.map(({ row, index }) =>
          row.type === "header" ? (
            <box key={`h-${row.category}`} height={1} flexShrink={0} paddingLeft={CANVAS_PADDING_X}>
              <text fg={c.fg.muted} selectable={false} attributes={attrs({ bold: true })}>
                {row.category.toUpperCase()}
                <span fg={c.fg.subtle} attributes={0}>{`  ${row.count}`}</span>
              </text>
            </box>
          ) : (
            <SettingItem
              key={row.path}
              row={row}
              layout={layout}
              selected={index === state.selectedIndex}
              listFocused={listFocused}
              state={state}
              picker={picker}
              listEditor={listEditor}
              editFocused={editFocused}
              onSelect={() => {
                vm.select(row.path);
                setArea("list");
              }}
              onActivate={() => void activate(row)}
              onReset={() => void vm.reset(row.path)}
              onPick={(optionIndex) => void applyPicker(optionIndex)}
              onListLine={(entryIndex) => void listLine(row, entryIndex)}
              onRemoveEntry={(entryIndex) => void vm.removeEntry(row.path, entryIndex)}
              onDraft={(value) => vm.updateEdit(value)}
            />
          ),
        )}
      </box>
      <box flexDirection="column" flexShrink={0} paddingX={CANVAS_PADDING_X}>
        {state.message ? (
          <text
            selectable={false}
            wrapMode="none"
            fg={
              state.message.severity === "error"
                ? c.status.error
                : state.message.severity === "warning"
                  ? c.status.warning
                  : state.message.severity === "success"
                    ? c.status.success
                    : c.fg.muted
            }
          >
            {truncateEnd(state.message.text, Math.max(10, size.width - CANVAS_PADDING_X * 2))}
          </text>
        ) : null}
        <box height={1} flexShrink={0} />
        <HintLine items={footerHints} />
        <text selectable={false} wrapMode="none" fg={c.fg.subtle}>
          {"Saved in "}
          <span fg={c.fg.muted}>{truncateMiddle(state.file.displayPath, Math.max(8, footerWidth - 9))}</span>
        </text>
        {promise.map((line) => (
          <text key={line} selectable={false} wrapMode="none" fg={c.fg.subtle}>
            {line}
          </text>
        ))}
      </box>
    </box>
  );
}
