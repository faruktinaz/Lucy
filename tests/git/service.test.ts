import { describe, expect, test } from "bun:test";
import {
  createGitAdapterFactory,
  type GitChange,
  GitService,
  type GitState,
  gitFailureKind,
  MockGitAdapter,
  mockGitError,
} from "@/adapters/git";
import { isLucyError } from "@/core/errors";
import { fixtureEnv } from "../helpers/git-fixture";
import { deferCleanup, fixture, registerCleanup, tempDir } from "./support";

registerCleanup();

const CHANGES: GitChange[] = [
  { path: "src/a.ts", worktree: "modified", conflicted: false },
  { path: "src/b.ts", index: "added", conflicted: false },
  { path: "notes.md", worktree: "untracked", conflicted: false },
];

function serviceWith(
  mock: MockGitAdapter,
  options: ConstructorParameters<typeof GitService>[1] = {},
): GitService {
  const service = new GitService(async () => mock, options);
  deferCleanup(() => service.dispose());
  return service;
}

describe("GitService with MockGitAdapter", () => {
  test("refresh populates state and is coalesced", async () => {
    const mock = new MockGitAdapter({ changes: CHANGES, latencyMs: 15 });
    let now = 1_000;
    const service = serviceWith(mock, { now: () => now });
    const loading: boolean[] = [];
    service.store.subscribe(() => loading.push(service.state.loading));

    const results = await Promise.all(Array.from({ length: 6 }, () => service.refresh()));
    expect(mock.callCount("status")).toBe(2);
    expect(results.at(-1)?.status?.changes).toHaveLength(3);
    expect(service.state).toMatchObject({
      loading: false,
      error: null,
      lastUpdated: 1_000,
      busyOperation: null,
    });
    expect(service.state.repo?.root).toBe("/mock/repo");
    expect(loading[0]).toBe(true);
    now = 2_000;
    await service.refresh();
    expect(service.state.lastUpdated).toBe(2_000);
  });

  test("unchanged status keeps the same object reference", async () => {
    const mock = new MockGitAdapter({ changes: CHANGES });
    const service = serviceWith(mock);
    const first = (await service.refresh()).status;
    const second = (await service.refresh()).status;
    expect(second).toBe(first);
    mock.setChanges([]);
    expect((await service.refresh()).status).not.toBe(first);
  });

  test("mutations refresh automatically and the mock regroups like Git", async () => {
    const mock = new MockGitAdapter({ changes: CHANGES });
    const service = serviceWith(mock);
    await service.refresh();
    const before = mock.callCount("status");

    await service.stage(["src/a.ts", "notes.md"]);
    expect(mock.callCount("status")).toBe(before + 1);
    expect(service.state.status?.staged.map((c) => c.path).sort()).toEqual([
      "notes.md",
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(service.state.status?.untracked).toEqual([]);

    const result = await service.commit({ message: "feat: things\n\nbody" });
    expect(result.summary).toBe("feat: things");
    expect(service.state.status?.changes).toEqual([]);
    expect(await service.lastCommitMessage()).toBe("feat: things\n\nbody");
    expect(mock.calls.map((call) => call.method)).toContain("commit");
  });

  test("a failed mutation still refreshes and rethrows the typed error", async () => {
    const mock = new MockGitAdapter({ changes: CHANGES });
    const service = serviceWith(mock);
    await service.refresh();
    const before = mock.callCount("status");
    mock.failNext("stage", mockGitError("disk on fire"));
    const error = await service.stage(["src/a.ts"]).catch((e: unknown) => e);
    expect(isLucyError(error, "GIT_FAILED")).toBe(true);
    expect(mock.callCount("status")).toBe(before + 1);
    expect(service.state.busyOperation).toBeNull();
    await service.stage(["src/a.ts"]);
  });

  test("busyOperation reflects the running mutation", async () => {
    const mock = new MockGitAdapter({
      changes: [{ path: "x", index: "modified", conflicted: false }],
      latencyMs: 20,
    });
    const service = serviceWith(mock);
    await service.refresh();
    const seen: Array<GitState["busyOperation"]> = [];
    service.store.subscribe(() => seen.push(service.state.busyOperation));
    await service.commit({ message: "m" });
    expect(seen).toContain("commit");
    expect(service.state.busyOperation).toBeNull();
  });

  test("refresh errors land in state.error without throwing; recovery clears them", async () => {
    const mock = new MockGitAdapter({ changes: CHANGES });
    const service = serviceWith(mock);
    await service.refresh();
    mock.failNext("status", mockGitError("transient"));
    const state = await service.refresh();
    expect(state.error?.message).toBe("transient");
    expect(state.status?.changes).toHaveLength(3); // previous status kept
    expect((await service.refresh()).error).toBeNull();
  });

  test("unstaging a staged rename also unstages its source path", async () => {
    const mock = new MockGitAdapter({
      changes: [{ path: "new.ts", origPath: "old.ts", index: "renamed", conflicted: false, score: 100 }],
    });
    const service = serviceWith(mock);
    await service.refresh();
    await service.unstage(["new.ts"]);
    expect(mock.calls.find((call) => call.method === "unstage")?.args).toEqual([["new.ts", "old.ts"]]);
    expect(service.state.status?.unstaged.map((c) => [c.path, c.worktree])).toEqual([["old.ts", "deleted"]]);
    expect(service.state.status?.untracked.map((c) => c.path)).toEqual(["new.ts"]);
  });

  test("decorations: files, directories, and workspace-relative lookups", async () => {
    const mock = new MockGitAdapter({
      changes: [
        { path: "packages/app/src/x.ts", worktree: "modified", conflicted: false },
        { path: "README.md", index: "modified", conflicted: false },
      ],
      repository: { workspacePrefix: "packages/app", workspaceRoot: "/mock/repo/packages/app" },
    });
    const service = serviceWith(mock);
    expect(service.decorationFor("src/x.ts")).toBeUndefined();
    await service.refresh();
    expect(service.decorationFor("src/x.ts")).toMatchObject({
      kind: "file",
      status: "modified",
      letter: "M",
    });
    expect(service.decorationFor("src")).toMatchObject({ kind: "directory", changeCount: 1 });
    expect(service.decorationFor("")).toMatchObject({ kind: "directory", changeCount: 1 });
    expect(service.decorationFor("README.md", "repo")).toMatchObject({ staged: true });
    expect(service.decorations()).toBe(service.decorations());
  });

  test("scheduleRefresh debounces bursts", async () => {
    const mock = new MockGitAdapter({ changes: CHANGES });
    const service = serviceWith(mock, { refreshDelayMs: 10 });
    for (let i = 0; i < 10; i++) service.scheduleRefresh();
    await Bun.sleep(60);
    expect(mock.callCount("status")).toBe(1);
  });

  test("dispose stops everything and disposes the adapter", async () => {
    const mock = new MockGitAdapter({ changes: CHANGES });
    const service = new GitService(async () => mock);
    await service.refresh();
    service.dispose();
    expect(mock.disposed).toBe(true);
    const calls = mock.callCount("status");
    await service.refresh();
    expect(mock.callCount("status")).toBe(calls);
    expect(gitFailureKind(await service.stage(["x"]).catch((e: unknown) => e))).toBe("cancelled");
  });
});

describe("MockGitAdapter", () => {
  test("records calls, scripted diffs and failures", async () => {
    const mock = new MockGitAdapter({ changes: CHANGES });
    mock.setDiff({ path: "src/a.ts" }, { patch: "diff --git a/src/a.ts b/src/a.ts\n" });
    expect((await mock.diff({ path: "src/a.ts" })).patch).toContain("diff --git");
    expect((await mock.diff({ path: "src/a.ts", staged: true })).isEmpty).toBe(true);
    mock.failAlways("push");
    await expect(mock.push()).rejects.toThrow();
    await expect(mock.push()).rejects.toThrow();
    mock.clearFailures();
    await expect(mock.push()).rejects.toThrow("no upstream");
    expect(await mock.push({ setUpstream: true })).toEqual({
      remote: "origin",
      branch: "main",
      upstreamSet: true,
    });
    expect(mock.callCount("push")).toBe(4);
  });

  test("commit rules mirror Git", async () => {
    const mock = new MockGitAdapter({ changes: [{ path: "a", worktree: "modified", conflicted: false }] });
    expect(gitFailureKind(await mock.commit({ message: "" }).catch((e: unknown) => e))).toBe("empty-message");
    expect(gitFailureKind(await mock.commit({ message: "x" }).catch((e: unknown) => e))).toBe(
      "nothing-to-commit",
    );
    await mock.stage(["a"]);
    await mock.commit({ message: "x" });
    expect((await mock.status()).changes).toEqual([]);
    expect((await mock.log()).map((c) => c.subject)).toEqual(["x"]);
  });

  test("stash round trip and discard", async () => {
    const mock = new MockGitAdapter({ changes: CHANGES });
    expect(await mock.stashPush({ message: "wip" })).toEqual({ created: true });
    expect((await mock.status()).changes.map((c) => c.path)).toEqual(["notes.md"]);
    expect((await mock.stashList())[0]?.message).toBe("On main: wip");
    await mock.stashPop(0);
    expect((await mock.status()).changes).toHaveLength(3);
    expect(await mock.discard(["src/a.ts", "notes.md", "src/b.ts"])).toEqual({
      restored: ["src/a.ts"],
      deleted: ["notes.md"],
      unchanged: ["src/b.ts"],
    });
  });
});

describe("GitService with the real adapter", () => {
  test("non-repository error state, then recovery after git init", async () => {
    const dir = tempDir();
    const env = { ...fixtureEnv(dir), GIT_CEILING_DIRECTORIES: dir };
    const service = new GitService(createGitAdapterFactory(dir, { env }));
    deferCleanup(() => service.dispose());
    let state = await service.refresh();
    expect(isLucyError(state.error, "NOT_A_REPOSITORY")).toBe(true);
    expect(state.repo).toBeNull();
    expect(state.status).toBeNull();
    expect(gitFailureKind(await service.diff({ path: "x" }).catch((e: unknown) => e))).toBe(
      "not-a-repository",
    );

    const init = Bun.spawnSync(["git", "init", "-q", "--template=", "--initial-branch=main", dir], {
      env: Object.fromEntries(
        Object.entries({ ...process.env, ...env }).filter(([, v]) => v !== undefined),
      ) as Record<string, string>,
    });
    expect(init.exitCode).toBe(0);
    state = await service.refresh();
    expect(state.error).toBeNull();
    expect(state.repo?.root).toBe(dir);
    expect(state.status?.branch.unborn).toBe(true);
  });

  test("stage, commit and decorations end to end", async () => {
    const fx = await fixture({ files: { "src/a.ts": "a\n" }, commit: "init" });
    const service = new GitService(createGitAdapterFactory(fx.root, { env: fx.env }));
    deferCleanup(() => service.dispose());
    await fx.write("src/a.ts", "changed\n");
    await fx.write("src/new.ts", "new\n");
    await service.refresh();
    expect(service.decorationFor("src")).toMatchObject({ kind: "directory", changeCount: 2 });
    await service.stageAll();
    expect(service.state.status?.staged).toHaveLength(2);
    const result = await service.commit({ message: "end to end" });
    expect(result.branch).toBe("main");
    expect(service.state.status?.changes).toEqual([]);
    expect(service.decorationFor("src")).toBeUndefined();
  });
});
