import { describe, expect, test } from "bun:test";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { gitFailureKind, openGitRepository } from "@/adapters/git";
import { GitRunner } from "@/adapters/git/runner";
import { isLucyError } from "@/core/errors";
import { createFixtureRepo } from "../helpers/git-fixture";
import { deferCleanup, registerCleanup, setup, writeScript } from "./support";

registerCleanup();

async function listRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.map(String).filter((entry) => !entry.startsWith(".git/") && entry !== ".git");
}

describe("injection through file names", () => {
  const hostile = [
    "$(touch pwned)",
    "; rm -rf x",
    "--output=evil",
    "-rf",
    "`touch backtick`",
    "|| touch or",
    "*",
  ];

  test("names are data: status, stage, diff, commit, discard have no side effects", async () => {
    const { fx, git } = await setup({ files: { "x/keep.txt": "keep\n" }, commit: "init" });
    for (const name of hostile) await fx.write(name, `content of ${name}\n`);
    await fx.write("innocent.txt", "should stay untracked\n");
    const before = await listRecursive(fx.root);

    const untracked = (await git.status()).untracked.map((c) => c.path);
    expect(untracked.sort()).toEqual([...hostile, "innocent.txt"].sort());

    for (const name of hostile) {
      const diff = await git.diff({ path: name });
      expect(diff.patch).toContain(`+content of ${name}`);
    }
    await git.stage(hostile);
    const status = await git.status();
    expect(status.staged.map((c) => c.path).sort()).toEqual([...hostile].sort());
    // The file literally named "*" must not have staged everything.
    expect(status.untracked.map((c) => c.path)).toEqual(["innocent.txt"]);
    for (const name of hostile) {
      expect((await git.diff({ path: name, staged: true })).patch).toContain(`+content of ${name}`);
      expect((await git.fileAtRevision(name, "INDEX")).content).toBe(`content of ${name}\n`);
    }
    await git.commit({ message: "hostile names" });
    for (const name of hostile) await fx.write(name, "edited\n");
    const preview = await git.previewDiscard(hostile);
    expect(preview.every((entry) => entry.action === "restore")).toBe(true);
    await git.discard(hostile);
    for (const name of hostile) expect(await fx.read(name)).toBe(`content of ${name}\n`);

    expect(await listRecursive(fx.root)).toEqual(before);
    for (const marker of ["pwned", "evil", "backtick", "or"]) {
      expect(await fx.exists(marker)).toBe(false);
      expect(await Bun.file(join(fx.base, marker)).exists()).toBe(false);
      expect(await Bun.file(join(process.cwd(), marker)).exists()).toBe(false);
    }
    expect(await fx.read("x/keep.txt")).toBe("keep\n");
  });

  test("deleting an untracked file named like a glob deletes only that file", async () => {
    const { fx, git } = await setup({ files: { "seed.txt": "s\n" }, commit: "init" });
    await fx.write("*.txt", "glob-named\n");
    await fx.write("a.txt", "keep\n");
    await fx.write("b.txt", "keep\n");
    await git.discard(["*.txt"]);
    expect(await fx.exists("*.txt")).toBe(false);
    expect(await fx.exists("a.txt")).toBe(true);
    expect(await fx.exists("b.txt")).toBe(true);
  });

  test("non-normalized and absolute paths are rejected before reaching Git", async () => {
    const { git } = await setup({ files: { "seed.txt": "s\n" }, commit: "init" });
    for (const path of ["/etc/passwd", "../outside", "a/../../b", "./a", "a//b", "", "nul\0byte"]) {
      const error = await git.stage([path]).catch((e: unknown) => e);
      expect(isLucyError(error, "INVALID_ARGUMENT")).toBe(true);
    }
  });

  test("option-like revisions are rejected", async () => {
    const { git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    for (const revision of ["--output=/tmp/x", "-p", "HEAD:a.txt", "a b"]) {
      const error = await git.fileAtRevision("a.txt", revision).catch((e: unknown) => e);
      expect(isLucyError(error, "INVALID_ARGUMENT")).toBe(true);
    }
  });
});

describe("hostile repository configuration", () => {
  test("fsmonitor, external diff and textconv from .git/config never run", async () => {
    const { fx, git } = await setup({
      files: { "a.txt": "a\n", ".gitattributes": "*.txt diff=evil\n" },
      commit: "init",
    });
    const markers = join(fx.base, "markers");
    await mkdir(markers);
    const script = (name: string) =>
      writeScript(join(fx.base, `${name}.sh`), `touch "${markers}/${name}"\ncat >/dev/null 2>&1\nexit 0`);
    await fx.git("config", "core.fsmonitor", await script("fsmonitor"));
    await fx.git("config", "diff.external", await script("external"));
    await fx.git("config", "diff.evil.textconv", await script("textconv"));
    await fx.git("config", "core.pager", await script("pager"));
    await fx.write("a.txt", "changed\n");
    await fx.write("new.txt", "new\n");
    await fx.write("staged.txt", "staged\n");
    await fx.git("add", "staged.txt");

    // Sanity: plain Git really runs each vector, so the assertions below are meaningful.
    await fx.gitRaw(["status"]);
    await fx.gitRaw(["diff"]);
    await fx.gitRaw(["diff", "--no-ext-diff"]);
    expect((await readdir(markers)).sort()).toEqual(["external", "fsmonitor", "textconv"]);
    for (const marker of await readdir(markers)) await fx.remove(`../markers/${marker}`);

    await git.status();
    await git.diff({ path: "a.txt" });
    await git.diff({ path: "staged.txt", staged: true });
    await git.diff({ path: "new.txt" });
    await git.fileAtRevision("a.txt", "HEAD");
    await git.fileAtRevision("a.txt", "INDEX");
    await git.log({ path: "a.txt" });
    await git.lastCommitMessage();
    await git.branches();
    await git.stashList();
    await git.previewDiscard(["a.txt", "new.txt"]);
    await git.stage(["a.txt"]);
    await git.unstageAll();
    expect(await readdir(markers)).toEqual([]);
  });

  test("the configured editor is never opened", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    const marker = join(fx.base, "editor-ran");
    await fx.git("config", "core.editor", await writeScript(join(fx.base, "editor.sh"), `touch "${marker}"`));
    await fx.write("b.txt", "b\n");
    await git.stage(["b.txt"]);
    await git.commit({ amend: true });
    await git.commit({ amend: true, message: "new message" });
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("inherited GIT_DIR / GIT_INDEX_FILE cannot retarget the adapter", async () => {
    const { fx } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    const decoy = await createFixtureRepo({ files: { "decoy.txt": "d\n" }, commit: "decoy" });
    deferCleanup(() => decoy.dispose());
    await fx.write("mine.txt", "mine\n");
    const git = await openGitRepository(fx.root, {
      env: {
        ...fx.env,
        GIT_DIR: join(decoy.root, ".git"),
        GIT_WORK_TREE: decoy.root,
        GIT_INDEX_FILE: join(decoy.root, ".git", "index"),
        GIT_GLOB_PATHSPECS: "1",
      },
    });
    deferCleanup(() => git.dispose());
    expect(git.repository.root).toBe(fx.root);
    expect((await git.status()).untracked.map((c) => c.path)).toEqual(["mine.txt"]);
    await git.stage(["mine.txt"]);
    expect((await decoy.git("status", "--porcelain")).trim()).toBe("");
  });

  test("hooks run in the user's environment: no pathspec mode leaks into them", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    const dump = join(fx.base, "hook-env.txt");
    const hooks = join(git.repository.gitDir, "hooks");
    await mkdir(hooks, { recursive: true });
    await writeScript(join(hooks, "pre-commit"), `env > "${dump}"`);
    await fx.write("b.txt", "b\n");
    await git.stage(["b.txt"]);
    await git.commit({ message: "hooked" });
    const env = await Bun.file(dump).text();
    expect(env).not.toContain("GIT_LITERAL_PATHSPECS");
    expect(env).not.toContain("GIT_OPTIONAL_LOCKS");
  });
});

describe("guard rails", () => {
  test("forced pushes, hard resets and hook bypasses cannot be issued", async () => {
    const { fx } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    const runner = new GitRunner({ cwd: fx.root, env: fx.env });
    deferCleanup(() => runner.dispose());
    for (const args of [
      ["push", "--force"],
      ["push", "-f"],
      ["push", "--force-with-lease"],
      ["push", "origin", "+main"],
      ["commit", "--no-verify", "-m", "x"],
      ["reset", "--hard"],
      ["switch", "--discard-changes", "main"],
    ]) {
      const error = await runner.git(args).catch((e: unknown) => e);
      expect(isLucyError(error, "INTERNAL")).toBe(true);
    }
    // Paths after `--` are data, even when they look like forbidden flags.
    await fx.write("--force", "x\n");
    await runner.git(["add", "--", ":(literal)--force"], { kind: "write" });
  });

  test("a disposed adapter refuses new work", async () => {
    const { git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    git.dispose();
    const error = await git.status().catch((e: unknown) => e);
    expect(gitFailureKind(error)).toBe("cancelled");
  });
});
