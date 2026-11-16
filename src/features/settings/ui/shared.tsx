/**
 * Pieces shared by the Settings, Keyboard Shortcuts, onboarding and Integrations views. All
 * colors come from theme tokens; all keys come from the registry or are fixed editing keys.
 */
import type { RGBA } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { type Ref, useEffect } from "react";
import { useApp } from "@/app/react";
import { Icon } from "@/ui/primitives/icon";
import { attrs } from "@/ui/primitives/text";
import { TextField, type TextFieldHandle } from "@/ui/primitives/text-field";
import { usePointer } from "@/ui/primitives/use-pointer";
import { useTheme } from "@/ui/theme/theme-context";
import { type SettingsServices, settingsServices } from "../services";

/** Content inset of the editor canvas: the breadcrumb starts at column 2. */
export const CANVAS_PADDING_X = 2;

export function useSettingsServices(): SettingsServices {
  return settingsServices(useApp());
}

/**
 * Hands the renderer to the feature's services (needed to suspend the screen for an external
 * editor and to copy to the clipboard from commands that run outside React).
 */
export function useRendererBridge(services: SettingsServices): void {
  const renderer = useRenderer();
  useEffect(() => {
    services.renderer.current = renderer;
  }, [services, renderer]);
}

export interface HintItem {
  readonly keys: string;
  readonly label: string;
}

/** `Enter change  ←→ cycle  Del reset`: keys muted, words subtle. */
export function HintLine({ items, bg }: { items: readonly HintItem[]; bg?: RGBA }) {
  const theme = useTheme();
  const c = theme.colors;
  return (
    <text selectable={false} wrapMode="none" bg={bg} flexShrink={1}>
      {items.map((item, index) => (
        <span key={`${item.keys}-${item.label}`}>
          {index > 0 ? <span fg={c.fg.subtle}>{"   "}</span> : null}
          <span fg={c.fg.muted}>{item.keys}</span>
          <span fg={c.fg.subtle}>{` ${item.label}`}</span>
        </span>
      ))}
    </text>
  );
}

/** A key label drawn as a small keycap (`Ctrl+K E`), for shortcut lists and the capture card. */
export function KeyChip({
  label,
  selected = false,
  tone = "default",
}: {
  label: string;
  /** The chip has keyboard focus inside its row. */
  selected?: boolean;
  tone?: "default" | "user" | "muted";
}) {
  const theme = useTheme();
  const c = theme.colors;
  const fg = selected ? c.fg.onAccent : tone === "muted" ? c.fg.muted : c.fg.default;
  const bg = selected ? c.accent.primary : c.bg.raised;
  return (
    <span fg={fg} bg={bg} attributes={attrs({ bold: selected || (tone === "user" && theme.highContrast) })}>
      {` ${label} `}
    </span>
  );
}

/** The search row at the top of the Settings and Keyboard Shortcuts editors. */
export function SearchRow({
  placeholder,
  value,
  focused,
  count,
  onInput,
  onFocusRequest,
  fieldRef,
}: {
  placeholder: string;
  value: string;
  focused: boolean;
  /** Right-aligned quiet summary ("44 settings"). */
  count: string;
  onInput: (value: string) => void;
  onFocusRequest: () => void;
  fieldRef: Ref<TextFieldHandle>;
}) {
  const theme = useTheme();
  const c = theme.colors;
  const pointer = usePointer({ onClick: onFocusRequest });
  return (
    <box height={1} flexShrink={0} flexDirection="row" paddingX={CANVAS_PADDING_X} gap={2}>
      <box flexGrow={1} flexShrink={1} {...pointer.props}>
        <TextField
          ref={fieldRef}
          icon="search"
          placeholder={placeholder}
          value={value}
          focused={focused}
          onInput={onInput}
        />
      </box>
      <text fg={c.fg.subtle} selectable={false} flexShrink={0}>
        {count}
      </text>
    </box>
  );
}

/** A clickable text action in the accent color (`Open config.toml`). */
export function TextAction({
  label,
  onPress,
  focused = false,
  icon,
  bg,
}: {
  label: string;
  onPress: () => void;
  focused?: boolean;
  icon?: Parameters<typeof Icon>[0]["name"];
  bg?: RGBA;
}) {
  const theme = useTheme();
  const c = theme.colors;
  const pointer = usePointer({ onClick: onPress });
  const active = focused || pointer.hovered;
  const fg = focused ? c.state.selectedFg : pointer.hovered ? c.fg.default : c.accent.primary;
  const background = focused ? c.state.selectedBg : pointer.hovered ? c.state.hover : bg;
  return (
    <box height={1} flexShrink={0} paddingX={1} backgroundColor={background} {...pointer.props}>
      <text
        fg={fg}
        selectable={false}
        attributes={attrs({ underline: active && theme.highContrast, bold: focused })}
      >
        {icon ? <Icon name={icon} color={fg} /> : null}
        {label}
      </text>
    </box>
  );
}
