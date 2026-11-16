/**
 * Test preload (bunfig.toml `[test] preload`): runs once per `bun test` process, before any
 * test file is loaded.
 *
 * 1. Isolation. Lucy's config, state and cache directories, and XDG_DATA_HOME (where OpenTUI's
 *    Tree-sitter client writes grammars), point into one temporary directory, so no test can
 *    read or write the user's real files. The variables are overwritten even when already set,
 *    because a developer's shell may point them at real directories. HOME, PATH and the other
 *    XDG variables are deliberately left alone: Git and other tools read their own
 *    configuration through them, and tests that run those tools must keep working.
 * 2. Cleanup. Any TUI mounted with `tests/helpers/tui.tsx` and still alive after a test is
 *    disposed, so a failing test never leaks a renderer into the next one.
 */
import { afterAll, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "lucy-test-"));

const isolated = {
  XDG_DATA_HOME: "data",
  LUCY_CONFIG_DIR: "config",
  LUCY_STATE_DIR: "state",
  LUCY_CACHE_DIR: "cache",
} as const;

for (const [variable, name] of Object.entries(isolated)) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  process.env[variable] = dir;
}
process.env.LUCY_TEST_ROOT = root;

function removeRoot(): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Best effort: the OS temp directory is cleaned eventually anyway.
  }
}

// `bun test` never fires `process.on("exit")` (verified on Bun 1.3.14), so the root leaked on
// every run. A preload-level `afterAll` runs exactly once, after the last test file. The exit
// handler stays for the case where this file is loaded outside the test runner.
afterAll(removeRoot);
process.on("exit", removeRoot);

// Must match the key in tests/helpers/tui.tsx. Looked up lazily so this preload never loads OpenTUI.
const LIVE_KEY = Symbol.for("lucy.tests.liveTuis");

afterEach(async () => {
  const live = (globalThis as unknown as Record<symbol, Set<() => Promise<void>> | undefined>)[LIVE_KEY];
  if (!live || live.size === 0) return;
  for (const dispose of [...live]) await dispose();
});
