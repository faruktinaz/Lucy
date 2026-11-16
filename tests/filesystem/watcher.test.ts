import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  classifyGitPath,
  type WatchBatch,
  Watcher,
  type WatchFactory,
  type WatchHandle,
} from "@/adapters/filesystem/watcher";
import type { LucyError } from "@/core/errors";
import { createTempDirs, waitFor } from "./helpers";

const tempDir = createTempDirs("lucy-watch-");

function collect(watcher: Watcher): { batches: WatchBatch[]; paths: () => Set<string> } {
  const batches: WatchBatch[] = [];
  watcher.onDidChange((batch) => batches.push(batch));
  return { batches, paths: () => new Set(batches.flatMap((batch) => batch.paths)) };
}

/** Lets the OS stream settle so events from setup do not leak into the next step. */
async function settle(): Promise<void> {
  await Bun.sleep(250);
}

class FakeHandle implements WatchHandle {
  closed = false;
  private errorListener: ((error: Error) => void) | null = null;
  close(): void {
    this.closed = true;
  }
  on(_event: "error", listener: (error: Error) => void): this {
    this.errorListener = listener;
    return this;
  }
  fail(error: Error): void {
    this.errorListener?.(error);
  }
}

function fakeFactory(): {
  factory: WatchFactory;
  emit: (filename: string | null) => void;
  handles: FakeHandle[];
  calls: () => number;
} {
  const listeners: Array<(event: string, filename: string | null) => void> = [];
  const handles: FakeHandle[] = [];
  return {
    factory: (_path, listener) => {
      listeners.push(listener);
      const handle = new FakeHandle();
      handles.push(handle);
      return handle;
    },
    emit: (filename) => {
      for (const listener of listeners) listener("rename", filename);
    },
    handles,
    calls: () => handles.length,
  };
}

describe("Watcher on the real filesystem (Bun fs.watch)", () => {
  test("reports create, modify, delete, rename and Turkish names as workspace-relative paths", async () => {
    const root = await tempDir();
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "existing.txt"), "1");
    await settle();
    const watcher = new Watcher({ root, debounceMs: 50 });
    const { batches, paths } = collect(watcher);
    expect(watcher.state).toBe("watching");
    await settle();

    await writeFile(join(root, "created.txt"), "x");
    await waitFor(() => paths().has("created.txt"));

    await appendFile(join(root, "existing.txt"), "2");
    await waitFor(() => paths().has("existing.txt"));

    await writeFile(join(root, "sub", "ığüşöç İstanbul.txt"), "x");
    await waitFor(() => paths().has("sub/ığüşöç İstanbul.txt"));

    await rename(join(root, "created.txt"), join(root, "sub", "renamed.txt"));
    // Bun 1.3.14 on macOS reports the rename by its source path (the destination is not
    // reported); FileTree compensates. Accept either so the test also holds elsewhere.
    const before = batches.length;
    await waitFor(() => batches.length > before);
    const renameBatch = new Set(batches.slice(before).flatMap((batch) => batch.paths));
    expect(renameBatch.has("created.txt") || renameBatch.has("sub/renamed.txt")).toBe(true);

    await rm(join(root, "existing.txt"));
    const beforeDelete = batches.length;
    await waitFor(() => batches.slice(beforeDelete).some((batch) => batch.paths.includes("existing.txt")));

    expect(batches.every((batch) => !batch.overflow)).toBe(true);
    expect([...paths()].every((path) => !path.startsWith("/"))).toBe(true);
    watcher.dispose();
    expect(watcher.state).toBe("disposed");
  });

  test("filters .git out of paths and flags Git metadata changes, ignoring objects and lock churn", async () => {
    const root = await tempDir();
    await mkdir(join(root, ".git", "refs", "heads"), { recursive: true });
    await mkdir(join(root, ".git", "objects", "ab"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(root, ".git", "index"), "v1");
    await settle();
    const watcher = new Watcher({ root, debounceMs: 50 });
    const { batches } = collect(watcher);
    await settle();

    await writeFile(join(root, ".git", "objects", "ab", "cdef"), "blob");
    await writeFile(join(root, ".git", "index.lock"), "pending");
    await rm(join(root, ".git", "index.lock")); // Lock taken and released: index unchanged.
    await Bun.sleep(600);
    expect(batches.filter((batch) => batch.gitMetaChanged)).toEqual([]);
    expect(batches.flatMap((batch) => batch.paths).filter((path) => path.includes(".git"))).toEqual([]);

    // Git's atomic index update: write the lock, rename it over the index.
    await writeFile(join(root, ".git", "index.lock"), "v2-longer");
    await rename(join(root, ".git", "index.lock"), join(root, ".git", "index"));
    await waitFor(() => batches.some((batch) => batch.gitMetaChanged));

    const before = batches.length;
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/other\n");
    await waitFor(() => batches.slice(before).some((batch) => batch.gitMetaChanged));
    watcher.dispose();
  });
});

describe("Watcher batching and failure (injected fs.watch)", () => {
  test("starts lazily on first subscription and closes on dispose", () => {
    const fake = fakeFactory();
    const watcher = new Watcher({ root: "/tmp/lucy-not-used", watchFactory: fake.factory });
    expect(fake.calls()).toBe(0);
    expect(watcher.state).toBe("idle");
    watcher.onDidChange(() => {});
    expect(fake.calls()).toBe(1);
    watcher.start();
    expect(fake.calls()).toBe(1);
    watcher.dispose();
    expect(fake.handles[0]?.closed).toBe(true);
  });

  test("debounces and coalesces duplicate paths into one batch", async () => {
    const fake = fakeFactory();
    const watcher = new Watcher({ root: "/tmp/lucy-not-used", watchFactory: fake.factory, debounceMs: 40 });
    const { batches } = collect(watcher);
    fake.emit("a.txt");
    fake.emit("a.txt");
    fake.emit("./b.txt");
    fake.emit(".git/objects/12/3456");
    await Bun.sleep(120);
    expect(batches).toEqual([{ paths: ["a.txt", "b.txt"], gitMetaChanged: false, overflow: false }]);
    watcher.dispose();
  });

  test("a steady stream is flushed at maxWait", async () => {
    const fake = fakeFactory();
    const watcher = new Watcher({
      root: "/tmp/lucy-not-used",
      watchFactory: fake.factory,
      debounceMs: 100,
      maxWaitMs: 250,
    });
    const { batches } = collect(watcher);
    const started = performance.now();
    let firstBatchAt = 0;
    watcher.onDidChange(() => {
      if (firstBatchAt === 0) firstBatchAt = performance.now() - started;
    });
    for (let i = 0; i < 20; i++) {
      fake.emit(`f${i}`);
      await Bun.sleep(30);
    }
    await Bun.sleep(150);
    expect(firstBatchAt).toBeGreaterThan(200);
    expect(firstBatchAt).toBeLessThan(450);
    expect(batches.length).toBeGreaterThanOrEqual(2);
    expect(new Set(batches.flatMap((batch) => batch.paths)).size).toBe(20);
    watcher.dispose();
  });

  test("a Git directory outside the root (subfolder workspace, linked worktree) is watched separately", async () => {
    const listeners = new Map<string, (event: string, filename: string | null) => void>();
    const factory: WatchFactory = (path, listener) => {
      listeners.set(path, listener);
      return new FakeHandle();
    };
    const watcher = new Watcher({
      root: "/tmp/lucy-repo/packages/app",
      gitDir: "/tmp/lucy-repo/.git",
      watchFactory: factory,
      debounceMs: 20,
    });
    const { batches } = collect(watcher);
    expect([...listeners.keys()].sort()).toEqual(["/tmp/lucy-repo/.git", "/tmp/lucy-repo/packages/app"]);
    listeners.get("/tmp/lucy-repo/.git")?.("rename", "objects/aa/bb");
    await Bun.sleep(60);
    expect(batches).toEqual([]);
    listeners.get("/tmp/lucy-repo/.git")?.("rename", "refs/heads/main");
    listeners.get("/tmp/lucy-repo/packages/app")?.("rename", "src/index.ts");
    await Bun.sleep(60);
    expect(batches).toEqual([{ paths: ["src/index.ts"], gitMetaChanged: true, overflow: false }]);
    watcher.dispose();
  });

  test("too many paths, or an unknown path, becomes a single overflow batch", async () => {
    const fake = fakeFactory();
    const watcher = new Watcher({
      root: "/tmp/lucy-not-used",
      watchFactory: fake.factory,
      debounceMs: 20,
      maxBatchPaths: 10,
    });
    const { batches } = collect(watcher);
    for (let i = 0; i < 50; i++) fake.emit(`file-${i}`);
    await Bun.sleep(80);
    expect(batches).toEqual([{ paths: [], gitMetaChanged: false, overflow: true }]);
    fake.emit(null);
    await Bun.sleep(80);
    expect(batches[1]).toEqual({ paths: [], gitMetaChanged: false, overflow: true });
    watcher.dispose();
  });

  test("classifies Git paths", () => {
    expect(classifyGitPath("HEAD")).toBe("meta");
    expect(classifyGitPath("refs/heads/main")).toBe("meta");
    expect(classifyGitPath("MERGE_HEAD")).toBe("meta");
    expect(classifyGitPath("index.lock")).toBe("lock");
    expect(classifyGitPath("refs/heads/main.lock")).toBe("lock");
    expect(classifyGitPath("objects/ab/cdef")).toBe("noise");
    expect(classifyGitPath("logs/HEAD")).toBe("noise");
    expect(classifyGitPath("COMMIT_EDITMSG")).toBe("noise");
    expect(classifyGitPath("")).toBe("meta");
  });

  test("a start failure (EMFILE) emits one failure event and degrades", async () => {
    const failing: WatchFactory = () => {
      throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
    };
    const watcher = new Watcher({ root: "/tmp/lucy-not-used", watchFactory: failing });
    const failures: LucyError[] = [];
    watcher.onDidFail((error) => failures.push(error));
    watcher.onDidChange(() => {});
    await Promise.resolve();
    expect(watcher.state).toBe("failed");
    expect(failures.length).toBe(1);
    expect(failures[0]?.code).toBe("IO_ERROR");
    expect(watcher.failure?.message).toContain("Too many files");
    watcher.start();
    await Promise.resolve();
    expect(failures.length).toBe(1);
    watcher.dispose();
  });

  test("a runtime error (recursive watching unsupported) fails once and closes the handle", async () => {
    const fake = fakeFactory();
    const watcher = new Watcher({ root: "/tmp/lucy-not-used", watchFactory: fake.factory });
    const failures: LucyError[] = [];
    watcher.onDidFail((error) => failures.push(error));
    watcher.start();
    const unsupported = Object.assign(new Error("recursive watch unavailable"), {
      code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
    });
    fake.handles[0]?.fail(unsupported);
    fake.handles[0]?.fail(unsupported);
    await Promise.resolve();
    expect(failures.map((error) => error.code)).toEqual(["UNSUPPORTED"]);
    expect(fake.handles[0]?.closed).toBe(true);
    watcher.dispose();
  });

  test("watching a missing root fails softly", async () => {
    const root = join(await tempDir(), "missing");
    const watcher = new Watcher({ root });
    const failures: LucyError[] = [];
    watcher.onDidFail((error) => failures.push(error));
    watcher.start();
    await Promise.resolve();
    expect(watcher.state).toBe("failed");
    expect(failures.length).toBe(1);
    watcher.dispose();
  });
});
