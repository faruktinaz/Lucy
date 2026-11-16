/**
 * The document as viewer lines: split on LF, a CR before the LF dropped, and no extra empty
 * line after a final newline. Indices match `TextDocument.lineCount` and the viewer's active
 * line; columns are UTF-16 offsets into these strings.
 */
import type { TextDocument } from "./document-types";

export function splitLines(content: string): string[] {
  if (content === "") return [""];
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.endsWith("\r")) lines[i] = line.slice(0, -1);
  }
  return lines;
}

const cache = new WeakMap<TextDocument, readonly string[]>();

/** Memoized per document object (documents are immutable; a reload creates a new one). */
export function documentLines(document: TextDocument): readonly string[] {
  let lines = cache.get(document);
  if (!lines) {
    lines = Object.freeze(splitLines(document.content));
    cache.set(document, lines);
  }
  return lines;
}
