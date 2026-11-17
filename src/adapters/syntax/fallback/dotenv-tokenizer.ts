/**
 * Tokenizer for `.env` files (`.env`, `.env.local`, `.env.example`, `*.env`).
 *
 * These were routed through the Bash grammar, which captures a key as `variable` (painted with
 * the plain foreground in every theme) and an unquoted value as a bare word with no capture, so a
 * typical `KEY=value` file showed only `=` and comments in color. Here keys and `$VAR`/`${VAR}`
 * references are `property`, every value is a string (or a number/boolean when it is one), and
 * quoting follows dotenv: double quotes allow escapes and references and may span lines, single
 * quotes and backticks are literal, and an unquoted value ends at ` #`.
 */
import type { HighlightRange } from "../types";

const KEY = /[A-Za-z_][A-Za-z0-9_.-]*/y;
const REFERENCE = /\$\{[^}\n]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g;
const NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const BOOLEAN = /^(?:true|false|yes|no|on|off)$/i;

function references(text: string, from: number, to: number, out: HighlightRange[]): void {
  const dollar = text.indexOf("$", from);
  if (dollar === -1 || dollar >= to) return;
  // Scan only the value: a search over the rest of the file per line would be quadratic.
  for (const match of text.slice(from, to).matchAll(REFERENCE)) {
    out.push({ start: from + match.index, end: from + match.index + match[0].length, group: "property" });
  }
}

function lineEnd(text: string, from: number): number {
  const newline = text.indexOf("\n", from);
  return newline === -1 ? text.length : newline;
}

function skipBlanks(text: string, from: number, to: number): number {
  let i = from;
  while (i < to && (text[i] === " " || text[i] === "\t" || text[i] === "\r")) i++;
  return i;
}

/** A trailing ` # comment` after a value, if any. */
function trailingComment(text: string, from: number, end: number, out: HighlightRange[]): void {
  const at = skipBlanks(text, from, end);
  if (text[at] === "#") out.push({ start: at, end, group: "comment" });
}

export function tokenizeDotenv(text: string): HighlightRange[] {
  const out: HighlightRange[] = [];
  let i = 0;
  while (i < text.length) {
    let end = lineEnd(text, i);
    let at = skipBlanks(text, i, end);

    if (text[at] === "#") {
      out.push({ start: at, end, group: "comment" });
      i = end + 1;
      continue;
    }
    if (text.startsWith("export", at) && (text[at + 6] === " " || text[at + 6] === "\t")) {
      out.push({ start: at, end: at + 6, group: "keyword" });
      at = skipBlanks(text, at + 6, end);
    }
    KEY.lastIndex = at;
    const key = KEY.exec(text);
    const afterKey = key ? skipBlanks(text, at + key[0].length, end) : at;
    if (!key || text[afterKey] !== "=") {
      i = end + 1;
      continue;
    }
    out.push({ start: at, end: at + key[0].length, group: "property" });
    out.push({ start: afterKey, end: afterKey + 1, group: "operator" });

    const valueStart = skipBlanks(text, afterKey + 1, end);
    const quote = text[valueStart];
    if (quote === '"' || quote === "'" || quote === "`") {
      // Quoted values may continue on the following lines until the closing quote.
      let j = valueStart + 1;
      const inner: HighlightRange[] = [];
      while (j < text.length && text[j] !== quote) {
        if (quote === '"' && text[j] === "\\" && j + 1 < text.length) {
          inner.push({ start: j, end: j + 2, group: "string.escape" });
          j += 2;
          continue;
        }
        j++;
      }
      const close = Math.min(j + 1, text.length);
      out.push({ start: valueStart, end: close, group: "string" });
      if (quote === '"') references(text, valueStart, close, inner);
      inner.sort((a, b) => a.start - b.start);
      for (const range of inner) out.push(range);
      end = lineEnd(text, close);
      trailingComment(text, close, end, out);
    } else {
      // Unquoted: up to an inline comment (` #`) or the end of the line.
      let stop = end;
      for (let k = valueStart; k < end; k++) {
        if (text[k] === "#" && (text[k - 1] === " " || text[k - 1] === "\t")) {
          stop = k;
          break;
        }
      }
      let valueEnd = stop;
      while (valueEnd > valueStart && /\s/.test(text[valueEnd - 1] ?? "")) valueEnd--;
      if (valueEnd > valueStart) {
        const value = text.slice(valueStart, valueEnd);
        const group = NUMBER.test(value) ? "number" : BOOLEAN.test(value) ? "boolean" : "string";
        out.push({ start: valueStart, end: valueEnd, group });
        if (group === "string") references(text, valueStart, valueEnd, out);
      }
      if (stop < end) out.push({ start: stop, end, group: "comment" });
    }
    i = end + 1;
  }
  return out;
}
