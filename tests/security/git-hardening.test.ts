/**
 * Items: one hardened way to run Git everywhere, and no lazy network fetch.
 *
 * 1. A repository whose `.git/config` names programs (fsmonitor, pager, external diff, textconv)
 *    must not get them run by the secondary Git paths: the explorer's ignore detection, the file
 *    index and the git-grep engine. They now share the adapter's read-only hardening.
 * 2. In a partial clone, background reads must not download missing objects from the promisor
 *    remote. The remote is a local bare repository reached over `file://` whose upload-pack is
 *    wrapped to leave a marker, so "contacted the remote" is observable without any network.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitIgnoreOracle } from "@/adapters/filesystem/git-ignore";
import { openGitRepository } from "@/adapters/git";
import { ContentSearch } from "@/adapters/search/content-search";
import { FileIndex } from "@/adapters/search/file-index";
import { isLucyError } from "@/core/errors";
import { run } from "@/core/process";
import { createFixtureRepo, type FixtureRepo } from "../helpers/git-fixture";

setDefaultTimeout(30_000);

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function fixture(files: Record<string, string>): Promise<FixtureRepo> {
  const fx = await createFixtureRepo({ files, commit: "init" });
  cleanups.push(() => fx.dispose());
  return fx;
}

async function script(path: string, body: string): Promise<string> {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

describe("secondary Git paths under a hostile .git/config", () => {
  test("ignore detection, file index and git grep never run configured programs", async () => {
    const fx = await fixture({
      "a.txt": "needle one\n",
      ".gitignore": "*.log\n",
      ".gitattributes": "*.txt diff=evil\n",
    });
    const markers = join(fx.base, "markers");
    await mkdir(markers);
    const marker = (name: string) =>
      script(join(fx.base, `${name}.sh`), `touch "${markers}/${name}"\ncat >/dev/null 2>&1\nexit 0`);
    await fx.git("config", "core.fsmonitor", await marker("fsmonitor"));
    await fx.git("config", "core.pager", await marker("pager"));
    await fx.git("config", "pager.grep", await marker("pager-grep"));
    await fx.git("config", "diff.external", await marker("external"));
    await fx.git("config", "diff.evil.textconv", await marker("textconv"));
    await fx.write("a.txt", "needle changed\n");
    await fx.write("untracked.txt", "needle untracked\n");
    await fx.write("debug.log", "needle ignored\n");

    // Sanity: plain Git runs these programs from this config, so an empty marker list means
    // something. (`grep -O` opens files in the configured pager; status runs fsmonitor.)
    await fx.gitRaw(["status"]);
    await fx.gitRaw(["diff"]);
    await fx.gitRaw(["grep", "-O", "needle"]);
    const live = await readdir(markers);
    expect(live).toContain("fsmonitor");
    expect(live).toContain("external");
    expect(live.some((name) => name.startsWith("pager"))).toBe(true);
    for (const name of live) await fx.remove(`../markers/${name}`);
    expect(await readdir(markers)).toEqual([]);

    const oracle = new GitIgnoreOracle(fx.env);
    expect(await oracle.isInWorkTree(fx.root)).toBe(true);
    const ignored = await oracle.checkIgnored(fx.root, ["a.txt", "untracked.txt", "debug.log"]);
    expect([...ignored]).toEqual(["debug.log"]);

    const index = new FileIndex({ root: fx.root, env: fx.env, strategies: ["git"] });
    const listing = await index.list();
    expect(listing.strategy).toBe("git");
    expect(listing.files).toEqual([".gitattributes", ".gitignore", "a.txt", "untracked.txt"]);

    const search = new ContentSearch({ root: fx.root, engine: "git-grep", env: fx.env, ripgrepPath: null });
    for (const query of [{ pattern: "needle" }, { pattern: "need(le)", isRegex: true }]) {
      const paths: string[] = [];
      await search.search(query, { onMatches: (batch) => paths.push(...batch.map((m) => m.path)) });
      expect(paths.sort()).toEqual(["a.txt", "untracked.txt"]);
    }

    expect(await readdir(markers)).toEqual([]);
  });
});

describe("partial clone: no lazy fetch from the promisor remote", () => {
  test("a diff and a file read that need a missing blob fail or degrade without contacting the remote", async () => {
    const fx = await fixture({ "a.txt": "a v1\n", "b.txt": "b v1\n" });
    await fx.write("a.txt", "a v2\n");
    await fx.write("b.txt", "b v2\n");
    await fx.commitAll("two");

    const remote = join(fx.base, "remote.git");
    const clone = join(fx.base, "clone");
    const marker = join(fx.base, "remote-contacted");
    const git = async (cwd: string, args: string[], extra: Record<string, string> = {}) =>
      run(["git", ...args], { cwd, env: { ...fx.env, ...extra }, timeoutMs: 30_000 });
    expect((await git(fx.base, ["clone", "-q", "--bare", fx.root, remote])).code).toBe(0);
    await git(remote, ["config", "uploadpack.allowFilter", "true"]);
    await git(remote, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
    const cloned = await git(fx.base, ["clone", "-q", "--filter=blob:none", `file://${remote}`, clone]);
    expect(cloned.code).toBe(0);
    // Every connection to the "remote" runs this wrapper first.
    const uploadPack = await script(
      join(fx.base, "upload-pack.sh"),
      `touch "${marker}"\nexec git-upload-pack "$@"`,
    );
    await git(clone, ["config", "remote.origin.uploadpack", uploadPack]);
    const contacted = () => Bun.file(marker).exists();

    // Sanity: without GIT_NO_LAZY_FETCH, reading an old blob downloads it through the wrapper.
    const lazy = await git(clone, ["cat-file", "blob", "HEAD~1:b.txt"]);
    expect(lazy.stdout).toBe("b v1\n");
    expect(await contacted()).toBe(true);
    await run(["rm", "-f", marker]);

    // Point the index at a.txt's old, missing blob (without fetching it), so the staged and
    // unstaged diffs of a.txt both need an object that is not on disk.
    // (`git reset` itself would need the blob; `update-index --cacheinfo` only needs its id.)
    const noFetch = { GIT_NO_LAZY_FETCH: "1" };
    const oldBlob = (await git(clone, ["rev-parse", "HEAD~1:a.txt"], noFetch)).stdout.trim();
    const cacheinfo = await git(clone, ["update-index", "--cacheinfo", `100644,${oldBlob},a.txt`], noFetch);
    expect(cacheinfo.code).toBe(0);
    expect(await contacted()).toBe(false);

    const adapter = await openGitRepository(clone, { env: fx.env });
    cleanups.push(() => adapter.dispose());
    const status = await adapter.status();
    expect(status.staged.map((change) => change.path)).toEqual(["a.txt"]);
    expect(await contacted()).toBe(false);

    for (const target of [{ path: "a.txt", staged: true }, { path: "a.txt" }]) {
      const outcome = await adapter.diff(target).then(
        (diff) => ({ ok: true as const, diff }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      // Either a typed Git failure that names the missing object, or no content: never a fetch.
      if (!outcome.ok) {
        expect(isLucyError(outcome.error, "GIT_FAILED")).toBe(true);
        expect(String((outcome.error as { details?: { stderr?: string } }).details?.stderr)).toMatch(
          /promisor|lazy fetching disabled|missing|bad file/i,
        );
      }
    }
    const old = await adapter.fileAtRevision("a.txt", "HEAD~1");
    expect(old.content).toBeNull();

    expect(await contacted()).toBe(false);
    // The blob is still missing locally: nothing was downloaded behind our back.
    const check = await git(clone, ["cat-file", "-e", "HEAD~1:a.txt"], { GIT_NO_LAZY_FETCH: "1" });
    expect(check.code).not.toBe(0);
  });
});
