/**
 * The small pressable controls of the Search field: the three option toggles drawn inside
 * the field (`Aa` match case, `ab` whole word, `.*` regular expression, as in VS Code) and the
 * chevron that shows the include and exclude fields.
 *
 * They are text glyphs rather than icons so they read the same in every icon tier. States:
 * off is subtle, hover gets the hover fill, on gets the "active item of a group" fill with the
 * accent color and bold (bold keeps the state visible without color in High Contrast), and
 * pressed uses the active fill.
 */
import type { RGBA } from "@opentui/core";
import type { Hint } from "@/app/workbench/hints";
import { icon } from "@/themes/icons";
import { attrs } from "@/ui/primitives/text";
import { usePointer } from "@/ui/primitives/use-pointer";
import { useTheme } from "@/ui/theme/theme-context";

export interface SearchToggleProps {
  label: string;
  on: boolean;
  hint: Hint;
  onPress: () => void;
  /** Underline the glyph (the "whole word" toggle). */
  underline?: boolean;
  /** Fill of the field behind it. */
  surface: RGBA;
}

export function SearchToggle({ label, on, hint, onPress, underline = false, surface }: SearchToggleProps) {
  const theme = useTheme();
  const c = theme.colors;
  const pointer = usePointer({ onClick: onPress, hint });
  const bg = pointer.pressed || on ? c.state.active : pointer.hovered ? c.state.hover : surface;
  const fg = on ? c.accent.primary : pointer.hovered ? c.fg.default : c.fg.subtle;
  return (
    <box height={1} width={label.length} flexShrink={0} backgroundColor={bg} {...pointer.props}>
      <text fg={fg} bg={bg} selectable={false} attributes={attrs({ bold: on, underline })}>
        {label}
      </text>
    </box>
  );
}

export interface DetailsChevronProps {
  open: boolean;
  /** Globs are set while the fields are hidden: draw the chevron in the accent color. */
  active: boolean;
  hint: Hint;
  onPress: () => void;
}

/** Two cells: the chevron and the gap before the field. */
export function DetailsChevron({ open, active, hint, onPress }: DetailsChevronProps) {
  const theme = useTheme();
  const c = theme.colors;
  const pointer = usePointer({ onClick: onPress, hint });
  const fg = active ? c.accent.primary : pointer.hovered ? c.fg.default : c.fg.subtle;
  const bg = pointer.pressed ? c.state.active : pointer.hovered ? c.state.hover : undefined;
  return (
    <box height={1} width={2} flexShrink={0} {...pointer.props}>
      <text selectable={false}>
        <span fg={fg} bg={bg}>
          {icon(open ? "chevronDown" : "chevronRight", theme.icons)}
        </span>
        <span> </span>
      </text>
    </box>
  );
}
