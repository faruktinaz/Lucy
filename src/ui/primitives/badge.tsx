/**
 * Count badges. Two forms: `Badge` is a small filled pill for counts that need attention
 * (rarely used); `CountLabel` is a quiet number for headers and the activity bar, where a
 * filled block would be noise.
 */
import { useTheme } from "../theme/theme-context";
import { CapSpan } from "./shape";
import { Span, type TextTone } from "./text";

/** Formats a count to at most `width` cells (`1.2k`, `99+`). */
export function formatCount(count: number, width = 3): string {
  if (count < 0) return "0";
  const plain = String(count);
  if (plain.length <= width) return plain;
  if (width >= 4 && count < 1_000_000) return `${Math.floor(count / 1000)}k`;
  return `${"9".repeat(Math.max(1, width - 1))}+`;
}

export function Badge({ count, width = 3 }: { count: number; width?: number }) {
  const theme = useTheme();
  if (count <= 0) return null;
  return (
    <>
      <CapSpan side="left" color={theme.colors.badge.bg} />
      <Span color={theme.colors.badge.fg} bg={theme.colors.badge.bg} bold>
        {formatCount(count, width)}
      </Span>
      <CapSpan side="right" color={theme.colors.badge.bg} />
    </>
  );
}

export function CountLabel({
  count,
  tone = "muted",
  width = 3,
}: {
  count: number;
  tone?: TextTone;
  width?: number;
}) {
  if (count <= 0) return null;
  return <Span tone={tone}>{formatCount(count, width)}</Span>;
}
