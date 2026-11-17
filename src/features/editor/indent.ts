/**
 * Indentation for the editor: the file's own style when it has one (tabs, or the most common
 * space step), otherwise `editor.tab_width` spaces.
 */

export interface IndentStyle {
  /** One level: "\t" or N spaces. */
  readonly unit: string;
}

/** Looks at up to the first 2,000 indented lines; ties and empty files fall back to spaces. */
export function detectIndent(lines: readonly string[], tabWidth: number): IndentStyle {
  let tabs = 0;
  let spaces = 0;
  const steps = new Map<number, number>();
  let previous = 0;
  let seen = 0;
  for (const line of lines) {
    if (seen >= 2000) break;
    if (line.trim() === "") continue;
    if (line.startsWith("\t")) {
      tabs++;
      seen++;
      continue;
    }
    const width = line.length - line.trimStart().length;
    if (width > 0) {
      spaces++;
      seen++;
    }
    const step = Math.abs(width - previous);
    if (step >= 2 && step <= 8) steps.set(step, (steps.get(step) ?? 0) + 1);
    previous = width;
  }
  if (tabs > spaces) return { unit: "\t" };
  let best = 0;
  let bestCount = 0;
  for (const [step, count] of steps) {
    if (count > bestCount || (count === bestCount && step < best)) {
      best = step;
      bestCount = count;
    }
  }
  return { unit: " ".repeat(spaces > 0 && best > 0 ? best : Math.max(1, tabWidth)) };
}

/** The leading whitespace of a line (kept on Enter). */
export function leadingWhitespace(line: string): string {
  const match = /^[\t ]*/.exec(line);
  return match ? match[0] : "";
}

/** One level less indentation, or the line unchanged: how many characters to remove at its start. */
export function outdentLength(line: string, unit: string): number {
  if (line.startsWith("\t")) return 1;
  if (unit === "\t") {
    let count = 0;
    while (count < line.length && count < 8 && line[count] === " ") count++;
    return count;
  }
  let count = 0;
  while (count < unit.length && line[count] === " ") count++;
  return count;
}
