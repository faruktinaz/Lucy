/**
 * The status bar: left items (branch, sync, changes), a hint area (hover and focus hints,
 * the pending key sequence, short messages), right items (cursor, language, AI, theme).
 * Quiet by default: muted text, with only key facts in the default color. When the bar is
 * too narrow, the lowest-priority items are dropped first.
 */
import { useApp, useStore } from "@/app/react";
import { layoutStatusItems, type StatusItem, type StatusTone } from "@/app/workbench/status-bar";
import { displayWidth, sanitizeForDisplay, truncateEnd } from "@/core/text";
import { icon } from "@/themes/icons";
import { formatKeys } from "../primitives/key-hint";
import { useMeasure } from "../primitives/measure";
import { attrs, type TextTone, toneColor } from "../primitives/text";
import { usePointer } from "../primitives/use-pointer";
import { useTheme } from "../theme/theme-context";

const ITEM_PADDING = 1;
const MIN_HINT_WIDTH = 16;

function toneOf(tone: StatusTone | undefined): TextTone {
  switch (tone) {
    case "default":
      return "default";
    case "accent":
      return "accent";
    case "success":
      return "success";
    case "warning":
      return "warning";
    case "error":
      return "error";
    default:
      return "muted";
  }
}

function itemWidth(item: StatusItem): number {
  return displayWidth(sanitizeForDisplay(item.text)) + (item.icon ? 2 : 0) + ITEM_PADDING * 2;
}

function StatusEntry({ item }: { item: StatusItem }) {
  const app = useApp();
  const theme = useTheme();
  const c = theme.colors;
  const pointer = usePointer({
    disabled: !item.command,
    onClick: () => {
      if (item.command) void app.run(item.command, item.args);
    },
    hint: item.tooltip
      ? { text: item.tooltip, keys: item.command ? app.keybindingFor(item.command) : undefined }
      : null,
  });
  const color = toneColor(theme, toneOf(item.tone));
  const fg = pointer.hovered && item.command ? c.fg.default : color;
  return (
    <box
      height={1}
      flexShrink={0}
      paddingX={ITEM_PADDING}
      backgroundColor={pointer.hovered && item.command ? c.state.hover : undefined}
      {...pointer.props}
    >
      <text fg={fg} selectable={false} wrapMode="none">
        {item.icon ? (
          <span
            fg={item.tone && item.tone !== "muted" && item.tone !== "default" ? color : fg}
          >{`${icon(item.icon, theme.icons)} `}</span>
        ) : null}
        {sanitizeForDisplay(item.text)}
      </text>
    </box>
  );
}

/** Cells a hint needs to show in full: text, two spaces and its keys, plus the area's padding. */
function hintWidth(hint: { text: string; keys?: string } | null): number {
  if (!hint) return 0;
  const keys = hint.keys ? formatKeys(hint.keys) : "";
  return displayWidth(sanitizeForDisplay(hint.text)) + (keys ? displayWidth(keys) + 2 : 0) + 2;
}

function HintArea({ width }: { width: number }) {
  const app = useApp();
  const theme = useTheme();
  const c = theme.colors;
  useStore(app.hints.store);
  const hint = app.hints.current;
  if (!hint || width < 4) return <box flexGrow={1} minWidth={0} />;
  const keys = hint.keys ? formatKeys(hint.keys) : "";
  const keysWidth = keys ? displayWidth(keys) + 2 : 0;
  const text = truncateEnd(sanitizeForDisplay(hint.text), Math.max(1, width - 2 - keysWidth));
  const fg =
    hint.tone === "accent" ? c.accent.primary : hint.tone === "warning" ? c.status.warning : c.fg.muted;
  return (
    <box flexGrow={1} minWidth={0} paddingX={1} flexDirection="row">
      <text
        fg={fg}
        selectable={false}
        wrapMode="none"
        attributes={attrs({ bold: hint.tone === "accent" && theme.highContrast })}
      >
        {text}
        {keys && width - 2 - displayWidth(text) >= keysWidth ? (
          <span fg={c.fg.subtle}>{`  ${keys}`}</span>
        ) : null}
      </text>
    </box>
  );
}

export function StatusBar({ visible }: { visible: boolean }) {
  const app = useApp();
  const items = useStore(app.statusBar.store);
  const hints = useStore(app.hints.store);
  const { size, onSizeChange } = useMeasure();
  // A pending key sequence or an ambient hint ("Leave the terminal  Ctrl+\") is the one thing
  // the user needs right now, so it gets its full width and lower-priority items drop instead.
  // Hover and transient hints keep the minimum, so items do not jump around under the pointer.
  const steady = app.hints.current === hints.pending || app.hints.current === hints.ambient;
  const reserved = Math.max(MIN_HINT_WIDTH, steady ? hintWidth(app.hints.current) : 0);
  const available = Math.max(0, size.width - reserved);
  const { left, right } = layoutStatusItems(items, available, itemWidth);
  const used = [...left, ...right].reduce((sum, item) => sum + itemWidth(item), 0);
  return (
    <box
      visible={visible}
      height={1}
      flexShrink={0}
      flexDirection="row"
      paddingX={1}
      onSizeChange={onSizeChange}
    >
      {left.map((item) => (
        <StatusEntry key={item.id} item={item} />
      ))}
      <HintArea width={Math.max(0, size.width - used)} />
      {right.map((item) => (
        <StatusEntry key={item.id} item={item} />
      ))}
    </box>
  );
}
