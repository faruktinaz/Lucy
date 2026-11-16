import { describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { discoverRepository, gitFailureKind, openGitRepository, toWorkspacePath } from "@/adapters/git";
import { isLucyError } from "@/core/errors";
import { fixtureEnv } from "../helpers/git-fixture";
import { fixture, openAt, registerCleanup, tempDir, writeScript } from "./support";

registerCleanup();

describe("discoverRepository", () => {
  test("repository at the root", async () => {
    const fx = await fixture({ files: { "a.txt": "a\n" }, commit: "init" });
    const found = await discoverRepository(fx.root, { env: fx.env });
    expect(found.kind).toBe("repository");
    if (found.kind !== "repository") return;
    expect(found.repository).toMatchObject({
      root: fx.root,
      gitDir: join(fx.root, ".git"),
      commonDir: join(fx.root, ".git"),
      isLinkedWorktree: false,
      workspaceRoot: fx.root,
      workspacePrefix: "",
    });
    expect(found.repository.gitVersion).toMatch(/^\d+\.\d+/);
  });

  test("workspace opened at a subdirectory, through a symlink", async () => {
    const fx = await fixture({
      files: { "packages/app/src/x.ts": "x\n", "README.md": "r\n" },
      commit: "init",
    });
    const link = join(fx.base, "link-to-app");
    await symlink(join(fx.root, "packages", "app"), link);
    const git = await openAt(fx, link);
    expect(git.repository.root).toBe(fx.root);
    expect(git.repository.workspacePrefix).toBe("packages/app");
    expect(git.repository.workspaceRoot).toBe(link);
    await fx.write("packages/app/src/x.ts", "changed\n");
    await fx.write("README.md", "changed\n");
    const status = await git.status();
    // Status is repository-wide and repo-relative, whatever the workspace directory.
    expect(status.unstaged.map((c) => c.path).sort()).toEqual(["README.md", "packages/app/src/x.ts"]);
    expect(toWorkspacePath(git.repository, "packages/app/src/x.ts")).toBe("src/x.ts");
    expect(toWorkspacePath(git.repository, "README.md")).toBeNull();
    expect((await git.diff({ path: "packages/app/src/x.ts" })).patch).toContain("+changed");
  });

  test("not a repository", async () => {
    const dir = tempDir();
    const env = fixtureEnv(dir);
    expect(await discoverRepository(dir, { env: { ...env, GIT_CEILING_DIRECTORIES: dir } })).toEqual({
      kind: "not-a-repository",
      cwd: dir,
    });
    const error = await openGitRepository(dir, { env: { ...env, GIT_CEILING_DIRECTORIES: dir } }).catch(
      (e: unknown) => e,
    );
    expect(isLucyError(error, "NOT_A_REPOSITORY")).toBe(true);
  });

  test("bare repository", async () => {
    const fx = await fixture({ bare: true });
    const found = await discoverRepository(fx.root, { env: fx.env });
    expect(found).toMatchObject({ kind: "bare-repository", gitDir: fx.root });
    const error = await openGitRepository(fx.root, { env: fx.env }).catch((e: unknown) => e);
    expect(isLucyError(error, "UNSUPPORTED")).toBe(true);
    expect(gitFailureKind(error)).toBe("bare-repository");
  });

  test("inside .git is not a working tree", async () => {
    const fx = await fixture({ files: { "a.txt": "a\n" }, commit: "init" });
    expect((await discoverRepository(join(fx.root, ".git"), { env: fx.env })).kind).toBe("not-a-repository");
  });

  test("git executable missing is distinct from not-a-repository", async () => {
    const dir = tempDir();
    const emptyBin = join(dir, "empty-bin");
    await mkdir(emptyBin);
    expect(await discoverRepository(dir, { env: { PATH: emptyBin } })).toEqual({ kind: "git-missing" });
    expect(await discoverRepository(dir, { gitPath: join(dir, "no-such-git") })).toEqual({
      kind: "git-missing",
    });
    const error = await openGitRepository(dir, { env: { PATH: emptyBin } }).catch((e: unknown) => e);
    expect(gitFailureKind(error)).toBe("git-missing");
  });

  test("too-old Git is reported with its version", async () => {
    const dir = tempDir();
    const fakeGit = await writeScript(join(dir, "old-git"), 'echo "git version 2.17.1"');
    expect(await discoverRepository(dir, { gitPath: fakeGit })).toEqual({
      kind: "git-too-old",
      gitVersion: "2.17.1",
      minimumVersion: "2.25.0",
    });
  });

  test("missing directory is a filesystem error, not 'git missing'", async () => {
    const dir = tempDir();
    const error = await discoverRepository(join(dir, "nope")).catch((e: unknown) => e);
    expect(isLucyError(error, "NOT_FOUND")).toBe(true);
  });
});
