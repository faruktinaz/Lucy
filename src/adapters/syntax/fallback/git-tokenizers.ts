/**
 * Git's own text files: commit messages (`COMMIT_EDITMSG`, `MERGE_MSG`, `TAG_EDITMSG`) and the
 * interactive rebase list (`git-rebase-todo`).
 */
import type { HighlightRange } from "../types";
import { tokenizeDiffInto } from "./diff-tokenizer";

const SCISSORS = /^# -+ >8 -+\s*$/;
const CONVENTIONAL = /^([a-z]+)(\([^)\n]*\))?(!)?:/d;
const TRAILER = /^([A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*):\s/;
const REFERENCE = /(?<![\w&])#\d+\b|https?:\/\/[^\s<>)]+/g;

function references(line: string, offset: number, out: HighlightRange[]): void {
  for (const match of line.matchAll(REFERENCE)) {
    const group = match[0].startsWith("#") ? "constant" : "string.special.url";
    out.push({ start: offset + match.index, end: offset + match.index + match[0].length, group });
  }
}

/**
 * Subject line as a heading (with a Conventional Commits type), `#` comments, trailers such as
 * `Signed-off-by:`, issue references and URLs. Everything below the scissors line of
 * `git commit -v` is the diff being committed.
 */
export function tokenizeGitCommit(text: string): HighlightRange[] {
  const out: HighlightRange[] = [];
  let offset = 0;
  let subjectSeen = false;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(offset, lineEnd).replace(/\r$/, "");
    if (SCISSORS.test(line)) {
      out.push({ start: offset, end: offset + line.length, group: "comment" });
      tokenizeDiffInto(text, lineEnd + 1, text.length, out);
      return out;
    }
    if (line.startsWith("#")) {
      out.push({ start: offset, end: offset + line.length, group: "comment" });
    } else if (!subjectSeen && line.trim().length > 0) {
      subjectSeen = true;
      const conventional = CONVENTIONAL.exec(line);
      const indices = conventional?.indices;
      // The heading starts after a `type(scope)!:` prefix so the prefix keeps its own colors.
      const headingStart = indices?.[0]?.[1] ?? 0;
      out.push({ start: offset + headingStart, end: offset + line.length, group: "markup.heading" });
      if (indices?.[1]) out.push({ start: offset, end: offset + indices[1][1], group: "keyword" });
      if (indices?.[2])
        out.push({ start: offset + indices[2][0], end: offset + indices[2][1], group: "type" });
      if (indices?.[3])
        out.push({ start: offset + indices[3][0], end: offset + indices[3][1], group: "operator" });
      references(line, offset, out);
    } else {
      const trailer = TRAILER.exec(line);
      if (trailer?.[1]) out.push({ start: offset, end: offset + trailer[1].length, group: "property" });
      references(line, offset, out);
    }
    offset = lineEnd + 1;
  }
  return out;
}

const REBASE_COMMANDS = new Set([
  "pick",
  "p",
  "reword",
  "r",
  "edit",
  "e",
  "squash",
  "s",
  "fixup",
  "f",
  "exec",
  "x",
  "break",
  "b",
  "drop",
  "d",
  "label",
  "l",
  "reset",
  "t",
  "merge",
  "m",
  "update-ref",
  "u",
]);

/** `pick 1a2b3c4 subject`: the command, the commit hash, and `#` comments. */
export function tokenizeGitRebase(text: string): HighlightRange[] {
  const out: HighlightRange[] = [];
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(offset, lineEnd).replace(/\r$/, "");
    if (line.startsWith("#")) {
      out.push({ start: offset, end: offset + line.length, group: "comment" });
    } else {
      const match = /^(\S+)(?:\s+(-[cC]\s+)?([0-9a-f]{4,64})\b)?/.exec(line);
      const command = match?.[1];
      if (command && REBASE_COMMANDS.has(command)) {
        out.push({ start: offset, end: offset + command.length, group: "keyword" });
        const hash = match?.[3];
        if (hash) {
          const at = line.indexOf(hash, command.length);
          out.push({ start: offset + at, end: offset + at + hash.length, group: "constant" });
        }
      }
    }
    offset = lineEnd + 1;
  }
  return out;
}
