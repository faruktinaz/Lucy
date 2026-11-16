/** Helpers shared by the syntax tests. Temp dirs only; everything is removed by `removeTempDirs`. */
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LineToken, type SyntaxTokenName, syntaxGroupToToken } from "../../src/adapters/syntax";

const created: string[] = [];

export function makeTempDir(prefix: string): string {
  // realpath: on macOS tmpdir() is a symlink (/var -> /private/var); compare real paths.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `lucy-syntax-${prefix}-`)));
  created.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Every file and directory below `dir`, relative, sorted. */
export function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push(entry.isDirectory() ? `${rel}/` : rel);
      if (entry.isDirectory()) walk(join(current, entry.name), rel);
    }
  };
  walk(dir, "");
  return out.sort();
}

export interface TokenProbe {
  readonly group: string | null;
  readonly token: SyntaxTokenName | null;
  /** The text the winning token covers on its line. */
  readonly text: string | null;
}

/**
 * The winning token at the first character of the `nth` occurrence of `needle`, as a view built
 * on `tokenizeLines` would color it.
 */
export function probe(content: string, lines: readonly LineToken[][], needle: string, nth = 0): TokenProbe {
  let offset = -1;
  for (let i = 0; i <= nth; i++) {
    offset = content.indexOf(needle, offset + 1);
    if (offset === -1) throw new Error(`needle ${JSON.stringify(needle)} #${nth} not found`);
  }
  const lineIndex = content.slice(0, offset).split("\n").length - 1;
  const lineStart = content.lastIndexOf("\n", offset - 1) + 1;
  const column = offset - lineStart;
  const lineText = content.slice(lineStart).split("\n")[0] ?? "";
  const token = (lines[lineIndex] ?? []).find((t) => t.start <= column && column < t.end);
  if (!token) return { group: null, token: null, text: null };
  return {
    group: token.group,
    token: syntaxGroupToToken(token.group),
    text: lineText.slice(token.start, token.end),
  };
}
