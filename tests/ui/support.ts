/**
 * Shared helpers for UI tests: a workspace with a stable name and content, frame
 * normalization for snapshots, and color assertions on captured spans.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CapturedFrame, RGBA } from "@opentui/core";

/** A workspace folder named `atlas` with a few files, at a fresh temporary location. */
export function stableWorkspace(files: Readonly<Record<string, string>> = DEFAULT_FILES): string {
  const parent = mkdtempSync(join(process.env.LUCY_TEST_ROOT ?? tmpdir(), "ws-"));
  const root = join(parent, "atlas");
  mkdirSync(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

export const DEFAULT_FILES: Readonly<Record<string, string>> = {
  "README.md": "# Atlas\n",
  "src/main.ts": "export const main = () => 42;\n",
  "src/features/çalışma.ts": "export {};\n",
  "package.json": '{ "name": "atlas" }\n',
};

/** Replaces the temporary workspace path (shown on the Welcome view) with a placeholder. */
export function normalizeFrame(frame: string): string {
  return frame.replace(/\S*atlas(?=\s)/g, (match) => (match === "atlas" ? match : "<workspace>"));
}

/** The colors of the cell at (x, y) in a captured frame. */
export function cellAt(frame: CapturedFrame, x: number, y: number): { char: string; fg: RGBA; bg: RGBA } {
  const line = frame.lines[y];
  if (!line) throw new Error(`No row ${y}`);
  let column = 0;
  for (const span of line.spans) {
    const chars = [...span.text];
    for (const char of chars) {
      const width = Bun.stringWidth(char) || 1;
      if (x >= column && x < column + width) return { char, fg: span.fg, bg: span.bg };
      column += width;
    }
  }
  throw new Error(`No cell at ${x},${y}`);
}

export function hexOf(color: RGBA): string {
  const [r, g, b] = color.toInts();
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
