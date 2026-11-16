import { describe, expect, test } from "bun:test";
import {
  classifyGitFailure,
  fromAbsolutePath,
  GitDecorationIndex,
  type GitFailureKind,
  type GitRepositoryInfo,
  gitFailureKind,
  isRetryableGitFailure,
  normalizeRepoPath,
  toAbsolutePath,
  toRepoPath,
  toWorkspacePath,
} from "@/adapters/git";
import { isGitVersionAtLeast, parseGitVersion } from "@/adapters/git/discovery";
import { buildGitEnvironment, GIT_BASE_ARGS, readOnlyGitInvocation } from "@/adapters/git/environment";
import { gitFailure } from "@/adapters/git/errors";
import { chunkPaths, literalPathspec, pathspecStdin } from "@/adapters/git/paths";
import { Coalescer, SerialQueue, withRetry } from "@/adapters/git/queue";
import { isLucyError } from "@/core/errors";

describe("classifyGitFailure", () => {
  const cases: Array<[string, GitFailureKind]> = [
    [
      "fatal: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git process seems to be running",
      "index-locked",
    ],
    ["On branch main\nnothing to commit, working tree clean", "nothing-to-commit"],
    ['no changes added to commit (use "git add" and/or "git commit -a")', "nothing-to-commit"],
    [
      "error: Your local changes to the following files would be overwritten by checkout:\n\tf.txt",
      "would-overwrite",
    ],
    [
      "error: Your local changes to the following files would be overwritten by merge:\n\ta.txt\nno changes added to commit",
      "would-overwrite",
    ],
    ["CONFLICT (content): Merge conflict in f.txt", "conflicts"],
    ["error: Committing is not possible because you have unmerged files.", "conflicts"],
    ["fatal: Not possible to fast-forward, aborting.", "not-fast-forward"],
    ["fatal: The current branch feature has no upstream branch.", "no-upstream"],
    ["There is no tracking information for the current branch.", "no-upstream"],
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", "auth-required"],
    [
      "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
      "auth-required",
    ],
    ["remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://x/'", "auth-required"],
    ["Host key verification failed.\nfatal: Could not read from remote repository.", "auth-required"],
    [" ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs", "rejected"],
    ["fatal: unable to access 'https://x/': Could not resolve host: x", "network"],
    ["error: gpg failed to sign the data\nfatal: failed to write commit object", "signing-failed"],
    ["Author identity unknown\n*** Please tell me who you are.", "identity-missing"],
    ["fatal: not a git repository (or any of the parent directories): .git", "not-a-repository"],
    ["fatal: detected dubious ownership in repository at '/x'", "unsafe-repository"],
    ["fatal: something new and unexpected", "failed"],
  ];
  for (const [output, kind] of cases) {
    test(`${kind}: ${output.split("\n")[0]}`, () => {
      expect(classifyGitFailure(output)).toBe(kind);
    });
  }

  test("gitFailure builds a typed LucyError with capped details", () => {
    const error = gitFailure({
      args: ["commit"],
      exitCode: 1,
      stderr: `${"x".repeat(20_000)}`,
      stdout: "nothing to commit",
    });
    expect(isLucyError(error, "GIT_FAILED")).toBe(true);
    expect(gitFailureKind(error)).toBe("nothing-to-commit");
    expect(String(error.details?.stderr).length).toBeLessThanOrEqual(8 * 1024 + 1);
    expect(error.details).toMatchObject({ exitCode: 1, args: ["commit"], retryable: false });
    const locked = gitFailure({
      args: ["add"],
      exitCode: 128,
      stderr: "index.lock': File exists",
      stdout: "",
    });
    expect(isRetryableGitFailure(locked)).toBe(true);
    expect(
      gitFailure({ args: ["x"], exitCode: 1, stderr: "hint: ignore me\nfatal: real reason", stdout: "" })
        .message,
    ).toBe("real reason");
  });
});

describe("buildGitEnvironment", () => {
  const base = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    LC_ALL: "tr_TR.UTF-8",
    LANG: "tr_TR.UTF-8",
    LANGUAGE: "tr",
    GIT_DIR: "/elsewhere/.git",
    GIT_INDEX_FILE: "/elsewhere/index",
    GIT_EXTERNAL_DIFF: "/evil",
    GIT_TRACE: "1",
    GIT_GLOB_PATHSPECS: "1",
    GPG_TTY: "/dev/ttys001",
    GIT_SSH_COMMAND: "ssh -i key",
  };

  test("messages in C, user locale preserved for everything else", () => {
    const env = buildGitEnvironment(base, "write");
    expect(env.LC_ALL).toBeUndefined();
    expect(env.LANGUAGE).toBeUndefined();
    expect(env.LC_MESSAGES).toBe("C");
    expect(env.LC_CTYPE).toBe("tr_TR.UTF-8");
    expect(env.LANG).toBe("tr_TR.UTF-8");
  });

  test("retargeting and tracing variables are removed; user transport config is kept", () => {
    const env = buildGitEnvironment(base, "read");
    for (const name of [
      "GIT_DIR",
      "GIT_INDEX_FILE",
      "GIT_EXTERNAL_DIFF",
      "GIT_TRACE",
      "GIT_GLOB_PATHSPECS",
      "GPG_TTY",
    ]) {
      expect(env[name]).toBeUndefined();
    }
    expect(env.GIT_SSH_COMMAND).toBe("ssh -i key");
    expect(env.HOME).toBe("/home/u");
  });

  test("no prompts, pagers or editors; optional locks only for reads", () => {
    const read = buildGitEnvironment(base, "read");
    expect(read).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      PAGER: "cat",
      GIT_EDITOR: "false",
      GIT_SEQUENCE_EDITOR: "false",
      GIT_MERGE_AUTOEDIT: "no",
      GCM_INTERACTIVE: "never",
      GIT_OPTIONAL_LOCKS: "0",
    });
    expect(
      buildGitEnvironment({ ...base, GIT_OPTIONAL_LOCKS: "0" }, "write").GIT_OPTIONAL_LOCKS,
    ).toBeUndefined();
  });

  test("network commands route SSH prompts to askpass", () => {
    const env = buildGitEnvironment(base, "network", { failingAskpass: "/usr/bin/false" });
    expect(env.SSH_ASKPASS).toBe("/usr/bin/false");
    expect(env.SSH_ASKPASS_REQUIRE).toBe("force");
    const userAskpass = buildGitEnvironment({ ...base, SSH_ASKPASS: "/opt/gui-askpass" }, "network", {
      failingAskpass: "/usr/bin/false",
    });
    expect(userAskpass.SSH_ASKPASS).toBe("/opt/gui-askpass");
    expect(buildGitEnvironment(base, "read").SSH_ASKPASS_REQUIRE).toBeUndefined();
  });

  test("lazy fetch from a promisor remote is off for background reads only", () => {
    expect(buildGitEnvironment(base, "read").GIT_NO_LAZY_FETCH).toBe("1");
    // Explicit user actions may fetch what they need; an inherited value never leaks into them.
    for (const kind of ["write", "network"] as const) {
      const env = buildGitEnvironment({ ...base, GIT_NO_LAZY_FETCH: "1" }, kind);
      expect(env.GIT_NO_LAZY_FETCH).toBeUndefined();
      expect("GIT_NO_LAZY_FETCH" in env).toBe(true);
    }
  });

  test("readOnlyGitInvocation: base args, read environment, detached", () => {
    const call = readOnlyGitInvocation(["ls-files", "-z"], { ...base, GIT_CONFIG_GLOBAL: "/dev/null" });
    expect(call.argv).toEqual(["git", ...GIT_BASE_ARGS, "ls-files", "-z"]);
    expect(call.detached).toBe(true);
    expect(call.env).toMatchObject({
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      GIT_CONFIG_GLOBAL: "/dev/null",
    });
    expect(call.env.GIT_DIR).toBeUndefined();
    expect(call.env.GIT_EXTERNAL_DIFF).toBeUndefined();
  });

  test("base args disable fsmonitor, pager and colors but not via a global pathspec mode", () => {
    expect(GIT_BASE_ARGS).toContain("--no-pager");
    expect(GIT_BASE_ARGS).toContain("core.fsmonitor=false");
    expect(GIT_BASE_ARGS).toContain("color.ui=false");
    expect(GIT_BASE_ARGS).toContain("core.quotepath=false");
    expect(GIT_BASE_ARGS).not.toContain("--literal-pathspecs");
  });
});

describe("paths", () => {
  const repo: GitRepositoryInfo = {
    root: "/private/var/repo",
    gitDir: "/private/var/repo/.git",
    commonDir: "/private/var/repo/.git",
    isLinkedWorktree: false,
    workspaceRoot: "/var/repo/packages/app",
    workspacePrefix: "packages/app",
    gitVersion: "2.50.1",
    precomposeUnicode: true,
  };

  test("normalizeRepoPath accepts normalized relative paths and NFC-normalizes when asked", () => {
    expect(normalizeRepoPath("a/b c/-d.txt")).toBe("a/b c/-d.txt");
    expect(normalizeRepoPath("vendor/nested/")).toBe("vendor/nested/");
    expect(normalizeRepoPath("ş".normalize("NFD"), true)).toBe("ş".normalize("NFC"));
    expect(normalizeRepoPath("ş".normalize("NFD"), false)).toBe("ş".normalize("NFD"));
    for (const bad of ["", "/abs", "a//b", "./a", "a/./b", "a/..", "../x", "x\0y"]) {
      expect(() => normalizeRepoPath(bad)).toThrow();
    }
  });

  test("workspace and repository paths convert consistently", () => {
    expect(toRepoPath(repo, "src/x.ts")).toBe("packages/app/src/x.ts");
    expect(toRepoPath(repo, "")).toBe("packages/app");
    expect(toRepoPath(repo, "./src/")).toBe("packages/app/src");
    expect(toWorkspacePath(repo, "packages/app/src/x.ts")).toBe("src/x.ts");
    expect(toWorkspacePath(repo, "packages/app")).toBe("");
    expect(toWorkspacePath(repo, "packages/application/x.ts")).toBeNull();
    expect(toWorkspacePath(repo, "README.md")).toBeNull();
    expect(toAbsolutePath(repo, "packages/app/x.ts")).toBe("/private/var/repo/packages/app/x.ts");
    expect(fromAbsolutePath(repo, "/private/var/repo/README.md")).toBe("README.md");
    // Through the symlinked workspace path as the user opened it.
    expect(fromAbsolutePath(repo, "/var/repo/packages/app/src/x.ts")).toBe("packages/app/src/x.ts");
    expect(fromAbsolutePath(repo, "/etc/passwd")).toBeNull();
    expect(fromAbsolutePath(repo, "/private/var/repo/..evil")).toBe("..evil");
  });

  test("literal pathspecs and stdin lists", () => {
    expect(literalPathspec(":(glob)*")).toBe(":(literal):(glob)*");
    expect(pathspecStdin(["a", "b\nc"])).toBe(":(literal)a\0:(literal)b\nc\0");
  });

  test("chunkPaths respects the byte budget", () => {
    const chunks = chunkPaths(["aaaa", "bbbb", "cccc", "dddd"], 10);
    expect(chunks).toEqual([
      ["aaaa", "bbbb"],
      ["cccc", "dddd"],
    ]);
    expect(chunkPaths([], 10)).toEqual([]);
  });
});

describe("git version", () => {
  test("parse and compare", () => {
    expect(parseGitVersion("2.50.1 (Apple Git-155)")).toEqual([2, 50, 1]);
    expect(parseGitVersion("2.39.5.windows.1")).toEqual([2, 39, 5]);
    expect(isGitVersionAtLeast("2.25.0", "2.25.0")).toBe(true);
    expect(isGitVersionAtLeast("2.24.9", "2.25.0")).toBe(false);
    expect(isGitVersionAtLeast("3.0", "2.25.0")).toBe(true);
    expect(isGitVersionAtLeast("garbage", "2.25.0")).toBe(false);
  });
});

describe("queue primitives", () => {
  test("SerialQueue runs tasks one at a time, in order, surviving failures", async () => {
    const queue = new SerialQueue();
    const events: string[] = [];
    let running = 0;
    const task =
      (name: string, fail = false) =>
      async () => {
        running++;
        expect(running).toBe(1);
        events.push(`start ${name}`);
        await Bun.sleep(5);
        events.push(`end ${name}`);
        running--;
        if (fail) throw new Error(name);
        return name;
      };
    const results = await Promise.allSettled([
      queue.run(task("a")),
      queue.run(task("b", true)),
      queue.run(task("c")),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(events).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(queue.size).toBe(0);
  });

  test("Coalescer: one in flight plus one trailing run for any burst", async () => {
    let runs = 0;
    const coalescer = new Coalescer(async () => {
      runs++;
      await Bun.sleep(10);
      return runs;
    });
    const results = await Promise.all(Array.from({ length: 8 }, () => coalescer.run()));
    expect(runs).toBe(2);
    expect(results).toEqual([1, 2, 2, 2, 2, 2, 2, 2]);
    expect(await coalescer.run()).toBe(3);
  });

  test("Coalescer recovers after a failing run", async () => {
    let calls = 0;
    const coalescer = new Coalescer(async () => {
      calls++;
      if (calls === 1) throw new Error("first fails");
      return calls;
    });
    const [first, second] = await Promise.allSettled([coalescer.run(), coalescer.run()]);
    expect(first.status).toBe("rejected");
    expect(second).toEqual({ status: "fulfilled", value: 2 });
  });

  test("withRetry retries only what it is told to", async () => {
    let attempts = 0;
    const value = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("retry me");
        return "ok";
      },
      () => true,
      [1, 1, 1],
    );
    expect(value).toBe("ok");
    let fatal = 0;
    await expect(
      withRetry(
        async () => {
          fatal++;
          throw new Error("fatal");
        },
        () => false,
        [1, 1],
      ),
    ).rejects.toThrow("fatal");
    expect(fatal).toBe(1);
  });
});

describe("GitDecorationIndex", () => {
  const index = new GitDecorationIndex([
    { path: "src/app/main.ts", worktree: "modified", conflicted: false },
    { path: "src/app/new.ts", worktree: "untracked", conflicted: false },
    { path: "src/lib/conflict.ts", worktree: "unmerged", conflicted: true, conflictKind: "both-modified" },
    { path: "docs/moved.md", origPath: "old/moved.md", index: "renamed", conflicted: false },
    { path: "şırınga.ts", index: "added", conflicted: false },
  ]);

  test("files", () => {
    expect(index.get("src/app/main.ts")).toMatchObject({
      kind: "file",
      status: "modified",
      letter: "M",
      unstaged: true,
    });
    expect(index.get("src/app/new.ts")).toMatchObject({ status: "untracked", letter: "?", untracked: true });
    expect(index.get("src/lib/conflict.ts")).toMatchObject({
      status: "unmerged",
      letter: "U",
      conflicted: true,
    });
    expect(index.get("docs/moved.md")).toMatchObject({ status: "renamed", staged: true, unstaged: false });
    expect(index.get("unchanged.ts")).toBeUndefined();
    expect(index.size).toBe(5);
  });

  test("directories aggregate descendants, conflicts win", () => {
    expect(index.get("src/app")).toMatchObject({
      kind: "directory",
      status: "modified",
      changeCount: 2,
      untracked: true,
    });
    expect(index.get("src")).toMatchObject({
      kind: "directory",
      status: "unmerged",
      changeCount: 3,
      conflicted: true,
    });
    expect(index.get("")).toMatchObject({ kind: "directory", changeCount: 5 });
    expect(index.hasChangesUnder("old")).toBe(true);
    expect(index.hasChangesUnder("src/app/")).toBe(true);
    expect(index.hasChangesUnder("tests")).toBe(false);
  });

  test("NFD lookups match NFC keys", () => {
    expect(index.get("şırınga.ts".normalize("NFD"))).toMatchObject({ status: "added" });
  });
});
