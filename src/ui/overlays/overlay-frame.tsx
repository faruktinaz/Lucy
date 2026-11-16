/**
 * The frame of floating overlays: a rounded `border.default` keyline on a `bg.overlay` card.
 * Box-drawing lines sit in the middle of their cells, so the card's fill extends half a cell
 * beyond the line; that reads as a card with an inset keyline. (Leaving the border cells
 * transparent was tried: the line then floats in a dark gutter, which looks worse.)
 */
import type { ReactNode } from "react";
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
  return (
    <box
      width={width}
      height={height}
      flexShrink={0}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={c.border.default}
      title={title}
      titleAlignment="left"
    >
      <box
        flexGrow={1}
        flexDirection="column"
        backgroundColor={c.bg.overlay}
        paddingX={paddingX}
        paddingY={paddingY}
      >
        {children}
      </box>
    </box>
  );
}
