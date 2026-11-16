/**
 * A thin vertical scrollbar: only the thumb is drawn (a one-eighth block in the thumb
 * color), so it reads as a position marker rather than a heavy track. Absolutely positioned
 * over the last column of its parent, which is padding in every list.
 */
import { useTheme } from "../theme/theme-context";

export const SCROLLBAR_GLYPH = "▕";

/** Thumb position and length in rows. */
export function scrollbarThumb(
  total: number,
  visible: number,
  offset: number,
  height: number,
): { start: number; size: number } {
  if (total <= visible || height <= 0) return { start: 0, size: 0 };
  const size = Math.max(1, Math.min(height, Math.round((height * visible) / total)));
  const maxOffset = total - visible;
  const start = Math.round(((height - size) * Math.min(offset, maxOffset)) / maxOffset);
  return { start, size };
}

export function Scrollbar({
  total,
  visible,
  offset,
  height,
}: {
  total: number;
  visible: number;
  offset: number;
  height: number;
}) {
  const theme = useTheme();
  const thumb = scrollbarThumb(total, visible, offset, height);
  if (thumb.size === 0) return null;
  const rows: string[] = [];
  for (let row = 0; row < height; row++)
    rows.push(row >= thumb.start && row < thumb.start + thumb.size ? SCROLLBAR_GLYPH : " ");
  return (
    <box position="absolute" right={0} top={0} width={1} height={height} zIndex={2}>
      <text fg={theme.colors.scrollbar.thumb} selectable={false}>
        {rows.join("\n")}
      </text>
    </box>
  );
}
