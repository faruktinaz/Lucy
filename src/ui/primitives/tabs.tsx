/**
 * Tab strips.
 *
 * - `editor`: the active tab sits on the editor canvas color (`bg.base`) so it reads as
 *   attached to the content below; inactive tabs are muted on the surface. A fixed two-cell
 *   slot after the title holds the dirty dot, or a close button on hover, so tabs never
 *   change width. Preview tabs are italic.
 * - `panel`: uppercase titles for the bottom panel; the active one is bold default text.
 *
 * Overflow: tabs that do not fit are hidden (the active tab is always visible) and a quiet
 * `+N` button at the end lists them.
 */
import type { MouseEvent, RGBA } from "@opentui/core";
import type { ReactNode } from "react";
import { displayWidth, sanitizeForDisplay, truncateEnd } from "@/core/text";
import { icon } from "@/themes/icons";
import { useDensity, useTheme } from "../theme/theme-context";
import { attrs } from "./text";
import { usePointer } from "./use-pointer";

export interface TabItem {
  readonly id: string;
  readonly title: string;
  /** A rendered icon span (`<FileIcon>`), followed by its space. */
  readonly icon?: ReactNode;
  readonly iconWidth?: number;
  /** Preview tab: italic title. */
  readonly italic?: boolean;
  readonly dirty?: boolean;
  readonly closable?: boolean;
  /** Muted text after the title (disambiguates equal names). */
  readonly description?: string;
}

export interface TabsProps {
  items: readonly TabItem[];
  activeId: string | null;
  onSelect?: (id: string) => void;
  onClose?: (id: string) => void;
  onDoubleClick?: (id: string) => void;
  onContextMenu?: (id: string, event: MouseEvent) => void;
  /** Called with the hidden tabs when the overflow button is pressed. */
  onOverflow?: (hidden: readonly TabItem[]) => void;
  variant?: "editor" | "panel";
  /** Available width in cells. */
  width: number;
  surface?: RGBA;
  /** The strip's zone has focus (the active editor tab title turns bold). */
  focused?: boolean;
  /** Maximum title width before truncation. */
  maxTitleWidth?: number;
}

const TRAILING = 2;
const OVERFLOW_WIDTH = 5;

function titleText(item: TabItem, max: number, variant: "editor" | "panel"): string {
  const title = sanitizeForDisplay(variant === "panel" ? item.title.toUpperCase() : item.title);
  return truncateEnd(title, max);
}

export function tabWidth(
  item: TabItem,
  paddingX: number,
  variant: "editor" | "panel",
  maxTitle: number,
): number {
  const title = displayWidth(titleText(item, maxTitle, variant));
  const description = item.description ? displayWidth(item.description) + 1 : 0;
  if (variant === "panel") return title + paddingX * 2;
  return paddingX + (item.iconWidth ?? 0) + title + description + TRAILING + Math.max(0, paddingX - 1);
}

/** Which tabs fit: a contiguous window that always contains the active tab. */
export function visibleTabRange(
  widths: readonly number[],
  activeIndex: number,
  available: number,
): { start: number; end: number } {
  const count = widths.length;
  if (count === 0) return { start: 0, end: -1 };
  const total = widths.reduce((sum, w) => sum + w, 0);
  if (total <= available) return { start: 0, end: count - 1 };
  const room = available - OVERFLOW_WIDTH;
  const active = Math.max(0, Math.min(count - 1, activeIndex));
  let start = 0;
  let used = widths.slice(0, active + 1).reduce((sum, w) => sum + w, 0);
  while (used > room && start < active) {
    used -= widths[start] ?? 0;
    start++;
  }
  let end = active;
  while (end + 1 < count && used + (widths[end + 1] ?? 0) <= room) {
    end++;
    used += widths[end] ?? 0;
  }
  return { start, end };
}

function Tab({
  item,
  active,
  variant,
  focused,
  surface,
  paddingX,
  maxTitle,
  onSelect,
  onClose,
  onDoubleClick,
  onContextMenu,
}: {
  item: TabItem;
  active: boolean;
  variant: "editor" | "panel";
  focused: boolean;
  surface?: RGBA;
  paddingX: number;
  maxTitle: number;
  onSelect?: (id: string) => void;
  onClose?: (id: string) => void;
  onDoubleClick?: (id: string) => void;
  onContextMenu?: (id: string, event: MouseEvent) => void;
}) {
  const theme = useTheme();
  const c = theme.colors;
  const pointer = usePointer({
    onClick: () => onSelect?.(item.id),
    onDoubleClick: () => onDoubleClick?.(item.id),
    onContextMenu: (event) => onContextMenu?.(item.id, event),
  });
  const close = usePointer({ onClick: () => onClose?.(item.id) });
  const title = titleText(item, maxTitle, variant);

  if (variant === "panel") {
    const fg = active ? c.fg.default : pointer.hovered ? c.fg.default : c.fg.muted;
    return (
      <box height={1} flexShrink={0} paddingX={paddingX} backgroundColor={surface} {...pointer.props}>
        <text
          fg={fg}
          attributes={attrs({ bold: active, underline: active && theme.highContrast })}
          selectable={false}
        >
          {title}
        </text>
      </box>
    );
  }

  const bg = active ? c.bg.base : pointer.hovered ? c.state.hover : surface;
  const fg = active || pointer.hovered ? c.fg.default : c.fg.muted;
  // As in VS Code: a dirty tab shows its dot until hovered; the active tab offers close.
  const showClose = item.closable !== false && (pointer.hovered || (active && !item.dirty));
  const trailing = showClose ? icon("close", theme.icons) : item.dirty ? icon("modified", theme.icons) : " ";
  const trailingColor = showClose
    ? close.hovered
      ? c.fg.default
      : c.fg.subtle
    : item.dirty
      ? active
        ? c.fg.default
        : c.fg.muted
      : undefined;
  return (
    <box
      height={1}
      flexShrink={0}
      flexDirection="row"
      backgroundColor={bg}
      paddingLeft={paddingX}
      paddingRight={Math.max(0, paddingX - 1)}
      {...pointer.props}
    >
      <text
        fg={fg}
        selectable={false}
        attributes={attrs({ italic: item.italic, bold: active && (focused || theme.highContrast) })}
      >
        {item.icon}
        {title}
        {item.description ? <span fg={c.fg.subtle} attributes={0}>{` ${item.description}`}</span> : null}
      </text>
      <box width={TRAILING} height={1} flexShrink={0} {...close.props}>
        <text fg={trailingColor ?? fg} selectable={false}>{` ${trailing}`}</text>
      </box>
    </box>
  );
}

function OverflowButton({
  hidden,
  onPress,
  surface,
}: {
  hidden: number;
  onPress?: () => void;
  surface?: RGBA;
}) {
  const theme = useTheme();
  const pointer = usePointer({
    onClick: () => onPress?.(),
    hint: { text: `${hidden} more open ${hidden === 1 ? "tab" : "tabs"}` },
  });
  const c = theme.colors;
  return (
    <box
      height={1}
      width={OVERFLOW_WIDTH}
      flexShrink={0}
      backgroundColor={pointer.hovered ? c.state.hover : surface}
      justifyContent="center"
      {...pointer.props}
    >
      <text fg={pointer.hovered ? c.fg.default : c.fg.subtle} selectable={false}>{`+${hidden}`}</text>
    </box>
  );
}

export function Tabs({
  items,
  activeId,
  onSelect,
  onClose,
  onDoubleClick,
  onContextMenu,
  onOverflow,
  variant = "editor",
  width,
  surface,
  focused = false,
  maxTitleWidth = 32,
}: TabsProps) {
  const density = useDensity();
  const paddingX = variant === "panel" ? 1 : density.tabPaddingX;
  const widths = items.map((item) => tabWidth(item, paddingX, variant, maxTitleWidth));
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.id === activeId),
  );
  const { start, end } = visibleTabRange(widths, activeIndex, width);
  const visible = items.slice(start, end + 1);
  const hidden = [...items.slice(0, start), ...items.slice(end + 1)];
  return (
    <box
      height={1}
      flexShrink={0}
      flexDirection="row"
      backgroundColor={surface}
      width={width}
      overflow="hidden"
    >
      {visible.map((item) => (
        <Tab
          key={item.id}
          item={item}
          active={item.id === activeId}
          variant={variant}
          focused={focused}
          surface={surface}
          paddingX={paddingX}
          maxTitle={maxTitleWidth}
          onSelect={onSelect}
          onClose={onClose}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
        />
      ))}
      <box flexGrow={1} />
      {hidden.length > 0 ? (
        <OverflowButton hidden={hidden.length} surface={surface} onPress={() => onOverflow?.(hidden)} />
      ) : null}
    </box>
  );
}
