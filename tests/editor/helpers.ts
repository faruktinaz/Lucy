/** Helpers for the editor tests: temp directories (removed after each file) and file writing. */
import { afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SyntaxService } from "@/adapters/syntax";

/** Registers cleanup for the calling test file and returns a temp-dir factory (real paths). */
export function createTempDirs(prefix: string): () => string {
  const created: string[] = [];
  afterAll(() => {
    for (const dir of created) {
      restoreAccess(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
  return () => {
    // realpath: on macOS tmpdir() is a symlink (/var -> /private/var).
    const dir = realpathSync(mkdtempSync(join(tmpdir(), `lucy-editor-${prefix}-`)));
    created.push(dir);
    return dir;
  };
}

/** Tests chmod some entries to 000; give access back so cleanup cannot fail. */
function restoreAccess(dir: string): void {
  try {
    chmodSync(dir, 0o755);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      chmodSync(path, entry.isDirectory() ? 0o755 : 0o644);
      if (entry.isDirectory()) restoreAccess(path);
    }
  } catch {
    // Best effort.
  }
}

export function writeFiles(root: string, files: Record<string, string | Uint8Array>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/** A real SyntaxService; its worker never starts because the loader only asks for facts. */
export function createSyntax(dataDir: string): SyntaxService {
  return new SyntaxService({ dataPath: join(dataDir, "tree-sitter") });
}

/** `count` lines of mixed code-like text with a trailing newline. */
export function generateLines(count: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(
      i % 10 === 0
        ? `// section ${i}: İstanbul ışık şehir`
        : `export const value${i} = computeSomething(${i}, "needle-${i % 7}");`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function ms(start: number): string {
  return `${(performance.now() - start).toFixed(1)} ms`;
}
