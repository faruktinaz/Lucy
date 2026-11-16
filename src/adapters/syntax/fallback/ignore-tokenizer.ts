/**
 * Line tokenizer for gitignore-style pattern files (`.gitignore`, `.dockerignore`, ...) and
 * `.gitattributes`: comments, the `!` negation, glob wildcards, backslash escapes, and the
 * attributes that follow a pattern in `.gitattributes`.
 */
import type { HighlightRange } from "../types";

export function tokenizeIgnore(text: string): HighlightRange[] {
  const out: HighlightRange[] = [];
  let offset = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("#")) {
      out.push({ start: offset, end: offset + line.length, group: "comment" });
    } else {
      let i = 0;
      if (line.startsWith("!")) {
        out.push({ start: offset, end: offset + 1, group: "operator" });
        i = 1;
      }
      let inPattern = true;
      while (i < line.length) {
        const char = line[i];
        if (char === "\\" && i + 1 < line.length) {
          out.push({ start: offset + i, end: offset + i + 2, group: "string.escape" });
          i += 2;
          continue;
        }
        if (char === " " || char === "\t") {
          inPattern = false;
          i++;
          continue;
        }
        if (!inPattern) {
          // `.gitattributes`: everything after the pattern is an attribute list.
          const end = line.slice(i).search(/\s/);
          const stop = end === -1 ? line.length : i + end;
          out.push({ start: offset + i, end: offset + stop, group: "attribute" });
          i = stop;
          continue;
        }
        if (char === "*" || char === "?") {
          out.push({ start: offset + i, end: offset + i + 1, group: "operator" });
        } else if (char === "[") {
          const close = line.indexOf("]", i + 1);
          if (close !== -1) {
            out.push({ start: offset + i, end: offset + close + 1, group: "string.regexp" });
            i = close + 1;
            continue;
          }
        }
        i++;
      }
    }
    offset += rawLine.length + 1;
  }
  return out;
}
