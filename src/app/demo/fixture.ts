/**
 * Reading and copying the demo fixture in `examples/demo-project`.
 */
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { LucyError } from "../../core/errors";

/** Location of the fixture in a source checkout. */
export const DEFAULT_FIXTURE_DIR = resolve(import.meta.dir, "../../../examples/demo-project");

/**
 * Files stored under a neutral name because their real name would change the behaviour
 * of the outer Lucy repository: a nested `.gitignore` would hide fixture files from it, and
 * a `*.test.ts` file would be collected by Lucy's own `bun test` run.
 */
export const FIXTURE_RENAMES: Readonly<Record<string, string>> = {
  _gitignore: ".gitignore",
  "tests/task-store.test.ts.fixture": "tests/task-store.test.ts",
};

/** Operating-system litter that must never reach the demo, or the tree would differ per machine. */
const SKIPPED_NAMES = new Set([".DS_Store", "Thumbs.db"]);

/** Path of a demo file inside the fixture directory, undoing the renames above. */
export function fixtureSourcePath(relativePath: string): string {
  for (const [stored, real] of Object.entries(FIXTURE_RENAMES)) {
    if (real === relativePath) return stored;
  }
  return relativePath;
}

function isExecutableInDemo(relativePath: string): boolean {
  return relativePath.startsWith("scripts/") && relativePath.endsWith(".sh");
}

/** Relative POSIX paths of every fixture file, as they appear in the demo (after renames), sorted. */
export function listFixtureFiles(fixtureDir: string = DEFAULT_FIXTURE_DIR): string[] {
  const files: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIPPED_NAMES.has(name)) continue;
      const source = join(dir, name);
      const relative = prefix + name;
      const stat = lstatSync(source);
      if (stat.isSymbolicLink()) {
        // A symlink could point anywhere on the machine; the fixture must be self-contained.
        throw new LucyError("INVALID_ARGUMENT", `The demo fixture must not contain symlinks: ${relative}`);
      }
      if (stat.isDirectory()) walk(source, `${relative}/`);
      else if (stat.isFile()) files.push(FIXTURE_RENAMES[relative] ?? relative);
    }
  };
  walk(fixtureDir, "");
  return files.sort();
}

/**
 * Copies the fixture into `targetDir`, applying renames and normalising permissions.
 * Modes are set explicitly because Git records the executable bit, and a checkout of the
 * outer repository may not preserve it; commit hashes would then differ between machines.
 */
export function copyFixture(fixtureDir: string, targetDir: string): void {
  for (const relative of listFixtureFiles(fixtureDir)) {
    const source = join(fixtureDir, fixtureSourcePath(relative));
    const target = join(targetDir, relative);
    mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o755 });
    copyFileSync(source, target);
    chmodSync(target, isExecutableInDemo(relative) ? 0o755 : 0o644);
  }
}
