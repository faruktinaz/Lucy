/**
 * Click, double-click, context-click and hover for any box. OpenTUI has no click events
 * (docs/dev/OPENTUI_NOTES.md §5): a click is a left `down` and `up` on the same element with
 * no drag in between. After a drag the element under the pointer also receives an `up`;
 * since its `down` happened elsewhere, it is ignored.
 */
import type { MouseEvent } from "@opentui/core";
import { useEffect, useRef, useState } from "react";
import { useOptionalApp } from "@/app/react";
import type { Hint } from "@/app/workbench/hints";

export const DOUBLE_CLICK_MS = 400;

/**
 * Mouse events bubble from the hit renderable to its ancestors. The innermost element with
 * a click handler claims the event, so a button inside a clickable row does not also click
 * the row; ancestors still see the event (a zone still takes focus).
 */
const claimed = new WeakSet<MouseEvent>();

export interface PointerOptions {
  onClick?: (event: MouseEvent) => void;
  onDoubleClick?: (event: MouseEvent) => void;
  /** Right button. */
  onContextMenu?: (event: MouseEvent) => void;
  onHoverChange?: (hovered: boolean) => void;
  /** Shown in the status bar's hint area while hovered. */
  hint?: Hint | null;
  disabled?: boolean;
}

export interface PointerProps {
  onMouseDown: (event: MouseEvent) => void;
  onMouseUp: (event: MouseEvent) => void;
  onMouseDrag: (event: MouseEvent) => void;
  onMouseOver: (event: MouseEvent) => void;
  onMouseOut: (event: MouseEvent) => void;
}

export interface PointerState {
  readonly hovered: boolean;
  readonly pressed: boolean;
  readonly props: PointerProps;
}

export function usePointer(options: PointerOptions): PointerState {
  const app = useOptionalApp();
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);
  const latest = useRef(options);
  latest.current = options;
  const gesture = useRef({ down: false, dragged: false, lastClick: 0, lastX: -1, lastY: -1 });
  const owner = useRef({}).current;

  useEffect(() => () => app?.hints.setHover(owner, null), [app, owner]);

  const props: PointerProps = {
    onMouseDown: (event) => {
      const current = latest.current;
      if (current.disabled) return;
      if (event.button === 2) {
        if (current.onContextMenu && !claimed.has(event)) {
          claimed.add(event);
          current.onContextMenu(event);
        }
        return;
      }
      if (event.button !== 0) return;
      gesture.current.down = true;
      gesture.current.dragged = false;
      setPressed(true);
    },
    onMouseDrag: () => {
      if (gesture.current.down) gesture.current.dragged = true;
    },
    onMouseUp: (event) => {
      const state = gesture.current;
      const wasClick = state.down && !state.dragged && event.button === 0;
      state.down = false;
      setPressed(false);
      const current = latest.current;
      if (!wasClick || current.disabled || claimed.has(event)) return;
      if (!current.onClick && !current.onDoubleClick) return;
      claimed.add(event);
      const now = Date.now();
      const isDouble =
        now - state.lastClick <= DOUBLE_CLICK_MS && state.lastX === event.x && state.lastY === event.y;
      state.lastClick = isDouble ? 0 : now;
      state.lastX = event.x;
      state.lastY = event.y;
      current.onClick?.(event);
      if (isDouble) current.onDoubleClick?.(event);
    },
    onMouseOver: () => {
      setHovered(true);
      latest.current.onHoverChange?.(true);
      const hint = latest.current.hint;
      if (hint) app?.hints.setHover(owner, hint);
    },
    onMouseOut: () => {
      gesture.current.down = false;
      setHovered(false);
      setPressed(false);
      latest.current.onHoverChange?.(false);
      app?.hints.setHover(owner, null);
    },
  };

  return { hovered, pressed, props };
}
