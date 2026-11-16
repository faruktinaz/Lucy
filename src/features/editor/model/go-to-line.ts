/**
 * The "Go to line" prompt: `42`, `42:7`, `:42`, `:42:7` (a comma works like the colon, as in
 * VS Code). Input is 1-based like every editor; the result is 0-based like the rest of the
 * model. Out-of-range numbers are clamped (and flagged) rather than rejected: asking for line
 * 9999 of a 120-line file means "the end".
 */
import { sanitizeForDisplay, truncateEnd } from "@/core/text";

export type GoToLineResult =
  | {
      readonly ok: true;
      /** 0-based line index, clamped to the document. */
      readonly line: number;
      /** 0-based UTF-16 column, clamped to the line when its text is known. */
      readonly column: number;
      /** The typed line or column was outside the document and was moved inside. */
      readonly clamped: boolean;
    }
  | { readonly ok: false; readonly reason: "empty" | "invalid"; readonly message: string };

export interface GoToLineOptions {
  /** Text of a 0-based line, to clamp the column and convert it from characters to UTF-16. */
  readonly lineText?: (line: number) => string;
}

const PATTERN = /^:?\s*(\d+)\s*(?:[:,]\s*(\d+))?$/;

/** Prompt placeholder, e.g. `Go to line 1–120, or line:column`. */
export function goToLinePlaceholder(lineCount: number): string {
  return `Go to line 1–${Math.max(1, lineCount)}, or line:column`;
}

/** 0-based UTF-16 index of the 1-based character column `column` in `text` (clamped to the end). */
function utf16Column(text: string, column: number): { index: number; clamped: boolean } {
  let index = 0;
  for (let char = 1; char < column; char++) {
    if (index >= text.length) return { index: text.length, clamped: true };
    const code = text.charCodeAt(index);
    index += code >= 0xd800 && code <= 0xdbff && index + 1 < text.length ? 2 : 1;
  }
  return { index, clamped: false };
}

function toNumber(digits: string): number {
  // Twenty nines are still "a big number": clamp instead of losing precision or overflowing.
  return digits.length > 15 ? Number.MAX_SAFE_INTEGER : Number.parseInt(digits, 10);
}

export function parseGoToLine(
  input: string,
  lineCount: number,
  options: GoToLineOptions = {},
): GoToLineResult {
  const count = Math.max(1, Math.floor(lineCount));
  const text = input.trim();
  if (text === "" || text === ":") {
    return { ok: false, reason: "empty", message: `Type a line number between 1 and ${count}.` };
  }
  const match = PATTERN.exec(text);
  if (!match) {
    const shown = truncateEnd(sanitizeForDisplay(text), 24);
    return {
      ok: false,
      reason: "invalid",
      message: `"${shown}" is not a line number. Type a number between 1 and ${count}, such as 42 or 42:7.`,
    };
  }
  const requestedLine = toNumber(match[1] as string);
  const line = Math.min(Math.max(requestedLine, 1), count) - 1;
  let clamped = requestedLine < 1 || requestedLine > count;

  let column = 0;
  if (match[2] !== undefined) {
    const requestedColumn = Math.max(1, toNumber(match[2]));
    if (requestedColumn !== toNumber(match[2])) clamped = true;
    if (options.lineText) {
      const converted = utf16Column(options.lineText(line), requestedColumn);
      column = converted.index;
      clamped ||= converted.clamped;
    } else {
      column = Math.min(requestedColumn, Number.MAX_SAFE_INTEGER) - 1;
    }
  }
  return { ok: true, line, column, clamped };
}
