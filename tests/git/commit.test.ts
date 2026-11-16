import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { gitFailureKind } from "@/adapters/git";
import { isLucyError } from "@/core/errors";
import { registerCleanup, setup, writeScript } from "./support";

registerCleanup();

const UNICODE_MESSAGE =
  "Türkçe özet: şırınga ığüşöç ✓\n\nGövde satırı 1\n— em dash, «quotes», emoji 🚀\n\nSigned-ish: nobody";

describe("commit", () => {
  test("multi-line Unicode message is passed exactly via stdin", async () => {
    const { fx, git } = await setup({ files: { "seed.txt": "s\n" }, commit: "init" });
    await fx.write("f.txt", "x\n");
    await git.stage(["f.txt"]);
    const result = await git.commit({ message: UNICODE_MESSAGE });
    expect(result.oid).toBe((await fx.git("rev-parse", "HEAD")).trim());
    expect(result.shortOid.length).toBeGreaterThanOrEqual(7);
    expect(result.oid.startsWith(result.shortOid)).toBe(true);
    expect(result.summary).toBe("Türkçe özet: şırınga ığüşöç ✓");
    expect(result.branch).toBe("main");
    expect(await git.lastCommitMessage()).toBe(UNICODE_MESSAGE);
    expect((await git.status()).changes).toEqual([]);
  });

  test("messages that look like options are just text", async () => {
    const { fx, git } = await setup({ files: { "seed.txt": "s\n" }, commit: "init" });
    await fx.write("f.txt", "x\n");
    await git.stage(["f.txt"]);
    await git.commit({ message: "--no-verify --amend -m evil\n#123 not a comment" });
    expect(await git.lastCommitMessage()).toBe("--no-verify --amend -m evil\n#123 not a comment");
    expect((await fx.git("rev-list", "--count", "HEAD")).trim()).toBe("2");
  });

  test("first commit in an unborn repository", async () => {
    const { fx, git } = await setup();
    expect(await git.lastCommitMessage()).toBeNull();
    await fx.write("a.txt", "a\n");
    await git.stage(["a.txt"]);
    const result = await git.commit({ message: "root" });
    expect(result.summary).toBe("root");
    expect((await git.status()).branch.unborn).toBe(false);
  });

  test("amend with a new message and amend keeping the message", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "a\n" }, commit: "original message" });
    await fx.write("b.txt", "b\n");
    await git.stage(["b.txt"]);
    const kept = await git.commit({ amend: true });
    expect(kept.summary).toBe("original message");
    expect((await fx.git("rev-list", "--count", "HEAD")).trim()).toBe("1");
    expect((await fx.git("show", "--name-only", "--format=", "HEAD")).trim().split("\n").sort()).toEqual([
      "a.txt",
      "b.txt",
    ]);
    const renamed = await git.commit({ amend: true, message: "better message" });
    expect(renamed.summary).toBe("better message");
    expect((await fx.git("rev-list", "--count", "HEAD")).trim()).toBe("1");
  });

  test("signoff adds a trailer", async () => {
    const { fx, git } = await setup({ files: { "seed.txt": "s\n" }, commit: "init" });
    await fx.write("f.txt", "x\n");
    await git.stage(["f.txt"]);
    await git.commit({ message: "signed", signoff: true });
    expect(await git.lastCommitMessage()).toContain("Signed-off-by: Lucy Test <lucy-test@example.invalid>");
  });

  test("nothing staged gives the typed nothing-to-commit failure", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    await fx.write("a.txt", "unstaged change\n");
    const error = await git.commit({ message: "nope" }).catch((e: unknown) => e);
    expect(isLucyError(error, "GIT_FAILED")).toBe(true);
    expect(gitFailureKind(error)).toBe("nothing-to-commit");
    expect((await fx.git("rev-list", "--count", "HEAD")).trim()).toBe("1");
  });

  test("empty message is rejected before running Git", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    await fx.write("b.txt", "b\n");
    await git.stage(["b.txt"]);
    for (const message of ["", "   \n\t\n", undefined]) {
      const error = await git.commit({ message }).catch((e: unknown) => e);
      expect(isLucyError(error, "INVALID_ARGUMENT")).toBe(true);
      expect(gitFailureKind(error)).toBe("empty-message");
    }
    expect((await fx.git("rev-list", "--count", "HEAD")).trim()).toBe("1");
  });

  test("a failing pre-commit hook blocks the commit and surfaces its output", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    const hooks = join(git.repository.gitDir, "hooks");
    await mkdir(hooks, { recursive: true });
    await writeScript(join(hooks, "pre-commit"), 'echo "lint failed: no semicolons allowed" >&2\nexit 1');
    await fx.write("b.txt", "b\n");
    await git.stage(["b.txt"]);
    const error = await git.commit({ message: "blocked" }).catch((e: unknown) => e);
    expect(isLucyError(error, "GIT_FAILED")).toBe(true);
    expect(isLucyError(error) ? String(error.details?.stderr) : "").toContain(
      "lint failed: no semicolons allowed",
    );
    expect(isLucyError(error) ? error.message : "").toContain("lint failed");
    expect((await fx.git("rev-list", "--count", "HEAD")).trim()).toBe("1");
  });

  test("hooks run normally on success (commit-msg sees the message)", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    const hooks = join(git.repository.gitDir, "hooks");
    await mkdir(hooks, { recursive: true });
    const seen = join(fx.base, "hook-saw.txt");
    await writeScript(join(hooks, "commit-msg"), `cp "$1" "${seen}"`);
    await fx.write("b.txt", "b\n");
    await git.stage(["b.txt"]);
    await git.commit({ message: "hooked" });
    expect(await Bun.file(seen).text()).toBe("hooked\n");
  });

  test("a misconfigured signing program fails with its stderr", async () => {
    const { fx, git } = await setup({ files: { "a.txt": "a\n" }, commit: "init" });
    const fakeGpg = await writeScript(
      join(fx.base, "fake-gpg"),
      'echo "fake-gpg: no secret key" >&2\nexit 2',
    );
    await fx.git("config", "commit.gpgSign", "true");
    await fx.git("config", "gpg.program", fakeGpg);
    await fx.write("b.txt", "b\n");
    await git.stage(["b.txt"]);
    const error = await git.commit({ message: "signed?" }).catch((e: unknown) => e);
    expect(gitFailureKind(error)).toBe("signing-failed");
    expect(isLucyError(error) ? String(error.details?.stderr) : "").toContain("fake-gpg: no secret key");
  });
});
