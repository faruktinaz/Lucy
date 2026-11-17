/**
 * Buttons. Three variants (primary, ghost, danger) and one icon-only form for headers and
 * bars. States: default, hover, pressed, focused (bold and underlined, so focus never relies
 * on color alone), disabled.
 */
import type { RGBA } from "@opentui/core";
import type { Hint } from "@/app/workbench/hints";
import type { IconName } from "@/themes/icons";
import { useTheme } from "../theme/theme-context";
import type { UiTheme } from "../theme/ui-theme";
import { Icon } from "./icon";
import { CapCell } from "./shape";
import { attrs } from "./text";
import { usePointer } from "./use-pointer";

export type ButtonVariant = "primary" | "ghost" | "danger";

export interface ButtonState {
  hovered: boolean;
  pressed: boolean;
  focused: boolean;
  disabled: boolean;
}

/** Colors of a button in a state. Exported for the component gallery and tests. */
export function buttonColors(
  theme: UiTheme,
  variant: ButtonVariant,
  state: ButtonState,
): { fg: RGBA; bg: RGBA | undefined } {
  const c = theme.colors;
  if (state.disabled) return { fg: c.fg.disabled, bg: variant === "ghost" ? undefined : c.bg.raised };
  if (variant === "ghost") {
    if (state.pressed) return { fg: c.fg.default, bg: c.state.active };
    if (state.focused) return { fg: c.state.selectedFg, bg: c.state.selectedBg };
    if (state.hovered) return { fg: c.fg.default, bg: c.state.hover };
    return { fg: c.fg.muted, bg: c.bg.raised };
  }
  const bg = variant === "danger" ? c.status.error : c.accent.primary;
  if (state.pressed) return { fg: c.fg.default, bg: c.state.active };
  return { fg: c.fg.onAccent, bg };
}

export interface ButtonProps {
  label: string;
  variant?: ButtonVariant;
  onPress?: () => void;
  focused?: boolean;
  disabled?: boolean;
  icon?: IconName;
  hint?: Hint | null;
  /** Force a state (component gallery). */
  forceState?: Partial<ButtonState>;
}

export function Button({
  label,
  variant = "ghost",
  onPress,
  focused = false,
  disabled = false,
  icon,
  hint,
  forceState,
}: ButtonProps) {
  const theme = useTheme();
  const pointer = usePointer({ onClick: () => onPress?.(), disabled, hint });
  const state: ButtonState = {
    hovered: pointer.hovered,
    pressed: pointer.pressed,
    focused,
    disabled,
    ...forceState,
  };
  const { fg, bg } = buttonColors(theme, variant, state);
  const emphasis = state.focused || (variant !== "ghost" && state.hovered);
  // A pill: the caps take the place of the outer padding cells, so widths are unchanged.
  return (
    <box height={1} flexShrink={0} flexDirection="row" {...pointer.props}>
      <CapCell side="left" color={bg} />
      <box height={1} paddingX={1} backgroundColor={bg}>
        <text fg={fg} attributes={attrs({ bold: emphasis, underline: state.focused })} selectable={false}>
          {icon ? <Icon name={icon} color={fg} /> : null}
          {label}
        </text>
      </box>
      <CapCell side="right" color={bg} />
    </box>
  );
}

export interface IconButtonProps {
  icon: IconName;
  onPress?: () => void;
  /** Shown in the hint area on hover: what it does, and its keybinding. */
  hint?: Hint | null;
  /** Rendered in the default color (a toggle that is on). */
  active?: boolean;
  disabled?: boolean;
  /** Background of the surface it sits on; hover is drawn over it. */
  surface?: RGBA;
  forceHover?: boolean;
}

/** An icon-only button: one cell of padding each side, quiet until hovered. */
export function IconButton({
  icon,
  onPress,
  hint,
  active = false,
  disabled = false,
  surface,
  forceHover,
}: IconButtonProps) {
  const theme = useTheme();
  const pointer = usePointer({ onClick: () => onPress?.(), disabled, hint });
  const hovered = forceHover ?? pointer.hovered;
  const c = theme.colors;
  const fg = disabled ? c.fg.disabled : active || hovered ? c.fg.default : c.fg.subtle;
  const bg = pointer.pressed ? c.state.active : hovered && !disabled ? c.state.hover : surface;
  // Hover draws a small round pill around the icon (caps on either side).
  const fill = bg === surface ? undefined : bg;
  return (
    <box height={1} width={3} flexShrink={0} flexDirection="row" backgroundColor={surface} {...pointer.props}>
      <CapCell side="left" color={fill} />
      <text fg={fg} bg={fill} selectable={false} width={1}>
        <Icon name={icon} color={fg} space={false} />
      </text>
      <CapCell side="right" color={fill} />
    </box>
  );
}
