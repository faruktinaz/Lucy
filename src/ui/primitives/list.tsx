/**
 * A virtualized list. Only the visible window is mounted, with rows keyed by SLOT index, so
 * scrolling and moving the selection only update props (measured in OPENTUI_NOTES §2:
 * 0.14 ms per selection move with a 30-row window, regardless of the item count).
 *
 * Row states: default, hovered (`state.hover`), selected in a focused list
 * (`state.selectedBg` + `state.selectedFg`), selected in an unfocused list
 * (`state.selectedInactiveBg`). In the High Contrast theme the selected row also gets a
 * marker, so selection never relies on color alone.
 *
 * Keyboard (while the list's zone is focused): Up/Down or k/j, Home/End, PageUp/PageDown,
 * Enter activates. Mouse: click selects, double-click activates, right-click opens
 * `onContextMenu`, the wheel scrolls.
 */
import type { MouseEvent, RGBA } from "@opentui/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useKeyHandler, useOptionalApp } from "@/app/react";
import { normalizeKey } from "@/core/keybindings";
import { useDensity, useTheme } from "../theme/theme-context";
import type { UiTheme } from "../theme/ui-theme";
import { useMeasure } from "./measure";
import { Scrollbar } from "./scrollbar";
import { CapCell } from "./shape";
import { type PointerProps, usePointer } from "./use-pointer";

export interface ListRowState {
  readonly index: number;
  readonly selected: boolean;
  /** Selected in a list that has focus: draw text in `selectedFg`. */
  readonly active: boolean;
  readonly hovered: boolean;
  /** Content width of the row in cells (excluding padding). */
  readonly width: number;
}

export interface ListProps<T> {
  items: readonly T[];
  selectedIndex: number;
  /** The list has keyboard focus (selection uses the active color). */
  focused: boolean;
  onSelect?: (index: number) => void;
  /** Enter, double-click, or a single click with `activateOnClick`. */
  onActivate?: (index: number, source: "keyboard" | "pointer") => void;
  onContextMenu?: (index: number, event: MouseEvent) => void;
  /** Contents of one row, laid out in a horizontal box. */
  renderRow: (item: T, state: ListRowState) => ReactNode;
  /** Register keyboard navigation for the zone. Default true. */
  keyboard?: boolean;
  scrollbar?: boolean;
  activateOnClick?: boolean;
  /** Rows scrolled per wheel notch. Default 2. */
  wheelStep?: number;
  /** Background of rows that are neither selected nor hovered. */
  surface?: RGBA;
}

/** Background of a row in a state. Exported for the gallery and tests. */
export function rowBackground(
  theme: UiTheme,
  state: { selected: boolean; focused: boolean; hovered: boolean },
  surface?: RGBA,
): RGBA | undefined {
  const c = theme.colors.state;
  if (state.selected) return state.focused ? c.selectedBg : c.selectedInactiveBg;
  if (state.hovered) return c.hover;
  return surface;
}

/** Keeps `index` visible in a window of `height` rows starting at `top`. */
export function scrollToReveal(top: number, height: number, index: number, count: number): number {
  const maxTop = Math.max(0, count - height);
  let next = top;
  if (index < next) next = index;
  else if (index >= next + height) next = index - height + 1;
  return Math.max(0, Math.min(maxTop, next));
}

function ListRow({
  index,
  exists,
  selected,
  focused,
  surface,
  paddingX,
  width,
  onSelect,
  onActivate,
  onContextMenu,
  activateOnClick,
  children,
}: {
  slot: number;
  index: number;
  exists: boolean;
  selected: boolean;
  focused: boolean;
  surface?: RGBA;
  paddingX: number;
  width: number;
  onSelect?: (index: number) => void;
  onActivate?: (index: number, source: "keyboard" | "pointer") => void;
  onContextMenu?: (index: number, event: MouseEvent) => void;
  activateOnClick: boolean;
  children: (hovered: boolean) => ReactNode;
}) {
  const theme = useTheme();
  const pointer = usePointer({
    disabled: !exists,
    onClick: () => {
      onSelect?.(index);
      if (activateOnClick) onActivate?.(index, "pointer");
    },
    onDoubleClick: () => {
      if (!activateOnClick) onActivate?.(index, "pointer");
    },
    onContextMenu: (event) => {
      onSelect?.(index);
      onContextMenu?.(index, event);
    },
  });
  const hovered = exists && pointer.hovered;
  const fill = exists ? rowBackground(theme, { selected, focused, hovered }) : undefined;
  return (
    <RowFrame
      fill={fill}
      marker={theme.highContrast && selected && exists}
      focused={focused}
      surface={surface}
      paddingX={paddingX}
      width={width}
      pointer={pointer.props}
    >
      {exists ? children(hovered) : null}
    </RowFrame>
  );
}

/**
 * The shape of a list row: the highlight is a pill inset from the card edge (margin, cap,
 * content, cap, margin). Exported for rows that are not inside a `List` (the gallery,
 * section headers in custom lists).
 */
export function RowFrame({
  fill,
  marker = false,
  focused = true,
  surface,
  paddingX = 1,
  width,
  pointer,
  children,
}: {
  fill: RGBA | undefined;
  /** High Contrast: a bar in the first cell, so selection never relies on color alone. */
  marker?: boolean;
  focused?: boolean;
  surface?: RGBA;
  paddingX?: number;
  width?: number;
  pointer?: Partial<PointerProps>;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <box height={1} flexShrink={0} flexDirection="row" backgroundColor={surface} width={width} {...pointer}>
      <box width={paddingX} height={1} flexShrink={0} />
      {marker ? (
        <text
          width={1}
          fg={focused ? theme.colors.accent.primary : theme.colors.fg.muted}
          bg={fill}
          selectable={false}
          flexShrink={0}
        >
          ▌
        </text>
      ) : (
        <CapCell side="left" color={fill} />
      )}
      <box flexGrow={1} height={1} flexDirection="row" backgroundColor={fill} minWidth={0}>
        {children}
      </box>
      <CapCell side="right" color={fill} />
      <box width={paddingX} height={1} flexShrink={0} />
    </box>
  );
}

export function List<T>({
  items,
  selectedIndex,
  focused,
  onSelect,
  onActivate,
  onContextMenu,
  renderRow,
  keyboard = true,
  scrollbar = true,
  activateOnClick = false,
  wheelStep = 2,
  surface,
}: ListProps<T>) {
  const density = useDensity();
  const app = useOptionalApp();
  const { size, onSizeChange } = useMeasure();
  const height = Math.max(0, size.height);
  const count = items.length;
  const [top, setTop] = useState(0);
  const lastSelected = useRef(selectedIndex);

  // Follow the selection, but let the wheel scroll away from it.
  let effectiveTop = Math.max(0, Math.min(top, Math.max(0, count - height)));
  if (lastSelected.current !== selectedIndex && selectedIndex >= 0) {
    effectiveTop = scrollToReveal(effectiveTop, height, selectedIndex, count);
  }
  useEffect(() => {
    lastSelected.current = selectedIndex;
    if (effectiveTop !== top) setTop(effectiveTop);
  });

  const select = (index: number) => {
    if (count === 0) return;
    onSelect?.(Math.max(0, Math.min(count - 1, index)));
  };

  useKeyHandler(
    (stroke) => {
      if (stroke.ctrl || stroke.alt || stroke.super) return false;
      const key = normalizeKey(stroke.key) ?? stroke.key;
      const page = Math.max(1, height - 1);
      switch (key) {
        case "down":
        case "j":
          select(selectedIndex + 1);
          return true;
        case "up":
        case "k":
          select(selectedIndex - 1);
          return true;
        case "home":
          select(0);
          return true;
        case "end":
          select(count - 1);
          return true;
        case "pagedown":
          select(selectedIndex + page);
          return true;
        case "pageup":
          select(selectedIndex - page);
          return true;
        case "enter":
          if (selectedIndex >= 0 && selectedIndex < count) onActivate?.(selectedIndex, "keyboard");
          return selectedIndex >= 0 && selectedIndex < count;
        default:
          return false;
      }
    },
    { enabled: keyboard && app !== null },
  );

  const rows: ReactNode[] = [];
  // Margin and cap on each side of a row (see ListRow).
  const contentWidth = Math.max(0, size.width - (density.rowPaddingX + 1) * 2);
  for (let slot = 0; slot < height; slot++) {
    const index = effectiveTop + slot;
    const item = items[index];
    const exists = index < count && item !== undefined;
    const selected = exists && index === selectedIndex;
    rows.push(
      <ListRow
        key={slot}
        slot={slot}
        index={index}
        exists={exists}
        selected={selected}
        focused={focused}
        surface={surface}
        paddingX={density.rowPaddingX}
        width={size.width}
        onSelect={onSelect}
        onActivate={onActivate}
        onContextMenu={onContextMenu}
        activateOnClick={activateOnClick}
      >
        {(hovered) =>
          exists
            ? renderRow(item, { index, selected, active: selected && focused, hovered, width: contentWidth })
            : null
        }
      </ListRow>,
    );
  }

  return (
    <box
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      flexDirection="column"
      overflow="hidden"
      onSizeChange={onSizeChange}
      onMouseScroll={(event) => {
        const direction = event.scroll?.direction;
        if (direction !== "up" && direction !== "down") return;
        const delta = (direction === "down" ? 1 : -1) * wheelStep;
        setTop((current) => Math.max(0, Math.min(Math.max(0, count - height), current + delta)));
        lastSelected.current = selectedIndex;
      }}
    >
      {rows}
      {scrollbar ? <Scrollbar total={count} visible={height} offset={effectiveTop} height={height} /> : null}
    </box>
  );
}
