/**
 * The Keyboard Shortcuts editor tab: every command grouped by category, with its shortcuts as
 * key caps, their source (yours or built in), the context they apply in, and warnings for
 * shortcuts this terminal cannot deliver or that collide with another command.
 *
 * Each row has slots: one per shortcut, then "Add", then "Reset" when you changed the
 * command. Left/Right choose a slot; Enter changes the shortcut (or adds one, or resets);
 * Delete removes the chosen shortcut. Changing or adding opens the capture card.
 */
import { useEffect, useRef, useState } from "react";
import { useApp, useFocusTarget, useKeyHandler, useStore } from "@/app/react";
import type { EditorViewProps } from "@/app/workbench/views";
import { normalizeKey } from "@/core/keybindings";
import { isTypingStroke } from "@/core/keybindings/key-stroke";
import { displayWidth, sanitizeForDisplay, truncateEnd } from "@/core/text";
import { icon } from "@/themes/icons";
import { List, type ListRowState } from "@/ui/primitives/list";
import { useMeasure } from "@/ui/primitives/measure";
import { attrs } from "@/ui/primitives/text";
import type { TextFieldHandle } from "@/ui/primitives/text-field";
import { usePointer } from "@/ui/primitives/use-pointer";
import { useTheme } from "@/ui/theme/theme-context";
import type { BindingView, CommandRow, KeybindingsRow } from "../model/keybindings-view-model";
import { openCaptureOverlay } from "./capture-overlay";
import {
  CANVAS_PADDING_X,
  type HintItem,
  HintLine,
  SearchRow,
  useRendererBridge,
  useSettingsServices,
} from "./shared";
import { fitWidth, wrapText } from "./text-layout";

type Area = "search" | "list";

type Slot = { kind: "binding"; binding: BindingView } | { kind: "add" } | { kind: "reset" };

function slotsOf(row: CommandRow): Slot[] {
  const slots: Slot[] = row.bindings.map((binding) => ({ kind: "binding", binding }));
  slots.push({ kind: "add" });
  if (row.modified) slots.push({ kind: "reset" });
  return slots;
}

interface Columns {
  readonly title: number;
  readonly keys: number;
  readonly when: number;
}

function columnsFor(width: number): Columns {
  const when = width >= 92 ? 20 : 0;
  const title = Math.max(16, Math.min(36, Math.round(width * 0.34)));
  return { title, when, keys: Math.max(10, width - title - when - (when > 0 ? 2 : 0) - 2) };
}

function SlotChip({ slot, selected, onPress }: { slot: Slot; selected: boolean; onPress: () => void }) {
  const theme = useTheme();
  const c = theme.colors;
  const pointer = usePointer({ onClick: onPress });
  const hovered = pointer.hovered && !selected;
  if (slot.kind === "add") {
    return (
      <box height={1} flexShrink={0} {...pointer.props}>
        <text selectable={false}>
          <span
            fg={selected ? c.fg.onAccent : hovered ? c.fg.default : c.fg.subtle}
            bg={selected ? c.accent.primary : hovered ? c.state.hover : c.bg.raised}
          >
            {` ${icon("add", theme.icons)} `}
          </span>
        </text>
      </box>
    );
  }
  if (slot.kind === "reset") {
    return (
      <box height={1} flexShrink={0} {...pointer.props}>
        <text selectable={false}>
          <span
            fg={selected ? c.fg.onAccent : hovered ? c.fg.default : c.accent.primary}
            bg={selected ? c.accent.primary : hovered ? c.state.hover : undefined}
          >
            {" Reset "}
          </span>
        </text>
      </box>
    );
  }
  const binding = slot.binding;
  const problem = binding.conflicts.length > 0 ? "conflict" : binding.warning ? "warning" : null;
  return (
    <box height={1} flexShrink={0} {...pointer.props}>
      <text selectable={false} wrapMode="none">
        <span
          fg={selected ? c.fg.onAccent : binding.source === "user" ? c.accent.primary : c.fg.default}
          bg={selected ? c.accent.primary : hovered ? c.state.hover : c.bg.raised}
          attributes={attrs({ bold: selected })}
        >
          {` ${binding.label} `}
        </span>
        {problem ? (
          <span fg={problem === "conflict" ? c.status.error : c.status.warning}>
            {icon("warning", theme.icons)}
          </span>
        ) : null}
      </text>
    </box>
  );
}

function CommandRowView({
  row,
  state,
  columns,
  slot,
  onSlot,
}: {
  row: CommandRow;
  state: ListRowState;
  columns: Columns;
  slot: number;
  onSlot: (index: number) => void;
}) {
  const theme = useTheme();
  const c = theme.colors;
  const slots = slotsOf(row);
  const showSlots = state.selected;
  const titleColor = state.active ? c.state.selectedFg : row.registered ? c.fg.default : c.fg.muted;
  // One cell of air between the title and the first key cap.
  const title = fitWidth(truncateEnd(sanitizeForDisplay(row.title), columns.title - 3), columns.title - 2);
  const visibleSlots = showSlots ? slots : slots.filter((s) => s.kind === "binding");
  return (
    <>
      <text width={2} flexShrink={0} selectable={false} fg={c.accent.primary}>
        {row.modified ? "▎ " : "  "}
      </text>
      <text width={columns.title - 2} flexShrink={0} selectable={false} wrapMode="none" fg={titleColor}>
        {title}
      </text>
      <box width={columns.keys} flexShrink={0} flexDirection="row" gap={1} overflow="hidden">
        {visibleSlots.length === 0 ? (
          <text selectable={false} fg={c.fg.subtle}>
            {row.registered ? "No shortcut" : "Not available yet"}
          </text>
        ) : (
          visibleSlots.map((item, index) => (
            <SlotChip
              key={item.kind === "binding" ? item.binding.key : item.kind}
              slot={item}
              selected={state.active && index === slot}
              onPress={() => onSlot(index)}
            />
          ))
        )}
      </box>
      {columns.when > 0 ? (
        <text width={columns.when} flexShrink={0} selectable={false} wrapMode="none" fg={c.fg.subtle}>
          {`  ${truncateEnd(row.bindings[0]?.when ?? "", columns.when - 2)}`}
        </text>
      ) : null}
    </>
  );
}

function HeaderRowView({ category, count }: { category: string; count: number }) {
  const theme = useTheme();
  const c = theme.colors;
  return (
    <text selectable={false} fg={c.fg.muted} attributes={attrs({ bold: true })}>
      {category.toUpperCase()}
      <span fg={c.fg.subtle} attributes={0}>{`  ${count}`}</span>
    </text>
  );
}

function DetailPanel({
  row,
  slot,
  width,
}: {
  row: CommandRow | null;
  slot: Slot | undefined;
  width: number;
}) {
  const theme = useTheme();
  const c = theme.colors;
  if (!row) return null;
  const inner = Math.max(10, width - CANVAS_PADDING_X * 2);
  const binding = slot?.kind === "binding" ? slot.binding : row.bindings[0];
  const facts: string[] = [];
  if (binding?.when) facts.push(`when ${binding.when}`);
  if (binding?.global) facts.push("also works while a terminal has focus");
  if (row.modified) facts.push(row.bindings.length === 0 ? "you removed its shortcuts" : "changed by you");
  if (row.modified && row.defaultLabels.length > 0) facts.push(`default ${row.defaultLabels.join(", ")}`);
  const problems = binding ? [...binding.conflicts, ...(binding.warning ? [binding.warning] : [])] : [];
  const problemLines = problems.flatMap((text) => wrapText(text, inner - 2, 2)).slice(0, 2);
  return (
    <box flexDirection="column" flexShrink={0} paddingX={CANVAS_PADDING_X}>
      <text selectable={false} wrapMode="none">
        <span fg={c.fg.default}>
          {truncateEnd(sanitizeForDisplay(row.title), Math.max(8, inner - row.id.length - 2))}
        </span>
        <span fg={c.fg.subtle}>{`  ${row.id}`}</span>
      </text>
      <text selectable={false} wrapMode="none" fg={c.fg.subtle}>
        {truncateEnd(
          facts.length > 0
            ? facts.join("  ·  ")
            : row.registered
              ? "Built-in shortcut"
              : "This command is not available yet",
          inner,
        )}
      </text>
      {problemLines.map((line, index) => (
        <text
          key={`${line}-${index === 0 ? "first" : "rest"}`}
          selectable={false}
          wrapMode="none"
          fg={binding && binding.conflicts.length > 0 ? c.status.error : c.status.warning}
        >
          {index === 0 ? `${icon("warning", theme.icons)} ${line}` : `  ${line}`}
        </text>
      ))}
    </box>
  );
}

export function KeybindingsEditor({ focused }: EditorViewProps) {
  const app = useApp();
  const services = useSettingsServices();
  useRendererBridge(services);
  const vm = services.keybindings();
  const state = useStore(vm.store);
  const theme = useTheme();
  const c = theme.colors;
  const { size, onSizeChange } = useMeasure();
  const [area, setArea] = useState<Area>("search");
  const [slot, setSlot] = useState(0);
  const searchRef = useRef<TextFieldHandle>(null);
  useFocusTarget(searchRef, area === "search");

  // Capabilities may arrive after startup; refresh the terminal warnings when shown.
  useEffect(() => {
    vm.setSupport(services.support());
  }, [vm, services]);

  const selectedRow = state.rows[state.selectedIndex];
  const selected = selectedRow?.type === "command" ? selectedRow : null;
  const slots = selected ? slotsOf(selected) : [];
  const slotIndex = Math.min(slot, Math.max(0, slots.length - 1));
  // A new row starts on its first shortcut (or on Add when it has none).
  const lastCommand = useRef(state.selectedCommand);
  useEffect(() => {
    if (lastCommand.current !== state.selectedCommand) {
      lastCommand.current = state.selectedCommand;
      setSlot(0);
    }
  });

  const capture = async (command: string, replace?: string) => {
    await openCaptureOverlay(app, vm, command, replace);
  };

  const activateSlot = async (row: CommandRow, index: number) => {
    const target = slotsOf(row)[index];
    if (!target) return;
    if (target.kind === "binding") await capture(row.id, target.binding.key);
    else if (target.kind === "add") await capture(row.id);
    else {
      await vm.resetToDefault(row.id);
      setSlot(0);
    }
  };

  const focusSearch = (append?: string) => {
    setArea("search");
    if (append) {
      const next = `${state.query}${append}`;
      vm.setQuery(next);
      searchRef.current?.setValue(next);
    }
  };

  useKeyHandler(
    (stroke) => {
      if (stroke.ctrl || stroke.alt || stroke.super) return false;
      const key = normalizeKey(stroke.key) ?? stroke.key;
      if (area === "search") {
        if (key === "down" || key === "enter" || key === "tab") {
          setArea("list");
          return true;
        }
        if (key === "escape") {
          if (state.query) {
            vm.setQuery("");
            searchRef.current?.setValue("");
          } else setArea("list");
          return true;
        }
        return false;
      }
      switch (key) {
        case "up": {
          const first = state.rows.findIndex((r) => r.type === "command");
          if (state.selectedIndex <= first) setArea("search");
          else vm.moveSelection(-1);
          return true;
        }
        case "down":
          vm.moveSelection(1);
          return true;
        case "pageup":
          vm.moveSelection(-10);
          return true;
        case "pagedown":
          vm.moveSelection(10);
          return true;
        case "home":
          vm.moveSelection(-100_000);
          return true;
        case "end":
          vm.moveSelection(100_000);
          return true;
        case "left":
          setSlot(Math.max(0, slotIndex - 1));
          return true;
        case "right":
          setSlot(Math.min(slots.length - 1, slotIndex + 1));
          return true;
        case "enter":
        case "space":
          if (selected) void activateSlot(selected, slotIndex);
          return true;
        case "plus":
        case "insert":
          if (selected) void capture(selected.id);
          return true;
        case "delete":
        case "backspace": {
          const target = slots[slotIndex];
          if (selected && target?.kind === "binding") void vm.removeBinding(selected.id, target.binding.key);
          return true;
        }
        case "escape":
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
    },
    { enabled: focused, whileInputFocused: true },
  );

  const contentWidth = Math.max(20, size.width - CANVAS_PADDING_X * 2);
  const columns = columnsFor(contentWidth);
  const commandCount = state.rows.filter((r) => r.type === "command").length;
  const userCount = state.rows.filter((r) => r.type === "command" && r.modified).length;
  const countLabel = state.query
    ? `${commandCount} found`
    : userCount > 0
      ? `${commandCount} commands · ${userCount} changed`
      : `${commandCount} commands`;
  const hints: HintItem[] =
    area === "search"
      ? [
          { keys: "↓", label: "shortcuts" },
          { keys: "Esc", label: state.query ? "clear" : "list" },
        ]
      : [
          {
            keys: "Enter",
            label:
              slots[slotIndex]?.kind === "binding"
                ? "change"
                : slots[slotIndex]?.kind === "reset"
                  ? "reset"
                  : "add",
          },
          { keys: "←→", label: "choose" },
          ...(slots[slotIndex]?.kind === "binding" ? [{ keys: "Del", label: "remove" }] : []),
          { keys: "+", label: "add" },
          { keys: "/", label: "search" },
        ];
  const message = state.message;

  return (
    <box flexGrow={1} flexDirection="column" backgroundColor={c.bg.base} onSizeChange={onSizeChange}>
      <box height={1} flexShrink={0} />
      <SearchRow
        fieldRef={searchRef}
        placeholder="Search by command, id or key, e.g. ctrl+k"
        value={state.query}
        focused={focused && area === "search"}
        count={countLabel}
        onInput={(value) => vm.setQuery(value)}
        onFocusRequest={() => focusSearch()}
      />
      <box height={1} flexShrink={0} />
      <box height={1} flexShrink={0} flexDirection="row" paddingX={CANVAS_PADDING_X}>
        <text selectable={false} wrapMode="none" fg={c.fg.subtle}>
          {fitWidth("  Command", columns.title)}
          {fitWidth("Shortcuts", columns.keys)}
          {columns.when > 0 ? `  ${fitWidth("When", columns.when - 2)}` : ""}
        </text>
      </box>
      <box
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        flexDirection="column"
        paddingLeft={CANVAS_PADDING_X - 1}
        paddingRight={CANVAS_PADDING_X - 1}
      >
        {state.rows.length === 0 ? (
          <box paddingX={1} flexShrink={0}>
            <text fg={c.fg.muted} selectable={false}>
              {`No command or shortcut matches "${sanitizeForDisplay(state.query)}".`}
            </text>
          </box>
        ) : (
          <List<KeybindingsRow>
            items={state.rows}
            selectedIndex={state.selectedIndex}
            focused={focused && area === "list"}
            keyboard={false}
            onSelect={(index) => {
              const row = state.rows[index];
              if (row?.type === "command") {
                vm.select(row.id);
                setArea("list");
              }
            }}
            onActivate={(index) => {
              const row = state.rows[index];
              if (row?.type === "command") void activateSlot(row, slotIndex);
            }}
            renderRow={(row, rowState) =>
              row.type === "category" ? (
                <HeaderRowView category={row.category} count={row.count} />
              ) : (
                <CommandRowView
                  row={row}
                  state={rowState}
                  columns={columns}
                  slot={slotIndex}
                  onSlot={(index) => {
                    vm.select(row.id);
                    setArea("list");
                    setSlot(index);
                    void activateSlot(row, index);
                  }}
                />
              )
            }
          />
        )}
      </box>
      <box height={1} flexShrink={0} />
      <DetailPanel row={selected} slot={slots[slotIndex]} width={size.width} />
      <box flexDirection="column" flexShrink={0} paddingX={CANVAS_PADDING_X}>
        {message ? (
          <text
            selectable={false}
            wrapMode="none"
            fg={
              message.severity === "error"
                ? c.status.error
                : message.severity === "success"
                  ? c.status.success
                  : c.fg.muted
            }
          >
            {truncateEnd(message.text, contentWidth)}
          </text>
        ) : null}
        <box height={1} flexShrink={0} />
        <HintLine items={hints} />
        {displayWidth(state.query) > 0 || state.problems.length === 0 ? null : (
          <text selectable={false} wrapMode="none" fg={c.status.warning}>
            {truncateEnd(`${icon("warning", theme.icons)} ${state.problems[0]?.message ?? ""}`, contentWidth)}
          </text>
        )}
      </box>
    </box>
  );
}
