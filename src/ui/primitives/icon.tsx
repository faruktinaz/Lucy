/**
 * Icons from the three tiers in `src/themes/icons.ts` (nerd / unicode / ascii), chosen by
 * the `ui.icons` setting. An icon is always followed by one space so labels line up on the
 * same column whatever the tier; pass `space={false}` only where the icon stands alone in a
 * fixed-width cell (activity bar, close buttons).
 */
import type { RGBA } from "@opentui/core";
import { type FileIconKind, type IconName, icon, iconForFile } from "@/themes/icons";
import { useTheme } from "../theme/theme-context";
import { colorOf } from "../theme/ui-theme";
import { Span, type TextTone } from "./text";

export function Icon({
  name,
  tone = "muted",
  color,
  space = true,
  bold,
}: {
  name: IconName;
  tone?: TextTone;
  color?: RGBA;
  space?: boolean;
  bold?: boolean;
}) {
  const theme = useTheme();
  return (
    <Span tone={tone} color={color} bold={bold}>
      {icon(name, theme.icons)}
      {space ? " " : ""}
    </Span>
  );
}

/** The file-type icon of an explorer entry, in its token color. */
export function FileIcon({
  name,
  kind = "file",
  space = true,
  color,
}: {
  name: string;
  kind?: FileIconKind;
  space?: boolean;
  /** Overrides the file-type color (selected rows use the selection foreground). */
  color?: RGBA;
}) {
  const theme = useTheme();
  const spec = iconForFile(name, kind, theme.icons);
  return (
    <Span color={color ?? colorOf(theme, spec.color)}>
      {spec.glyph}
      {space ? " " : ""}
    </Span>
  );
}
