import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { gitFailureKind, openGitRepository } from "@/adapters/git";
import { isLucyError } from "@/core/errors";
import { deferCleanup, registerCleanup, setup, writeScript } from "./support";

registerCleanup();

/** Repository with an `origin` bare remote that already has `main`. */
async function withRemote() {
  const context = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
  const remote = await context.fx.addBareRemote();
  await context.fx.git("push", "-q", "-u", "origin", "main");
  return { ...context, remote };
}

describe("remotes", () => {
  test("lists remotes and redacts embedded credentials", async () => {
    const { fx, git, remote } = await withRemote();
    await fx.git("remote", "add", "creds", "https://alice:s3cr3t-token@example.invalid/repo.git");
    await fx.git(
      "remote",
      "add",
      "tokenuser",
      "https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@example.invalid/r.git",
    );
    const remotes = await git.remotes();
    expect(remotes.find((r) => r.name === "origin")).toEqual({
      name: "origin",
      fetchUrl: remote,
      pushUrl: remote,
    });
    const creds = remotes.find((r) => r.name === "creds");
    expect(creds?.fetchUrl).toBe("https://alice:***@example.invalid/repo.git");
    expect(JSON.stringify(remotes)).not.toContain("s3cr3t");
    expect(JSON.stringify(remotes)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  test("push without an upstream gives no-upstream; setUpstream publishes the branch", async () => {
    const { fx, git, remote } = await withRemote();
    await fx.git("switch", "-q", "-c", "feature");
    await fx.write("f.txt", "feature\n");
    await fx.commitAll("feature work");

    const error = await git.push().catch((e: unknown) => e);
    expect(gitFailureKind(error)).toBe("no-upstream");

    const result = await git.push({ setUpstream: true });
    expect(result).toEqual({ remote: "origin", branch: "feature", upstreamSet: true });
    expect((await git.status()).branch).toMatchObject({ upstream: "origin/feature", ahead: 0, behind: 0 });
    const remoteHead = await fx.gitRaw(["rev-parse", "refs/heads/feature"], { cwd: remote });
    expect(remoteHead.stdout.trim()).toBe((await fx.git("rev-parse", "HEAD")).trim());
  });

  test("plain push to the upstream", async () => {
    const { fx, git, remote } = await withRemote();
    await fx.write("a.txt", "more\n");
    await fx.commitAll("more");
    await git.push();
    const remoteHead = await fx.gitRaw(["rev-parse", "refs/heads/main"], { cwd: remote });
    expect(remoteHead.stdout.trim()).toBe((await fx.git("rev-parse", "HEAD")).trim());
  });

  test("fetch then pull --ff-only fast-forwards", async () => {
    const { fx, git, remote } = await withRemote();
    const other = await fx.clone(remote, "other");
    await other.write("b.txt", "from other\n");
    await other.commitAll("from other");
    await other.git("push", "-q", "origin", "main");

    await git.fetch();
    expect((await git.status()).branch).toMatchObject({ ahead: 0, behind: 1 });
    await git.pull();
    expect(await fx.read("b.txt")).toBe("from other\n");
    expect((await git.status()).branch).toMatchObject({ ahead: 0, behind: 0 });
  });

  test("diverged branches: pull refuses (not-fast-forward) and push is rejected, never forced", async () => {
    const { fx, git, remote } = await withRemote();
    const other = await fx.clone(remote, "other");
    await other.write("b.txt", "theirs\n");
    await other.commitAll("theirs");
    await other.git("push", "-q", "origin", "main");
    await fx.write("c.txt", "ours\n");
    await fx.commitAll("ours");
    const ours = (await fx.git("rev-parse", "HEAD")).trim();

    const pullError = await git.pull().catch((e: unknown) => e);
    expect(gitFailureKind(pullError)).toBe("not-fast-forward");
    expect((await fx.git("rev-parse", "HEAD")).trim()).toBe(ours);

    const pushError = await git.push().catch((e: unknown) => e);
    expect(gitFailureKind(pushError)).toBe("rejected");
    const remoteHead = await fx.gitRaw(["rev-parse", "refs/heads/main"], { cwd: remote });
    expect(remoteHead.stdout.trim()).toBe((await other.git("rev-parse", "HEAD")).trim());
  });

  test("fetch from a named remote, and unknown remotes are rejected", async () => {
    const { git } = await withRemote();
    await git.fetch({ remote: "origin", prune: true });
    const error = await git.fetch({ remote: "--upload-pack=touch pwned" }).catch((e: unknown) => e);
    expect(isLucyError(error, "INVALID_ARGUMENT")).toBe(true);
    const pushError = await git.push({ setUpstream: true, remote: "nope" }).catch((e: unknown) => e);
    expect(isLucyError(pushError, "INVALID_ARGUMENT")).toBe(true);
  });

  test("a hanging transport is killed by the timeout", async () => {
    const { fx } = await withRemote();
    const fakeSsh = await writeScript(join(fx.base, "fake-ssh"), "sleep 5");
    await fx.git("remote", "add", "slow", "ssh://example.invalid/repo.git");
    const git = await openGitRepository(fx.root, { env: { ...fx.env, GIT_SSH_COMMAND: fakeSsh } });
    deferCleanup(() => git.dispose());
    const started = performance.now();
    const error = await git.fetch({ remote: "slow", timeoutMs: 500 }).catch((e: unknown) => e);
    expect(isLucyError(error, "TIMEOUT")).toBe(true);
    expect(gitFailureKind(error)).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test("authentication failures are typed; network commands never get a terminal prompt", async () => {
    const { fx } = await withRemote();
    const envDump = join(fx.base, "ssh-env.txt");
    const fakeSsh = await writeScript(
      join(fx.base, "fake-ssh"),
      `env > "${envDump}"\necho "git@example.invalid: Permission denied (publickey)." >&2\nexit 255`,
    );
    await fx.git("remote", "add", "locked", "ssh://git@example.invalid/repo.git");
    const git = await openGitRepository(fx.root, { env: { ...fx.env, GIT_SSH_COMMAND: fakeSsh } });
    deferCleanup(() => git.dispose());
    const error = await git.fetch({ remote: "locked" }).catch((e: unknown) => e);
    expect(gitFailureKind(error)).toBe("auth-required");
    const env = await Bun.file(envDump).text();
    expect(env).toContain("GIT_TERMINAL_PROMPT=0");
    expect(env).toContain("SSH_ASKPASS_REQUIRE=force");
    expect(env).toMatch(/^SSH_ASKPASS=\S+/m);
    expect(env).not.toContain("GPG_TTY=");
  });
});
