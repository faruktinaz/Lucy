/**
 * Shapes a terminal can draw: cards and pills.
 *
 * A terminal cell is a hard rectangle; softness comes from glyphs that fill only part of a
 * cell, drawn in the shape's color over the color behind it.
 *
 * - Cards (the sidebar, the editor area, panels, overlays) are filled boxes whose top and
 *   bottom rows are half-block "lips" (`▄` / `▀`). A lip makes the card start and end half a
 *   row inside its cell, so a half-row of canvas shows between stacked cards, which matches
 *   the one-column gap beside them. In the rounded style the lip's end cells are quadrant
 *   blocks (`▗ ▖ ▝ ▘`), which cut a small notch into each corner. Block elements need no
 *   special font: every modern terminal draws them as exact geometry.
 * - Pills (selected rows, tabs, buttons, badges, key hints, fields) get end caps: Nerd Font
 *   half circles (U+E0B6, U+E0B4) with the nerd icon tier and rounded corners; half blocks
 *   (`▐ ▌`) for rounded corners without a Nerd Font, which still give a slim, deliberate end;
 *   a plain cell of the pill's color for the square style.
 */
import type { RGBA } from "@opentui/core";
import type { ReactNode } from "react";
import { useTheme } from "../theme/theme-context";
import type { UiTheme } from "../theme/ui-theme";

const nf = (codePoint: number): string => String.fromCodePoint(codePoint);

export const SHAPE_GLYPHS = {
  roundLeft: nf(0xe0b6),
  roundRight: nf(0xe0b4),
  halfLeft: "▐",
  halfRight: "▌",
  lipTop: { fill: "▄", left: "▗", right: "▖" },
  lipBottom: { fill: "▀", left: "▝", right: "▘" },
} as const;

export type CapSide = "left" | "right";

/** The end-cap glyph of a pill, or null when the cap is a plain filled cell (square style). */
export function capGlyph(theme: UiTheme, side: CapSide): string | null {
  if (theme.cornerStyle === "square") return null;
  if (theme.roundCaps) return side === "left" ? SHAPE_GLYPHS.roundLeft : SHAPE_GLYPHS.roundRight;
  return side === "left" ? SHAPE_GLYPHS.halfLeft : SHAPE_GLYPHS.halfRight;
}

/**
 * One pill end as a span inside a `<text>`. Without a `color` it renders a blank cell, so
 * rows keep their width whether or not they are highlighted.
 */
export function CapSpan({ side, color }: { side: CapSide; color: RGBA | undefined }) {
  const theme = useTheme();
  if (!color) return <span> </span>;
  const glyph = capGlyph(theme, side);
  return glyph === null ? <span bg={color}> </span> : <span fg={color}>{glyph}</span>;
}

/** One pill end as a one-cell box (for box-level layouts). */
export function CapCell({ side, color }: { side: CapSide; color: RGBA | undefined }) {
  return (
    <text width={1} height={1} flexShrink={0} selectable={false}>
      <CapSpan side={side} color={color} />
    </text>
  );
}

/** A one-row pill: caps around a filled middle. */
export function Pill({
  color,
  children,
  flexGrow,
  paddingX = 0,
}: {
  color: RGBA | undefined;
  children: ReactNode;
  flexGrow?: number;
  paddingX?: number;
}) {
  return (
    <box height={1} flexDirection="row" flexShrink={0} flexGrow={flexGrow}>
      <CapCell side="left" color={color} />
      <box
        height={1}
        flexDirection="row"
        flexGrow={flexGrow}
        backgroundColor={color}
        paddingX={paddingX}
        minWidth={0}
      >
        {children}
      </box>
      <CapCell side="right" color={color} />
    </box>
  );
}

/** The top or bottom row of a card: half-block fill with soft corners. */
export function CardLip({
  edge,
  color,
  under,
}: {
  edge: "top" | "bottom";
  color: RGBA;
  /** What shows in the lip's empty half (a shadow); transparent by default. */
  under?: RGBA;
}) {
  const theme = useTheme();
  const glyphs = edge === "top" ? SHAPE_GLYPHS.lipTop : SHAPE_GLYPHS.lipBottom;
  const rounded = theme.cornerStyle === "rounded";
  return (
    <box height={1} flexShrink={0} flexDirection="row" overflow="hidden">
      <text width={1} fg={color} selectable={false} flexShrink={0}>
        {rounded ? glyphs.left : glyphs.fill}
      </text>
      {/* Basis 0: the long fill string must not push the right corner out of the row. */}
      <box flexGrow={1} flexShrink={1} flexBasis={0} height={1} overflow="hidden" minWidth={0}>
        <text fg={color} bg={under} selectable={false} wrapMode="none">
          {glyphs.fill.repeat(400)}
        </text>
      </box>
      <text width={1} fg={color} bg={under} selectable={false} flexShrink={0}>
        {rounded ? glyphs.right : glyphs.fill}
      </text>
    </box>
  );
}

export interface CardProps {
  color: RGBA;
  children: ReactNode;
  /** Leave out the top or bottom lip (a card that continues under another part). */
  lips?: { top?: boolean; bottom?: boolean };
}

/**
 * A filled card with lips. It fills its parent; size and position come from the parent box.
 * With `outline` themes (High Contrast) the card is drawn with a thin rounded line instead,
 * because two near-black fills cannot be told apart and shape must not rely on color alone.
 */
export function Card({ color, children, lips }: CardProps) {
  const theme = useTheme();
  if (theme.shell.outline) {
    return (
      <box
        flexGrow={1}
        flexDirection="column"
        minHeight={0}
        minWidth={0}
        backgroundColor={color}
        border
        borderStyle={theme.cornerStyle === "rounded" ? "rounded" : "single"}
        borderColor={theme.colors.border.subtle}
      >
        {children}
      </box>
    );
  }
  return (
    <box flexGrow={1} flexDirection="column" minHeight={0} minWidth={0}>
      {lips?.top === false ? null : <CardLip edge="top" color={color} />}
      <box flexGrow={1} flexDirection="column" minHeight={0} minWidth={0} backgroundColor={color}>
        {children}
      </box>
      {lips?.bottom === false ? null : <CardLip edge="bottom" color={color} />}
    </box>
  );
}
