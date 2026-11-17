/**
 * A folder holding several repositories, through the whole app: the explorer shows each
 * nested repository's own Git letters, and a commit made inside a nested repository (by a
 * terminal or a coding agent, outside Lucy) refreshes that repository through the watcher.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WatchFactory } from "@/adapters/filesystem";
import { explorerControllerFor } from "@/features/explorer";
import { type MountedApp, mountApp } from "../helpers/app";
import { createFixtureRepo, createTempDir, type FixtureRepo } from "../helpers/git-fixture";

setDefaultTimeout(30_000);

async function until(app: MountedApp, label: string, predicate: () => boolean, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${label}:\n${app.tui.frame()}`);
    await app.tui.advance(50);
  }
}

/** A committed repository at `dir` with one file, using the isolated Git environment. */
async function repositoryAt(git: FixtureRepo, dir: string, file: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), "first\n");
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "-A"],
    ["commit", "-q", "-m", "Initial"],
  ]) {
    const result = await git.gitRaw(args, { cwd: dir });
    if (result.code !== 0) throw new Error(result.stderr);
  }
}

/** A row ends with the Git letter M (a selected row adds its pill edge `▌` after it). */
const MODIFIED = /\sM[^A-Za-z]*$/;

/** The explorer row of a file (its name and, at the right, its Git letter). */
function row(app: MountedApp, name: string): string {
  return (
    app.tui
      .frame()
      .split("\n")
      .find((line) => line.slice(0, 40).includes(name))
      ?.slice(0, 40) ?? ""
  );
}

/** A `fs.watch` stand-in whose events the test emits (workspace-relative paths). */
function fakeWatcher(): { factory: WatchFactory; emit(path: string): void } {
  const listeners: ((event: string, filename: string | null) => void)[] = [];
  return {
    factory: (_path, listener) => {
      listeners.push(listener);
      return { close: () => {}, on: () => undefined };
    },
    emit: (path) => {
      for (const listener of listeners) listener("change", path);
    },
  };
}

describe("a workspace with nested repositories", () => {
  test("explorer letters come from each repository; a commit inside one refreshes it", async () => {
    const workspace = createTempDir("lucy-multi-");
    // Only for its isolated Git environment (no user configuration).
    const isolation = await createFixtureRepo({ init: false });
    try {
      await repositoryAt(isolation, join(workspace.path, "api"), "server.ts");
      await repositoryAt(isolation, join(workspace.path, "web"), "page.html");
      writeFileSync(join(workspace.path, "api", "server.ts"), "changed\n");
      writeFileSync(join(workspace.path, "web", "page.html"), "changed\n");

      const fake = fakeWatcher();
      const app = await mountApp({
        width: 120,
        height: 35,
        workspace: { root: workspace.path },
        git: "real",
        gitEnv: isolation.env,
        startBackground: true,
        settings: { "workspace.watch": true },
        watchFactory: fake.factory,
      });
      const controller = explorerControllerFor(app.ctx);
      if (!controller) throw new Error("The explorer feature did not activate");
      await app.tui.act(() => app.ctx.commands.execute("view.showExplorer"));
      await app.tui.act(() => controller.load());
      await app.tui.act(() => controller.model.reveal("api/server.ts"));
      await app.tui.act(() => controller.model.reveal("web/page.html"));

      // The workspace is not a repository: these letters can only come from `api` and `web`.
      await until(app, "letters from both nested repositories", () => {
        return MODIFIED.test(row(app, "server.ts")) && MODIFIED.test(row(app, "page.html"));
      });

      // A commit inside `web` made outside Lucy. The watcher reports the paths Git touched
      // (injected, because macOS FSEvents occasionally drops a burst in a busy test run): the
      // `web/.git` metadata must refresh `web`, so its letter goes away; `api` keeps its change.
      const commit = await isolation.gitRaw(["commit", "-q", "-am", "Change"], {
        cwd: join(workspace.path, "web"),
      });
      expect(commit.code).toBe(0);
      for (const path of ["web/.git/objects/ab/cdef", "web/.git/index.lock", "web/.git/refs/heads/main"]) {
        fake.emit(path);
      }
      await until(app, "web refreshed after the commit", () => !MODIFIED.test(row(app, "page.html")));
      expect(row(app, "server.ts")).toMatch(MODIFIED);
      await app.dispose();
    } finally {
      isolation.dispose();
      workspace.dispose();
    }
  });
});
