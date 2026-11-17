/**
 * XML and XML-like markup (`.xml`, `.svg`, `.plist`, `.xsd`, project files). The HTML grammar
 * handles tags but not `<?xml ?>` declarations, CDATA sections or namespaced names, so XML gets this
 * small tokenizer instead. Groups match the HTML query, so both look the same.
 */
import type { HighlightRange } from "../types";

const NAME = /[\p{L}_:][\p{L}\p{N}_:.-]*/uy;

export function tokenizeMarkup(text: string): HighlightRange[] {
  const out: HighlightRange[] = [];
  let i = 0;
  const push = (start: number, end: number, group: string): void => {
    if (end > start) out.push({ start, end, group });
  };
  const until = (marker: string, from: number): number => {
    const at = text.indexOf(marker, from);
    return at === -1 ? text.length : at + marker.length;
  };

  // Cached so documents without entities do not rescan to the end for every tag.
  let amp = -2;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (amp !== -1 && amp < i) amp = text.indexOf("&", i);
    if (amp !== -1 && (lt === -1 || amp < lt)) {
      const entity = /&(?:#\d+|#x[\da-fA-F]+|[A-Za-z][\w.-]*);/y;
      entity.lastIndex = amp;
      const match = entity.exec(text);
      if (match) push(amp, amp + match[0].length, "character.special");
      i = amp + (match ? match[0].length : 1);
      continue;
    }
    if (lt === -1) break;
    i = lt;
    if (text.startsWith("<!--", i)) {
      const end = until("-->", i + 4);
      push(i, end, "comment");
      i = end;
      continue;
    }
    if (text.startsWith("<![CDATA[", i)) {
      const end = until("]]>", i + 9);
      push(i, i + 9, "tag.delimiter");
      push(i + 9, Math.max(i + 9, end - 3), "string");
      push(Math.max(i + 9, end - 3), end, "tag.delimiter");
      i = end;
      continue;
    }
    if (text.startsWith("<?", i) || text.startsWith("<!", i)) {
      // Declarations and processing instructions: `<?xml version="1.0"?>`, `<!DOCTYPE …>`.
      const close = text.startsWith("<?", i) ? "?>" : ">";
      const end = until(close, i + 2);
      // One segment, so the attribute names and values inside win the overlap.
      push(i, end, "keyword");
      const attrs = /([\p{L}_][\p{L}\p{N}_:.-]*)\s*=\s*("[^"]*"|'[^']*')/gu;
      for (const match of text.slice(i, end).matchAll(attrs)) {
        const name = match[1] ?? "";
        const value = match[2] ?? "";
        const at = i + match.index;
        push(at, at + name.length, "tag.attribute");
        const valueAt = at + match[0].length - value.length;
        push(valueAt, valueAt + value.length, "string");
      }
      i = end;
      continue;
    }
    // A tag: `<name attr="v">`, `</name>`, `<name/>`.
    const closing = text[i + 1] === "/";
    const nameStart = i + (closing ? 2 : 1);
    NAME.lastIndex = nameStart;
    const name = NAME.exec(text);
    if (!name) {
      i++;
      continue;
    }
    push(i, nameStart, "tag.delimiter");
    push(nameStart, nameStart + name[0].length, "tag");
    let j = nameStart + name[0].length;
    while (j < text.length && text[j] !== ">") {
      const char = text[j] ?? "";
      if (char === "/" && text[j + 1] === ">") break;
      if (char === '"' || char === "'") {
        const end = until(char, j + 1);
        push(j, end, "string");
        j = end;
        continue;
      }
      if (char === "=") {
        push(j, j + 1, "operator");
        j++;
        continue;
      }
      NAME.lastIndex = j;
      const attribute = NAME.exec(text);
      if (attribute) {
        push(j, j + attribute[0].length, "tag.attribute");
        j += attribute[0].length;
        continue;
      }
      if (char === "<") break;
      j++;
    }
    if (text.startsWith("/>", j)) {
      push(j, j + 2, "tag.delimiter");
      i = j + 2;
    } else if (text[j] === ">") {
      push(j, j + 1, "tag.delimiter");
      i = j + 1;
    } else {
      i = j;
    }
  }
  return out;
}
