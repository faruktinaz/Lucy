/**
 * Quick Open input parsing: `file.ts:42` and `file.ts:42:7` jump to a line (and column).
 */

export interface QuickOpenQuery {
  /** The part to fuzzy-match ("" for a bare ":42", meaning "go to line in the current file"). */
  readonly query: string;
  /** 1-based line, when a valid ":<line>" suffix is present. */
  readonly line?: number;
  /** 1-based column, when a valid ":<line>:<column>" suffix is present. */
  readonly column?: number;
}

const SUFFIX = /^(.*?):(\d+)(?::(\d*))?:?$/;

export function parseQuickOpenQuery(input: string): QuickOpenQuery {
  const trimmed = input.trim();
  const match = SUFFIX.exec(trimmed);
  if (match) {
    const line = Number.parseInt(match[2] as string, 10);
    const column = match[3] ? Number.parseInt(match[3], 10) : undefined;
    if (line >= 1 && Number.isSafeInteger(line)) {
      const query = (match[1] as string).trim();
      return column !== undefined && column >= 1 && Number.isSafeInteger(column)
        ? { query, line, column }
        : { query, line };
    }
  }
  // A trailing ":" means the user is about to type a line number: do not match on it.
  if (trimmed.endsWith(":")) return { query: trimmed.slice(0, -1).trimEnd() };
  return { query: trimmed };
}
