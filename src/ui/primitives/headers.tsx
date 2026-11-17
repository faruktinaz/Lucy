/**
 * Panel and section headers.
 *
 * - `PanelHeader`: the first row of a card. A muted title in its own case that turns to the
 *   accent color while the panel has focus (bold in High Contrast, so focus never relies on
 *   color alone), with icon actions right-aligned.
 * - `SectionHeader`: a collapsible group inside a panel ("STAGED CHANGES 3"). Its actions
 *   appear only while the header is hovered or the section has focus, to keep panels calm.
 */
import type { RGBA } from "@opentui/core";
import type { Hint } from "@/app/workbench/hints";
import { type IconName, icon } from "@/themes/icons";
import { useDensity, useTheme } from "../theme/theme-context";
import { formatCount } from "./badge";
import { IconButton } from "./button";
import { attrs } from "./text";
import { usePointer } from "./use-pointer";

export interface HeaderAction {
  readonly icon: IconName;
  readonly hint?: Hint | null;
  readonly onPress: () => void;
  readonly active?: boolean;
  readonly disabled?: boolean;
}

export interface PanelHeaderProps {
  title: string;
  focused: boolean;
  actions?: readonly HeaderAction[];
  /** Muted text after the title (a count, a branch). */
  detail?: string;
  surface?: RGBA;
}

export function PanelHeader({ title, focused, actions = [], detail, surface }: PanelHeaderProps) {
  const theme = useTheme();
  const density = useDensity();
  const c = theme.colors;
  const bg = surface;
  const titleColor = focused ? c.accent.primary : c.fg.muted;
  return (
    <box
      height={1}
      flexShrink={0}
      flexDirection="row"
      backgroundColor={bg}
      paddingLeft={density.rowPaddingX + 1}
    >
      <text
        flexGrow={1}
        flexShrink={1}
        fg={titleColor}
        attributes={attrs({ bold: focused || theme.highContrast })}
        selectable={false}
        wrapMode="none"
      >
        {title}
        {detail ? <span fg={c.fg.subtle} attributes={0}>{`  ${detail}`}</span> : null}
      </text>
      {actions.map((action) => (
        <IconButton
          key={action.icon}
          icon={action.icon}
          hint={action.hint}
          onPress={action.onPress}
          active={action.active}
          disabled={action.disabled}
          surface={bg}
        />
      ))}
    </box>
  );
}

export interface SectionHeaderProps {
  title: string;
  expanded: boolean;
  onToggle?: () => void;
  count?: number;
  actions?: readonly HeaderAction[];
  /** The section's list has focus: actions stay visible. */
  focused?: boolean;
  /** The header row itself is the keyboard selection. */
  selected?: boolean;
  surface?: RGBA;
  /** Force the hovered look (component gallery). */
  forceHover?: boolean;
}

export function SectionHeader({
  title,
  expanded,
  onToggle,
  count,
  actions = [],
  focused = false,
  selected = false,
  surface,
  forceHover,
}: SectionHeaderProps) {
  const theme = useTheme();
  const density = useDensity();
  const c = theme.colors;
  // Hover events bubble from the action buttons, so hovering an action keeps the header hovered.
  const pointer = usePointer({ onClick: () => onToggle?.() });
  const hovered = forceHover ?? pointer.hovered;
  const bg = selected
    ? focused
      ? c.state.selectedBg
      : c.state.selectedInactiveBg
    : hovered
      ? c.state.hover
      : surface;
  const showActions = actions.length > 0 && (hovered || focused || selected);
  return (
    <box
      height={1}
      flexShrink={0}
      flexDirection="row"
      backgroundColor={bg}
      paddingLeft={density.rowPaddingX + 1}
      {...pointer.props}
    >
      <text flexGrow={1} flexShrink={1} selectable={false} wrapMode="none" fg={c.fg.muted}>
        <span fg={c.fg.subtle}>{`${icon(expanded ? "chevronDown" : "chevronRight", theme.icons)} `}</span>
        <span fg={selected && focused ? c.state.selectedFg : c.fg.muted} attributes={attrs({ bold: true })}>
          {title.toUpperCase()}
        </span>
        {count !== undefined && count > 0 ? (
          <span fg={c.fg.subtle}>{`  ${formatCount(count, 4)}`}</span>
        ) : null}
      </text>
      {showActions
        ? actions.map((action) => (
            <IconButton
              key={action.icon}
              icon={action.icon}
              hint={action.hint}
              onPress={action.onPress}
              active={action.active}
              disabled={action.disabled}
              surface={bg}
            />
          ))
        : null}
    </box>
  );
}
