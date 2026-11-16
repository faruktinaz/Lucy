/**
 * Text with matched characters emphasized (fuzzy-match positions from the quick pick or
 * search). Matches use the accent color and bold, so they stand out without a background.
 */
import type { RGBA } from "@opentui/core";
import { useTheme } from "../theme/theme-context";
import { attrs } from "./text";

/** Splits `text` into runs of matched / unmatched characters (positions are UTF-16 indices). */
export function highlightRuns(
  text: string,
  positions: readonly number[] | undefined,
): { text: string; match: boolean }[] {
  if (!positions || positions.length === 0) return text ? [{ text, match: false }] : [];
  const set = new Set(positions);
  const runs: { text: string; match: boolean }[] = [];
  let current = "";
  let currentMatch = false;
  for (let i = 0; i < text.length; i++) {
    const match = set.has(i);
    if (i > 0 && match !== currentMatch) {
      runs.push({ text: current, match: currentMatch });
      current = "";
    }
    currentMatch = match;
    current += text[i];
  }
  if (current) runs.push({ text: current, match: currentMatch });
  return runs;
}

/** Spans for use inside a `<text>`. */
export function HighlightedText({
  text,
  positions,
  color,
  matchColor,
  italic,
}: {
  text: string;
  positions?: readonly number[];
  color: RGBA;
  matchColor?: RGBA;
  italic?: boolean;
}) {
  const theme = useTheme();
  const accent = matchColor ?? theme.colors.accent.primary;
  return (
    <>
      {highlightRuns(text, positions).map((run, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional and never reordered.
          key={i}
          fg={run.match ? accent : color}
          attributes={attrs({ bold: run.match, italic })}
        >
          {run.text}
        </span>
      ))}
    </>
  );
}
