/**
 * Drag-to-resize.
 *
 * `ResizeHandle` is a 1-cell strip on a panel edge: invisible until hovered (the layout has
 * no divider lines); on hover and while dragging it shows a thin accent line. It sits
 * absolutely over the panel's outermost cell, which is padding, so it costs no space.
 * `useDragResize` gives the same behaviour to any box (the bottom panel's header row).
 *
 * Drag capture (OPENTUI_NOTES §5): after a `down` every `drag` goes to the pressed element
 * and bubbles to its ancestors, even when the pointer leaves it.
 */
import type { MouseEvent } from "@opentui/core";
import { useRef, useState } from "react";
import { useHoverHint } from "@/app/react";
import type { Hint } from "@/app/workbench/hints";
import { useTheme } from "../theme/theme-context";

export interface DragResizeOptions {
  /** `x`: drag left/right; `y`: drag up/down. */
  axis: "x" | "y";
  /** +1 when moving right/down grows the panel, -1 when it shrinks it. */
  sign: 1 | -1;
  /** The size when the drag starts. */
  size: () => number;
  /** Called with the new size during the drag (the owner clamps it). */
  onResize: (size: number) => void;
  onResizeEnd?: () => void;
  /** Stop the down event from reaching ancestors (a dedicated handle). Default false. */
  capture?: boolean;
}

export function useDragResize(options: DragResizeOptions): {
  dragging: boolean;
  props: {
    onMouseDown: (event: MouseEvent) => void;
    onMouseDrag: (event: MouseEvent) => void;
    onMouseDragEnd: () => void;
    onMouseUp: () => void;
  };
} {
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; size: number } | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const end = () => {
    if (!start.current) return;
    start.current = null;
    setDragging(false);
    latest.current.onResizeEnd?.();
  };
  return {
    dragging,
    props: {
      onMouseDown: (event) => {
        if (event.button !== 0) return;
        if (latest.current.capture) event.stopPropagation();
        start.current = { x: event.x, y: event.y, size: latest.current.size() };
      },
      onMouseDrag: (event) => {
        const origin = start.current;
        if (!origin) return;
        if (!dragging) setDragging(true);
        const { axis, sign, onResize } = latest.current;
        const delta = axis === "x" ? event.x - origin.x : event.y - origin.y;
        onResize(origin.size + sign * delta);
      },
      onMouseDragEnd: end,
      onMouseUp: end,
    },
  };
}

export interface ResizeHandleProps {
  /** Which edge of the parent the handle sits on. */
  edge: "left" | "right";
  size: () => number;
  onResize: (size: number) => void;
  onResizeEnd?: () => void;
  hint?: Hint | null;
  /** Force the hovered look (component gallery). */
  forceActive?: boolean;
}

/** A vertical handle on the left or right edge of a side panel. */
export function ResizeHandle({ edge, size, onResize, onResizeEnd, hint, forceActive }: ResizeHandleProps) {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);
  // Dragging toward the panel's inside shrinks it.
  const drag = useDragResize({
    axis: "x",
    sign: edge === "right" ? 1 : -1,
    size,
    onResize,
    onResizeEnd,
    capture: true,
  });
  const hoverHint = useHoverHint(hint ?? null);
  const active = forceActive ?? (hovered || drag.dragging);
  // A one-eighth block hugging the outer edge reads as a thin line between regions.
  const glyph = edge === "right" ? "▕" : "▏";
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: an OpenTUI renderable, not a DOM element.
    // biome-ignore lint/a11y/useKeyWithMouseEvents: keyboard resizing is the view.increaseViewSize command.
    <box
      position="absolute"
      {...(edge === "right" ? { right: 0 } : { left: 0 })}
      top={0}
      width={1}
      height="100%"
      zIndex={10}
      overflow="hidden"
      {...drag.props}
      onMouseOver={() => {
        setHovered(true);
        hoverHint.onMouseOver();
      }}
      onMouseOut={() => {
        setHovered(false);
        hoverHint.onMouseOut();
      }}
    >
      {/* High Contrast keeps the line at rest: neighbouring regions differ only slightly in fill. */}
      {active ? (
        <text fg={active ? theme.colors.accent.primary : theme.colors.border.subtle} selectable={false}>
          {`${glyph}\n`.repeat(300)}
        </text>
      ) : null}
    </box>
  );
}
