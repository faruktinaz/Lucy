import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isLucyError } from "@/core/errors";
import { resolveWorkspace, workspaceId } from "@/core/workspace/resolve";
import {
  defaultWorkspaceState,
  isWorkspaceRelativePath,
  normalizeWorkspaceState,
  STATE_LIMITS,
  type WorkspaceState,
} from "@/core/workspace/state";
import { WorkspaceStateStore, workspaceStatePath } from "@/core/workspace/state-store";
import { makeTempDirs, type TempDirs } from "./helpers";

let temp: TempDirs;
let project: string;
let home: string;
beforeEach(async () => {
  temp = await makeTempDirs();
  home = join(temp.root, "home");
  project = join(home, "code", "My Project");
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "src", "main.ts"), "export {};\n");
});
afterEach(async () => {
  await temp.cleanup();
});

describe("resolveWorkspace", () => {
  test("resolves ., relative, absolute and ~ paths to the same workspace", async () => {
    const results = await Promise.all([
      resolveWorkspace(".", project, { home }),
      resolveWorkspace(undefined, project, { home }),
      resolveWorkspace("My Project", join(home, "code"), { home }),
      resolveWorkspace(project, "/", { home }),
      resolveWorkspace("~/code/My Project", "/", { home }),
      resolveWorkspace("src/..", project, { home }),
    ]);
    for (const result of results) {
      expect(result.workspace.root).toBe(project);
      expect(result.workspace.name).toBe("My Project");
      expect(result.openFile).toBeUndefined();
      expect(result.notices).toEqual([]);
    }
    expect(new Set(results.map((r) => r.workspace.id)).size).toBe(1);
  });

  test("the id is stable, readable and follows the real path through symlinks", async () => {
    const link = join(temp.root, "link-to-project");
    await symlink(project, link);
    const viaLink = await resolveWorkspace(link, "/", { home });
    expect(viaLink.workspace.root).toBe(project);
    expect(viaLink.workspace.id).toBe(workspaceId(project));
    expect(viaLink.workspace.id).toMatch(/^my-project-[0-9a-f]{16}$/);
    expect(workspaceId("/x/Çalışma Alanı")).toMatch(/^calisma-alani-[0-9a-f]{16}$/);
    expect(workspaceId("/")).toMatch(/^root-[0-9a-f]{16}$/);
  });

  test("a file argument opens its parent and remembers the file", async () => {
    const result = await resolveWorkspace("src/main.ts", project, { home });
    expect(result.workspace.root).toBe(join(project, "src"));
    expect(result.openFile).toBe("main.ts");
  });

  test("typed errors: not found, not a directory, no permission, ~user", async () => {
    const missing = await resolveWorkspace("nope", project, { home }).catch((e: unknown) => e);
    expect(isLucyError(missing, "NOT_FOUND")).toBe(true);

    const fifo = join(temp.root, "pipe");
    const made = Bun.spawnSync(["mkfifo", fifo]);
    if (made.exitCode === 0) {
      const notDir = await resolveWorkspace(fifo, "/", { home }).catch((e: unknown) => e);
      expect(isLucyError(notDir, "INVALID_ARGUMENT")).toBe(true);
      expect((notDir as { details?: { reason?: string } }).details?.reason).toBe("not-a-directory");
    }

    const tilde = await resolveWorkspace("~someone/x", "/", { home }).catch((e: unknown) => e);
    expect(isLucyError(tilde, "INVALID_ARGUMENT")).toBe(true);

    if (process.getuid?.() !== 0) {
      const locked = join(temp.root, "locked");
      await mkdir(locked);
      await chmod(locked, 0o000);
      const denied = await resolveWorkspace(locked, "/", { home }).catch((e: unknown) => e);
      expect(isLucyError(denied, "PERMISSION_DENIED")).toBe(true);
      await chmod(locked, 0o755);
    }
  });

  test("notices for the home folder and the filesystem root", async () => {
    const atHome = await resolveWorkspace("~", "/", { home });
    expect(atHome.notices.map((n) => n.code)).toEqual(["home-directory"]);
    const atRoot = await resolveWorkspace("/", "/", { home });
    expect(atRoot.notices.map((n) => n.code)).toEqual(["filesystem-root"]);
    expect(atRoot.workspace.name).toBe("/");
  });
});

describe("workspace-relative paths", () => {
  test.each([
    ["src/main.ts", true],
    ["README.md", true],
    [".github/workflows/ci.yml", true],
    ["dir/..hidden", true],
    ["Türkçe/dosya adı.md", true],
    ["", false],
    ["/etc/passwd", false],
    ["../outside", false],
    ["src/../../x", false],
    ["./src", false],
    ["src//main.ts", false],
    ["src/", false],
    ["C:/Windows", false],
    ["\\\\server\\share", false],
    ["a\0b", false],
  ])("%j -> %s", (path, expected) => {
    expect(isWorkspaceRelativePath(path)).toBe(expected);
  });

  test("rejects non-strings and over-long paths", () => {
    expect(isWorkspaceRelativePath(42)).toBe(false);
    expect(isWorkspaceRelativePath("a".repeat(STATE_LIMITS.pathLength + 1))).toBe(false);
  });
});

describe("normalizeWorkspaceState", () => {
  test("garbage gives defaults", () => {
    for (const input of [null, 42, "x", [], undefined]) {
      expect(normalizeWorkspaceState(input)).toEqual(defaultWorkspaceState());
    }
  });

  test("drops unsafe paths item by item and keeps the rest", () => {
    const state = normalizeWorkspaceState({
      version: 1,
      openFiles: [
        { path: "src/a.ts", kind: "file", pinned: true, viewState: { scrollTop: 10, cursorLine: 3 } },
        { path: "/etc/passwd", kind: "file", pinned: false },
        { path: "../secret", kind: "file", pinned: false },
        { path: "src/b.ts", kind: "diff", staged: true, pinned: "yes" },
        { path: "src/a.ts", kind: "file", pinned: false },
        "nonsense",
      ],
      activeFile: "../escape",
      explorer: { expanded: ["src", "/abs", "src", "lib/.."] },
      recentFiles: ["src/a.ts", "/tmp/x"],
      commandMru: ["file.quickOpen", "rm -rf", "git.commit"],
      layout: { sidebar: { visible: false, view: "nonsense", width: 40 }, zen: "maybe" },
      search: { query: 7 },
      commitDraft: "fix: thing",
    });
    expect(state.openFiles).toEqual([
      { path: "src/a.ts", kind: "file", pinned: true, viewState: { scrollTop: 10, cursorLine: 3 } },
      { path: "src/b.ts", kind: "diff", staged: true, pinned: false },
    ]);
    expect(state.activeFile).toBeNull();
    expect(state.explorer.expanded).toEqual(["src"]);
    expect(state.recentFiles).toEqual(["src/a.ts"]);
    expect(state.commandMru).toEqual(["file.quickOpen", "git.commit"]);
    expect(state.layout.sidebar).toEqual({ visible: false, view: "explorer", width: 40 });
    expect(state.layout.zen).toBe(false);
    expect(state.layout.aiPanel).toEqual({ visible: false, width: null });
    expect(state.search.query).toBe("");
    expect(state.commitDraft).toBe("fix: thing");
  });

  test("caps list sizes and clips long text instead of discarding it", () => {
    const many = Array.from({ length: 200 }, (_, i) => `file-${i}.ts`);
    const state = normalizeWorkspaceState({
      openFiles: many.map((path) => ({ path, kind: "file", pinned: false })),
      recentFiles: many,
      commandMru: many.map((_, i) => `cmd.n${i}`),
      explorer: { expanded: Array.from({ length: 2000 }, (_, i) => `d${i}`) },
      commitDraft: "x".repeat(STATE_LIMITS.commitDraftLength + 50),
    });
    expect(state.openFiles).toHaveLength(STATE_LIMITS.openFiles);
    expect(state.recentFiles).toHaveLength(STATE_LIMITS.recentFiles);
    expect(state.recentFiles[0]).toBe("file-0.ts");
    expect(state.commandMru).toHaveLength(STATE_LIMITS.commandMru);
    expect(state.explorer.expanded).toHaveLength(STATE_LIMITS.expandedPaths);
    expect(state.commitDraft).toHaveLength(STATE_LIMITS.commitDraftLength);
  });
});

describe("WorkspaceStateStore", () => {
  const workspace = () => ({ id: workspaceId(project), root: project });

  function sample(): WorkspaceState {
    const state = defaultWorkspaceState();
    return {
      ...state,
      openFiles: [{ path: "src/main.ts", kind: "file", pinned: true, viewState: { scrollTop: 4 } }],
      activeFile: "src/main.ts",
      layout: { ...state.layout, sidebar: { visible: true, view: "scm", width: 36 }, zen: true },
      explorer: { expanded: ["src"] },
      search: { query: "TODO" },
      commandMru: ["git.commit"],
      recentFiles: ["src/main.ts"],
      commitDraft: "feat: draft message\n\nbody",
    };
  }

  test("missing state gives defaults; the file lives under the state dir, not the project", async () => {
    const store = new WorkspaceStateStore(temp.dirs, workspace());
    expect(store.path).toBe(workspaceStatePath(temp.dirs, workspace().id));
    expect(store.path.startsWith(join(temp.dirs.state, "workspaces"))).toBe(true);
    const loaded = await store.load();
    expect(loaded.source).toBe("defaults");
    expect(loaded.state).toEqual(defaultWorkspaceState());
    expect(await readdir(project)).toEqual(["src"]);
  });

  test("round trip through flush, written atomically with private permissions", async () => {
    const now = () => new Date("2026-11-16T12:00:00.000Z");
    const store = new WorkspaceStateStore(temp.dirs, workspace(), { debounceMs: 10_000, now });
    store.save(sample());
    await store.flush();
    const json = JSON.parse(await readFile(store.path, "utf8"));
    expect(json.updatedAt).toBe("2026-11-16T12:00:00.000Z");
    expect(json.root).toBe(project);
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(temp.dirs.state, "workspaces"))).toEqual([`${workspace().id}.json`]);
    const loaded = await new WorkspaceStateStore(temp.dirs, workspace()).load();
    expect(loaded.source).toBe("file");
    expect(loaded.state).toEqual({ ...sample(), updatedAt: "2026-11-16T12:00:00.000Z" });
  });

  test("saves are debounced: only the last state of a burst is written", async () => {
    const store = new WorkspaceStateStore(temp.dirs, workspace(), { debounceMs: 25 });
    for (let i = 0; i < 5; i++) store.save({ ...sample(), search: { query: `q${i}` } });
    expect(await Bun.file(store.path).exists()).toBe(false);
    await Bun.sleep(80);
    await store.flush();
    expect((await store.load()).state.search.query).toBe("q4");
    store.dispose();
  });

  test("dispose cancels a pending save; flush first to keep it", async () => {
    const store = new WorkspaceStateStore(temp.dirs, workspace(), { debounceMs: 10 });
    store.save(sample());
    store.dispose();
    await Bun.sleep(40);
    expect(await Bun.file(store.path).exists()).toBe(false);
  });

  test("a corrupt file is moved aside, not deleted, and the session starts fresh", async () => {
    const store = new WorkspaceStateStore(temp.dirs, workspace(), {
      now: () => new Date("2026-11-16T12:00:00.000Z"),
    });
    await mkdir(join(temp.dirs.state, "workspaces"), { recursive: true });
    for (const garbage of ["{ not json", "[1,2,3]", "null"]) {
      await writeFile(store.path, garbage);
      const loaded = await store.load();
      expect(loaded.source).toBe("recovered");
      expect(loaded.state).toEqual(defaultWorkspaceState());
      expect(await readFile(loaded.corruptBackupPath ?? "", "utf8")).toBe(garbage);
      expect(await Bun.file(store.path).exists()).toBe(false);
    }
  });

  test("tampered paths are dropped on load and on save", async () => {
    const store = new WorkspaceStateStore(temp.dirs, workspace());
    store.save({ ...sample(), recentFiles: ["src/main.ts", "/etc/passwd", "../../x"] });
    await store.flush();
    expect(JSON.parse(await readFile(store.path, "utf8")).recentFiles).toEqual(["src/main.ts"]);
    await writeFile(
      store.path,
      JSON.stringify({ version: 1, activeFile: "/etc/shadow", openFiles: [{ path: "../x" }] }),
    );
    const loaded = await store.load();
    expect(loaded.state.activeFile).toBeNull();
    expect(loaded.state.openFiles).toEqual([]);
  });

  test("a failing background save is reported, and flush rejects", async () => {
    const blocker = join(temp.root, "blocked-state");
    await writeFile(blocker, "not a directory");
    const store = new WorkspaceStateStore({ state: blocker }, workspace(), { debounceMs: 5 });
    const errors: unknown[] = [];
    store.onDidFailSave((e) => errors.push(e));
    store.save(sample());
    await Bun.sleep(40);
    expect(errors).toHaveLength(1);
    store.save(sample());
    await expect(store.flush()).rejects.toMatchObject({ name: "LucyError" });
  });
});
