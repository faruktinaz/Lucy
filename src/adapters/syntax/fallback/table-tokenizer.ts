/**
 * CSV and TSV: each column gets its own color, cycling through six groups, so a wide table can
 * be read column by column. Quoted fields follow RFC 4180 (`""` escapes, embedded separators
 * and line breaks). A CSV whose first line has more `;` than `,` is read as semicolon-separated.
 */
import type { HighlightRange } from "../types";

const COLUMN_GROUPS = ["function", "string", "constant", "type", "property", "keyword"] as const;

function detectSeparator(text: string): string {
  const firstLine = text.slice(0, Math.max(0, text.indexOf("\n")) || text.length);
  let commas = 0;
  let semicolons = 0;
  for (const char of firstLine) {
    if (char === ",") commas++;
    else if (char === ";") semicolons++;
  }
  return semicolons > commas ? ";" : ",";
}

function tokenizeTable(text: string, separator: string): HighlightRange[] {
  const out: HighlightRange[] = [];
  let column = 0;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === "\n") {
      column = 0;
      i++;
      continue;
    }
    if (char === separator) {
      out.push({ start: i, end: i + 1, group: "punctuation.delimiter" });
      column++;
      i++;
      continue;
    }
    const start = i;
    if (char === '"') {
      i++;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
    }
    while (i < text.length && text[i] !== separator && text[i] !== "\n") i++;
    let end = i;
    if (text[end - 1] === "\r") end--;
    if (end > start)
      out.push({ start, end, group: COLUMN_GROUPS[column % COLUMN_GROUPS.length] ?? "string" });
  }
  return out;
}

export function tokenizeCsv(text: string): HighlightRange[] {
  return tokenizeTable(text, detectSeparator(text));
}

export function tokenizeTsv(text: string): HighlightRange[] {
  return tokenizeTable(text, "\t");
}
