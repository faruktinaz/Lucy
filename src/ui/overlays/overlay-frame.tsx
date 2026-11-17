/**
 * The frame of floating overlays (quick pick, dialogs, menus): a `bg.overlay` card with the
 * same half-block lips and soft corners as the workbench cards, and a soft shadow on its
 * right and bottom edges. No outline: the dimmed backdrop and the shadow lift it. High
 * Contrast draws a keyline instead, so the edge never depends on color alone.
 */
import type { ReactNode } from "react";
import { CardLip } from "../primitives/shape";
import { useTheme } from "../theme/theme-context";

export interface OverlayFrameProps {
  children: ReactNode;
  title?: string;
  width?: number;
  height?: number;
  paddingX?: number;
  paddingY?: number;
}

export function OverlayFrame({
  children,
  title,
  width,
  height,
  paddingX = 0,
  paddingY = 0,
}: OverlayFrameProps) {
  const theme = useTheme();
  const c = theme.colors;
  const fill = c.bg.overlay;
  if (theme.shell.outline) {
    // High Contrast: a keyline, so the card's edge never depends on a fill color.
    return (
      <box
        width={width}
        height={height}
        flexShrink={0}
        flexDirection="column"
        backgroundColor={fill}
        border
        borderStyle={theme.cornerStyle === "rounded" ? "rounded" : "single"}
        borderColor={c.border.default}
        title={title ? ` ${title} ` : undefined}
        titleAlignment="left"
      >
        <box flexGrow={1} flexDirection="column" paddingX={paddingX} paddingY={paddingY}>
          {children}
        </box>
      </box>
    );
  }
  const shadow = theme.shell.shadow;
  // The card (lips, one cell of side padding where the border used to be) plus a soft shadow:
  // a column on the right and the lower half of the bottom lip row.
  return (
    <box
      width={width === undefined ? undefined : width + 1}
      height={height}
      flexShrink={0}
      flexDirection="row"
    >
      <box width={width} flexShrink={0} flexDirection="column">
        <CardLip edge="top" color={fill} />
        <box
          flexGrow={1}
          flexDirection="column"
          backgroundColor={fill}
          paddingX={1 + paddingX}
          paddingY={paddingY}
        >
          {title ? (
            <text height={1} fg={c.fg.subtle} selectable={false} wrapMode="none" flexShrink={0}>
              {title.trim()}
            </text>
          ) : null}
          {children}
        </box>
        <CardLip edge="bottom" color={fill} under={shadow} />
      </box>
      <box width={1} flexShrink={0} flexDirection="column">
        <box height={1} flexShrink={0} />
        <box flexGrow={1} backgroundColor={shadow} />
      </box>
    </box>
  );
}
