/**
 * Line tokenizer for INI-style configuration: `.ini`, `.cfg`, `.properties`, `.editorconfig`,
 * `.gitconfig`, `.npmrc`. These dialects disagree on details (inline comments, `:` versus `=`),
 * so this only claims what they share: comment lines, `[section]` headers and `key = value`
 * pairs. Groups match nvim-treesitter's INI query.
 */
import type { HighlightRange } from "../types";

const BOOLEAN = /^(true|false|yes|no|on|off)$/i;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;

function pushValue(out: HighlightRange[], line: string, offset: number, from: number, to: number): void {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(line[start] ?? "")) start++;
  while (end > start && /\s/.test(line[end - 1] ?? "")) end--;
  if (start >= end) return;
  const value = line.slice(start, end);
  const group = BOOLEAN.test(value) ? "boolean" : NUMBER.test(value) ? "number" : "string";
  out.push({ start: offset + start, end: offset + end, group });
  // References such as `${base}/bin` (properties, EditorConfig-style tools) and `%(name)s` (Python configparser).
  for (const match of value.matchAll(/\$\{[^}\n]+\}|%\([^)\n]+\)[sdif]?/g)) {
    out.push({
      start: offset + start + match.index,
      end: offset + start + match.index + match[0].length,
      group: "property",
    });
  }
}

/** Index of an inline comment (` #` or ` ;` outside quotes), or -1. */
function inlineCommentStart(line: string, from: number): number {
  let quote = "";
  for (let i = from; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if ((char === "#" || char === ";") && (i === from || /\s/.test(line[i - 1] ?? ""))) {
      return i;
    }
  }
  return -1;
}

export function tokenizeConf(text: string): HighlightRange[] {
  const out: HighlightRange[] = [];
  let offset = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const indent = line.length - line.trimStart().length;
    const first = line[indent];

    // `!` starts a comment in Java .properties files.
    if (first === "#" || first === ";" || first === "!") {
      out.push({ start: offset + indent, end: offset + line.length, group: "comment" });
    } else if (first === "[") {
      const close = line.indexOf("]", indent);
      if (close !== -1) {
        out.push({ start: offset + indent, end: offset + indent + 1, group: "punctuation.bracket" });
        if (close > indent + 1) out.push({ start: offset + indent + 1, end: offset + close, group: "type" });
        out.push({ start: offset + close, end: offset + close + 1, group: "punctuation.bracket" });
        const comment = inlineCommentStart(line, close + 1);
        if (comment !== -1)
          out.push({ start: offset + comment, end: offset + line.length, group: "comment" });
      }
    } else if (first !== undefined) {
      const separator = line.slice(indent).search(/[=:]/);
      if (separator > 0) {
        const at = indent + separator;
        let keyEnd = at;
        while (keyEnd > indent && /\s/.test(line[keyEnd - 1] ?? "")) keyEnd--;
        out.push({ start: offset + indent, end: offset + keyEnd, group: "property" });
        out.push({ start: offset + at, end: offset + at + 1, group: "operator" });
        const comment = inlineCommentStart(line, at + 1);
        pushValue(out, line, offset, at + 1, comment === -1 ? line.length : comment);
        if (comment !== -1)
          out.push({ start: offset + comment, end: offset + line.length, group: "comment" });
      }
    }
    offset += rawLine.length + 1;
  }
  return out;
}
