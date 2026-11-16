import { describe, expect, test } from "bun:test";
import { gitFailureKind } from "@/adapters/git";
import { isLucyError } from "@/core/errors";
import { registerCleanup, setup } from "./support";

registerCleanup();

describe("branches", () => {
  test("lists current, local and remote branches with upstream and ahead/behind", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    await fx.addBareRemote();
    await fx.git("push", "-q", "-u", "origin", "main");
    await fx.git("branch", "feature");
    await fx.write("a.txt", "ahead\n");
    await fx.commitAll("ahead");

    const list = await git.branches();
    expect(list.current).toBe("main");
    expect(list.detached).toBe(false);
    expect(list.headOid).toBe((await fx.git("rev-parse", "HEAD")).trim());
    expect(list.local.map((b) => b.name).sort()).toEqual(["feature", "main"]);
    const main = list.local.find((b) => b.name === "main");
    expect(main).toMatchObject({
      isCurrent: true,
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
      kind: "local",
    });
    expect(list.local.find((b) => b.name === "feature")?.isCurrent).toBe(false);
    // origin/HEAD style symbolic refs are skipped.
    expect(list.remote.map((b) => [b.name, b.remote])).toEqual([["origin/main", "origin"]]);
  });

  test("unborn current branch is listed without an oid", async () => {
    const { git } = await setup();
    const list = await git.branches();
    expect(list.current).toBe("main");
    expect(list.headOid).toBeNull();
    expect(list.local).toEqual([
      { name: "main", ref: "refs/heads/main", kind: "local", oid: null, isCurrent: true },
    ]);
  });

  test("detached HEAD has no current branch", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    await fx.git("switch", "-q", "--detach");
    const list = await git.branches();
    expect(list.current).toBeNull();
    expect(list.detached).toBe(true);
    expect(list.headOid).not.toBeNull();
  });

  test("createBranch with and without switching, from a start point", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "1\n" }, commit: "one" });
    const first = (await fx.git("rev-parse", "HEAD")).trim();
    await fx.write("a.txt", "2\n");
    await fx.commitAll("two");

    await git.createBranch("feature/plain");
    expect((await git.status()).branch.name).toBe("main");
    await git.createBranch("from-first", { from: first });
    expect((await fx.git("rev-parse", "from-first")).trim()).toBe(first);
    await git.createBranch("feature/ğüş", { switch: true });
    expect((await git.status()).branch.name).toBe("feature/ğüş");
  });

  test("createBranch with switch works on an unborn branch", async () => {
    const { git } = await setup();
    await git.createBranch("develop", { switch: true });
    expect((await git.status()).branch).toMatchObject({ name: "develop", unborn: true });
  });

  test("starting from a remote-tracking branch sets the upstream", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    await fx.addBareRemote();
    await fx.git("push", "-q", "origin", "main:shared");
    await fx.git("fetch", "-q", "origin");
    await git.createBranch("shared", { from: "origin/shared", switch: true });
    expect((await git.status()).branch).toMatchObject({ name: "shared", upstream: "origin/shared" });
  });

  test("invalid branch names are rejected by validation without side effects", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    const before = await fx.git("for-each-ref", "--format=%(refname)");
    for (const name of [
      "has space",
      "a..b",
      "-b",
      "--orphan",
      "@{-1}",
      "HEAD",
      "x.lock",
      "tab\tname",
      "",
      "a~1",
      "a:b",
    ]) {
      const created = await git.createBranch(name).catch((e: unknown) => e);
      expect(isLucyError(created, "INVALID_ARGUMENT")).toBe(true);
      expect(gitFailureKind(created)).toBe("invalid-ref-name");
      const switched = await git.switchBranch(name).catch((e: unknown) => e);
      expect(gitFailureKind(switched)).toBe("invalid-ref-name");
    }
    expect(await fx.git("for-each-ref", "--format=%(refname)")).toBe(before);
  });

  test("invalid start points are rejected", async () => {
    const { git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    for (const from of ["--all", "no-such-ref", "HEAD:a.txt"]) {
      const error = await git.createBranch("ok", { from }).catch((e: unknown) => e);
      expect(isLucyError(error, "INVALID_ARGUMENT")).toBe(true);
    }
    expect((await git.branches()).local.map((b) => b.name)).toEqual(["main"]);
  });

  test("switchBranch fails safely when it would overwrite local changes", async () => {
    const { fx, git } = await setup({ files: { "f.txt": "main\n" }, commit: "init" });
    await fx.git("switch", "-q", "-c", "other");
    await fx.write("f.txt", "other\n");
    await fx.commitAll("other");
    await fx.git("switch", "-q", "main");
    await fx.write("f.txt", "precious local edit\n");

    const error = await git.switchBranch("other").catch((e: unknown) => e);
    expect(gitFailureKind(error)).toBe("would-overwrite");
    expect(isLucyError(error) ? String(error.details?.stderr) : "").toContain("f.txt");
    expect(await fx.read("f.txt")).toBe("precious local edit\n");
    expect((await git.status()).branch.name).toBe("main");
  });

  test("switchBranch switches and refuses unknown or remote-only names", async () => {
    const { fx, git } = await setup({ files: { "f.txt": "x\n" }, commit: "init" });
    await fx.git("branch", "other");
    await git.switchBranch("other");
    expect((await git.status()).branch.name).toBe("other");
    const error = await git.switchBranch("does-not-exist").catch((e: unknown) => e);
    expect(isLucyError(error, "GIT_FAILED")).toBe(true);
  });
});

describe("log", () => {
  test("commits with subject, body, author, ISO date, parents and refs", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "1\n" }, commit: "first" });
    await fx.git("tag", "v1.0");
    await fx.write("a.txt", "2\n");
    await fx.git("add", "-A");
    await fx.git("commit", "-q", "-m", "İkinci commit: ğüşöç", "-m", "Body line 1\nBody line 2");

    const commits = await git.log();
    expect(commits).toHaveLength(2);
    const [second, first] = commits;
    expect(second).toMatchObject({
      subject: "İkinci commit: ğüşöç",
      body: "Body line 1\nBody line 2",
      authorName: "Lucy Test",
      authorEmail: "lucy-test@example.invalid",
      authorDate: "2026-01-01T12:00:00Z",
    });
    expect(second?.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(second?.parents).toEqual([first?.oid ?? ""]);
    expect(second?.refs).toEqual([{ name: "main", kind: "branch", isHead: true }]);
    expect(first?.refs).toEqual([{ name: "v1.0", kind: "tag", isHead: false }]);
    expect(first?.parents).toEqual([]);
    expect(first?.body).toBe("");
  });

  test("limit, skip and path filter", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "0\n", "b.txt": "0\n" }, commit: "c0" });
    for (let i = 1; i <= 4; i++) {
      await fx.write(i % 2 === 0 ? "a.txt" : "b.txt", `${i}\n`);
      await fx.commitAll(`c${i}`);
    }
    expect((await git.log({ limit: 2 })).map((c) => c.subject)).toEqual(["c4", "c3"]);
    expect((await git.log({ limit: 2, skip: 2 })).map((c) => c.subject)).toEqual(["c2", "c1"]);
    expect((await git.log({ path: "a.txt" })).map((c) => c.subject)).toEqual(["c4", "c2", "c0"]);
  });

  test("unborn repository has an empty history", async () => {
    const { git } = await setup();
    expect(await git.log()).toEqual([]);
  });

  test("a file named HEAD does not confuse revision parsing", async () => {
    const { fx, git } = await setup({ files: { HEAD: "i am a file\n" }, commit: "has a HEAD file" });
    expect((await git.log()).map((c) => c.subject)).toEqual(["has a HEAD file"]);
    expect(await git.lastCommitMessage()).toBe("has a HEAD file");
    expect((await git.fileAtRevision("HEAD", "HEAD")).content).toBe("i am a file\n");
    await fx.write("HEAD", "changed\n");
    expect((await git.diff({ path: "HEAD" })).patch).toContain("+changed");
  });

  test("option-like refs are rejected", async () => {
    const { git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    for (const ref of ["--all", "-p", "HEAD:a.txt"]) {
      const error = await git.log({ ref }).catch((e: unknown) => e);
      expect(isLucyError(error, "INVALID_ARGUMENT")).toBe(true);
    }
  });
});

describe("stash", () => {
  test("push, list, apply, pop and drop", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    await fx.write("a.txt", "first change\n");
    expect(await git.stashPush({ message: "work in progress: ğüş" })).toEqual({ created: true });
    expect(await fx.read("a.txt")).toBe("a\n");
    await fx.write("a.txt", "second change\n");
    expect(await git.stashPush()).toEqual({ created: true });

    const list = await git.stashList();
    expect(list.map((s) => [s.index, s.ref, s.branch])).toEqual([
      [0, "stash@{0}", "main"],
      [1, "stash@{1}", "main"],
    ]);
    expect(list[1]?.message).toBe("On main: work in progress: ğüş");
    expect(list[0]?.message).toStartWith("WIP on main:");
    expect(list[0]?.oid).toMatch(/^[0-9a-f]{40}$/);
    expect((await git.status()).stashCount).toBe(2);

    await git.stashApply(1);
    expect(await fx.read("a.txt")).toBe("first change\n");
    expect(await git.stashList()).toHaveLength(2);
    await git.discard(["a.txt"]);

    await git.stashPop(0);
    expect(await fx.read("a.txt")).toBe("second change\n");
    expect(await git.stashList()).toHaveLength(1);

    await git.stashDrop(0);
    expect(await git.stashList()).toEqual([]);
  });

  test("nothing to stash", async () => {
    const { git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    expect(await git.stashPush()).toEqual({ created: false });
  });

  test("includeUntracked stashes untracked files", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    await fx.write("u.txt", "untracked\n");
    expect(await git.stashPush()).toEqual({ created: false });
    expect(await git.stashPush({ includeUntracked: true })).toEqual({ created: true });
    expect(await fx.exists("u.txt")).toBe(false);
    await git.stashPop(0);
    expect(await fx.read("u.txt")).toBe("untracked\n");
  });

  test("applying over conflicting local changes fails safely", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    await fx.write("a.txt", "stashed\n");
    await git.stashPush();
    await fx.write("a.txt", "local\n");
    const error = await git.stashPop(0).catch((e: unknown) => e);
    expect(gitFailureKind(error)).toBe("would-overwrite");
    expect(await fx.read("a.txt")).toBe("local\n");
    expect(await git.stashList()).toHaveLength(1);
  });

  test("invalid stash indexes are rejected", async () => {
    const { git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    for (const index of [-1, 1.5, Number.NaN]) {
      const error = await git.stashDrop(index).catch((e: unknown) => e);
      expect(isLucyError(error, "INVALID_ARGUMENT")).toBe(true);
    }
    const missing = await git.stashApply(3).catch((e: unknown) => e);
    expect(isLucyError(missing, "GIT_FAILED")).toBe(true);
  });
});
