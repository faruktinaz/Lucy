import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isWithin, realpathWithin, resolveAppDirs, tildify, toRelativePosix } from "@/core/paths";
import { makeTempDirs, type TempDirs } from "./helpers";

describe("resolveAppDirs", () => {
  test("LUCY_* overrides win when absolute", () => {
    expect(
      resolveAppDirs({ LUCY_CONFIG_DIR: "/c", LUCY_STATE_DIR: "/s", LUCY_CACHE_DIR: "/k", HOME: "/home/u" }),
    ).toEqual({ config: "/c", state: "/s", cache: "/k" });
  });

  test("XDG directories get a lucy subfolder; relative values are ignored", () => {
    const dirs = resolveAppDirs({
      XDG_CONFIG_HOME: "/xdg/config",
      XDG_STATE_HOME: "relative/state",
      LUCY_CACHE_DIR: "relative/cache",
      HOME: "/home/u",
    });
    expect(dirs).toEqual({
      config: "/xdg/config/lucy",
      state: "/home/u/.local/state/lucy",
      cache: "/home/u/.cache/lucy",
    });
  });

  test("defaults follow XDG under HOME on every platform", () => {
    expect(resolveAppDirs({ HOME: "/home/u" })).toEqual({
      config: "/home/u/.config/lucy",
      state: "/home/u/.local/state/lucy",
      cache: "/home/u/.cache/lucy",
    });
  });
});

describe("isWithin", () => {
  test.each([
    ["/a/b", "/a/b", true],
    ["/a/b", "/a/b/c", true],
    ["/a/b", "/a/b/c/../d", true],
    ["/a/b/", "/a/b/c", true],
    ["/a/b", "/a/b/..foo", true],
    ["/a/b", "/a/bc", false],
    ["/a/b", "/a", false],
    ["/a/b", "/a/b/../c", false],
    ["/a/b", "/x", false],
    ["/", "/anything", true],
  ])("isWithin(%s, %s) = %s", (root, target, expected) => {
    expect(isWithin(root, target)).toBe(expected);
  });
});

describe("realpathWithin", () => {
  let temp: TempDirs;
  let root: string;
  let outside: string;
  beforeEach(async () => {
    temp = await makeTempDirs();
    root = join(temp.root, "project");
    outside = join(temp.root, "outside");
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "");
    await writeFile(join(outside, "secret"), "");
  });
  afterEach(async () => {
    await temp.cleanup();
  });

  test("existing paths inside the root", async () => {
    expect(await realpathWithin(root, "src/a.ts")).toBe(join(root, "src", "a.ts"));
    expect(await realpathWithin(root, ".")).toBe(root);
  });

  test("lexical escapes are rejected", async () => {
    expect(await realpathWithin(root, "../outside/secret")).toBeNull();
    expect(await realpathWithin(root, "/etc/passwd")).toBeNull();
  });

  test("a symlink escaping the root is rejected", async () => {
    await symlink(join(outside, "secret"), join(root, "link"));
    await symlink(outside, join(root, "dirlink"));
    expect(await realpathWithin(root, "link")).toBeNull();
    expect(await realpathWithin(root, "dirlink/secret")).toBeNull();
  });

  test("a symlink pointing inside the root is followed", async () => {
    await symlink(join(root, "src"), join(root, "alias"));
    expect(await realpathWithin(root, "alias/a.ts")).toBe(join(root, "src", "a.ts"));
  });

  test("nonexistent targets resolve through their nearest existing ancestor", async () => {
    expect(await realpathWithin(root, "src/new/deep/file.ts")).toBe(
      join(root, "src", "new", "deep", "file.ts"),
    );
  });

  test("a symlinked parent cannot smuggle a new file outside", async () => {
    await symlink(outside, join(root, "escape"));
    expect(await realpathWithin(root, "escape/new-file")).toBeNull();
  });

  test("a dangling symlink pointing outside is rejected (a write would follow it)", async () => {
    await symlink(join(outside, "not-yet", "created"), join(root, "dangling"));
    expect(await realpathWithin(root, "dangling")).toBeNull();
    expect(await realpathWithin(root, "dangling/child")).toBeNull();
  });

  test("a symlink loop is rejected", async () => {
    await symlink(join(root, "loop-b"), join(root, "loop-a"));
    await symlink(join(root, "loop-a"), join(root, "loop-b"));
    expect(await realpathWithin(root, "loop-a/x")).toBeNull();
  });

  test("a symlinked root works and a missing root gives null", async () => {
    const rootLink = join(temp.root, "root-link");
    await symlink(root, rootLink);
    expect(await realpathWithin(rootLink, "src/a.ts")).toBe(join(root, "src", "a.ts"));
    expect(await realpathWithin(join(temp.root, "missing"), "x")).toBeNull();
  });
});

describe("toRelativePosix and tildify", () => {
  test("relative POSIX paths", () => {
    expect(toRelativePosix("/a/b", "/a/b/c/d.ts")).toBe("c/d.ts");
    expect(toRelativePosix("/a/b", "/a/b")).toBe("");
  });

  test("tildify replaces only a real home prefix", () => {
    expect(tildify("/home/u", "/home/u")).toBe("~");
    expect(tildify("/home/u/code", "/home/u")).toBe("~/code");
    expect(tildify("/home/user2/code", "/home/u")).toBe("/home/user2/code");
  });
});
