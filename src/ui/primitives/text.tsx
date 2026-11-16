/**
 * Text variants. Hierarchy comes from tone (default / muted / subtle) and a little bold,
 * never from many colors: bold for the few things that matter (active titles, dialog
 * titles), muted for secondary and subtle for tertiary text, uppercase only for small
 * section titles.
 */
import { type RGBA, TextAttributes } from "@opentui/core";
import type { ReactNode } from "react";
import { useTheme } from "../theme/theme-context";
import type { UiTheme } from "../theme/ui-theme";

export type TextTone =
  | "default"
  | "muted"
  | "subtle"
  | "disabled"
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "info"
  | "onAccent"
  | "selected";

export function toneColor(theme: UiTheme, tone: TextTone): RGBA {
  const c = theme.colors;
  switch (tone) {
    case "default":
      return c.fg.default;
    case "muted":
      return c.fg.muted;
    case "subtle":
      return c.fg.subtle;
    case "disabled":
      return c.fg.disabled;
    case "accent":
      return c.accent.primary;
    case "success":
      return c.status.success;
    case "warning":
      return c.status.warning;
    case "error":
      return c.status.error;
    case "info":
      return c.status.info;
    case "onAccent":
      return c.fg.onAccent;
    case "selected":
      return c.state.selectedFg;
  }
}

/** Builds an OpenTUI attribute bit set. */
export function attrs(options: {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  strikethrough?: boolean;
}): number {
  return (
    (options.bold ? TextAttributes.BOLD : 0) |
    (options.italic ? TextAttributes.ITALIC : 0) |
    (options.underline ? TextAttributes.UNDERLINE : 0) |
    (options.dim ? TextAttributes.DIM : 0) |
    (options.strikethrough ? TextAttributes.STRIKETHROUGH : 0)
  );
}

export type TextVariant = "body" | "title" | "secondary" | "hint" | "section";

const VARIANTS: Record<TextVariant, { tone: TextTone; bold?: boolean; upper?: boolean }> = {
  body: { tone: "default" },
  title: { tone: "default", bold: true },
  secondary: { tone: "muted" },
  hint: { tone: "subtle" },
  section: { tone: "muted", bold: true, upper: true },
};

export interface LabelProps {
  children?: ReactNode;
  variant?: TextVariant;
  /** Overrides the variant's tone. */
  tone?: TextTone;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  bg?: RGBA;
  /** Middle-ellipsis when the text does not fit (OpenTUI `truncate`). */
  truncate?: boolean;
  wrap?: boolean;
  align?: "left" | "center" | "right";
  flexGrow?: number;
  flexShrink?: number;
  width?: number | `${number}%` | "auto";
}

/** One run of styled text. Spans and icons may be nested inside. */
export function Label({
  children,
  variant = "body",
  tone,
  bold,
  italic,
  underline,
  bg,
  truncate,
  wrap,
  align,
  flexGrow,
  flexShrink,
  width,
}: LabelProps) {
  const theme = useTheme();
  const spec = VARIANTS[variant];
  const content = spec.upper && typeof children === "string" ? children.toUpperCase() : children;
  return (
    <text
      fg={toneColor(theme, tone ?? spec.tone)}
      bg={bg}
      attributes={attrs({ bold: bold ?? spec.bold, italic, underline })}
      wrapMode={wrap ? "word" : "none"}
      truncate={truncate}
      textAlign={align}
      flexGrow={flexGrow}
      flexShrink={flexShrink ?? (truncate ? 1 : 0)}
      width={width}
      selectable={false}
    >
      {content}
    </text>
  );
}

/** A styled run inside a `<text>` / `Label`. */
export function Span({
  children,
  tone = "default",
  bold,
  italic,
  underline,
  strikethrough,
  bg,
  color,
}: {
  children?: ReactNode;
  tone?: TextTone;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  bg?: RGBA;
  /** An exact token color (git status, file-type icon); prefer `tone`. */
  color?: RGBA;
}) {
  const theme = useTheme();
  return (
    <span
      fg={color ?? toneColor(theme, tone)}
      bg={bg}
      attributes={attrs({ bold, italic, underline, strikethrough })}
    >
      {children}
    </span>
  );
}
