/**
 * The context menu: a floating list at the pointer with keybinding hints, keyboard
 * navigable (handled by `MenuService`). It flips left/up when it would leave the screen.
 */
import { useApp, useStore } from "@/app/react";
import { isActionItem, type MenuItem } from "@/app/workbench/menus";
import { displayWidth } from "@/core/text";
import { Icon } from "../primitives/icon";
import { formatKeys } from "../primitives/key-hint";
import { CapCell } from "../primitives/shape";
import { usePointer } from "../primitives/use-pointer";
import { useTheme } from "../theme/theme-context";
import { SIZE } from "../tokens/spacing";
import { OverlayFrame } from "./overlay-frame";

/** Whether a menu has toggle items, which reserves a check-mark column for every item. */
function hasCheckColumn(items: readonly MenuItem[]): boolean {
  return items.some((item) => isActionItem(item) && item.checked !== undefined);
}

function MenuRow({
  item,
  index,
  active,
  width,
  keys,
  checkColumn = false,
  onChoose,
  onHover,
}: {
  item: MenuItem;
  index: number;
  active: boolean;
  width: number;
  keys: string;
  checkColumn?: boolean;
  onChoose?: (index: number) => void;
  onHover?: (index: number) => void;
}) {
  const theme = useTheme();
  const c = theme.colors;
  const action = isActionItem(item) ? item : null;
  const pointer = usePointer({
    disabled: !action || action.disabled,
    onClick: () => onChoose?.(index),
    onHoverChange: (hovered) => {
      if (hovered && action && !action.disabled) onHover?.(index);
    },
  });
  if (!action) {
    return (
      <text height={1} fg={c.border.subtle} selectable={false} flexShrink={0}>
        {"─".repeat(width)}
      </text>
    );
  }
  const fg = action.disabled
    ? c.fg.disabled
    : active
      ? c.state.selectedFg
      : action.danger
        ? c.status.error
        : c.fg.default;
  return (
    // The highlighted item is a pill: caps take the place of the row's padding cells.
    <box height={1} flexShrink={0} flexDirection="row" {...pointer.props}>
      <CapCell side="left" color={active ? c.state.selectedBg : undefined} />
      <box
        flexGrow={1}
        height={1}
        flexDirection="row"
        backgroundColor={active ? c.state.selectedBg : undefined}
      >
        <text flexGrow={1} fg={fg} selectable={false}>
          {checkColumn ? (
            action.checked ? (
              <Icon name="check" color={action.disabled ? c.fg.disabled : c.accent.primary} />
            ) : (
              "  "
            )
          ) : null}
          {action.icon ? (
            <Icon name={action.icon} color={action.disabled ? c.fg.disabled : c.fg.subtle} />
          ) : null}
          {action.label}
        </text>
        {keys ? (
          <text flexShrink={0} fg={active ? c.fg.muted : c.fg.subtle} selectable={false}>
            {`  ${keys}`}
          </text>
        ) : null}
      </box>
      <CapCell side="right" color={active ? c.state.selectedBg : undefined} />
    </box>
  );
}

/** Width of a menu for its items (keybinding labels included). */
export function menuWidth(items: readonly MenuItem[], keysFor: (item: MenuItem) => string): number {
  const labels = items.map((item) => {
    if (!isActionItem(item)) return 0;
    const keys = keysFor(item);
    return displayWidth(item.label) + (item.icon ? 2 : 0) + (keys ? displayWidth(keys) + 2 : 0);
  });
  if (hasCheckColumn(items)) return Math.max(SIZE.menuMinWidth, ...labels.map((w) => w + 4)) + 2;
  return Math.max(SIZE.menuMinWidth, ...labels.map((w) => w + 2)) + 2;
}

/** The menu's box. Presentational: the overlay and the component gallery both use it. */
export function MenuPanel({
  items,
  activeIndex,
  width,
  keysFor,
  onChoose,
  onHover,
}: {
  items: readonly MenuItem[];
  activeIndex: number;
  width: number;
  keysFor: (item: MenuItem) => string;
  onChoose?: (index: number) => void;
  onHover?: (index: number) => void;
}) {
  const checkColumn = hasCheckColumn(items);
  return (
    <OverlayFrame width={width} height={items.length + 2}>
      {items.map((item, index) => (
        <MenuRow
          key={item.id}
          item={item}
          index={index}
          active={index === activeIndex}
          width={width - 2}
          keys={keysFor(item)}
          checkColumn={checkColumn}
          onChoose={onChoose}
          onHover={onHover}
        />
      ))}
    </OverlayFrame>
  );
}

export function MenuOverlay({ width: screenWidth, height: screenHeight }: { width: number; height: number }) {
  const app = useApp();
  const state = useStore(app.menus.store);
  if (!state.open) return null;
  const keysFor = (item: MenuItem): string => {
    if (!isActionItem(item)) return "";
    if (item.keybinding) return formatKeys(item.keybinding);
    return item.command ? (app.keybindingLabel(item.command) ?? "") : "";
  };
  const width = Math.min(menuWidth(state.items, keysFor), screenWidth - 2);
  const height = state.items.length + 2;
  const left = state.x + width > screenWidth ? Math.max(0, screenWidth - width) : state.x;
  const top = state.y + 1 + height > screenHeight ? Math.max(0, state.y - height) : state.y + 1;
  return (
    <box position="absolute" left={left} top={top} zIndex={80}>
      <MenuPanel
        items={state.items}
        activeIndex={state.activeIndex}
        width={width}
        keysFor={keysFor}
        onChoose={(index) => void app.menus.choose(index)}
        onHover={(index) => app.menus.setActiveIndex(index)}
      />
    </box>
  );
}
