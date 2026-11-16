import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { buildDemoWorkspace, type DemoWorkspace, isolatedGitEnv } from "../../src/app/demo";
import { OWNER_MARKER_NAME, realTempDir, removeOwnedDirectory } from "../../src/app/demo/ownership";
import { isLucyError } from "../../src/core/errors";
import { run } from "../../src/core/process";
import { parsePorcelainV2 } from "./porcelain-v2";

const OUTER_REPO = resolve(import.meta.dir, "../..");
const BUILD_TIMEOUT_MS = 60_000;

/** Every directory a test created, removed in `afterAll` even when a test fails midway. */
const leftovers: string[] = [];

function track(workspace: DemoWorkspace): DemoWorkspace {
  leftovers.push(workspace.containerDir);
  return workspace;
}

async function git(cwd: string, args: string[]): Promise<string> {
  // Optional locks off: reading status must never rewrite the index of the repository under test.
  const env = { ...isolatedGitEnv(resolve(cwd, "..")), GIT_OPTIONAL_LOCKS: "0" };
  const result = await run(["git", ...args], { cwd, env });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

async function status(root: string) {
  return parsePorcelainV2(await git(root, ["status", "--porcelain=v2", "-z", "--branch", "--show-stash"]));
}

/** Content hash of every file in the work tree (outside `.git`), keyed by relative path. */
function treeDigest(root: string): Record<string, string> {
  const digest: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (prefix === "" && name === ".git") continue;
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path, `${prefix}${name}/`);
      else
        digest[`${prefix}${name}`] =
          `${stat.mode.toString(8)}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
    }
  };
  walk(root, "");
  return digest;
}

/** Repository facts that any accidental Git write to the outer repository would change. */
async function outerRepositorySnapshot(): Promise<Record<string, string>> {
  const gitDir = join(OUTER_REPO, ".git");
  const read = (path: string) => (existsSync(path) ? readFileSync(path).toString("base64") : "<missing>");
  const refsDir = join(gitDir, "refs");
  const refs = readdirSync(refsDir, { recursive: true, encoding: "utf8" })
    .filter((path) => statSync(join(refsDir, path)).isFile())
    .map((path) => `${path} ${read(join(refsDir, path))}`)
    .sort()
    .join("\n");
  return {
    head: read(join(gitDir, "HEAD")),
    config: read(join(gitDir, "config")),
    index: read(join(gitDir, "index")),
    packedRefs: read(join(gitDir, "packed-refs")),
    refs,
    mergeHead: read(join(gitDir, "MERGE_HEAD")),
    // Restricted to paths this suite owns: other engineers edit the rest of the tree concurrently.
    ownedStatus: await git(OUTER_REPO, [
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
      "--",
      "examples/demo-project",
      "src/app/demo",
      "tests/demo",
    ]),
  };
}

let outerBefore: Record<string, string>;
let first: DemoWorkspace;
let second: DemoWorkspace;
let conflicted: DemoWorkspace;

beforeAll(async () => {
  outerBefore = await outerRepositorySnapshot();
  first = track(await buildDemoWorkspace());
  second = track(await buildDemoWorkspace());
  conflicted = track(await buildDemoWorkspace({ withConflict: true }));
}, BUILD_TIMEOUT_MS);

afterAll(() => {
  for (const workspace of [first, second, conflicted]) {
    try {
      workspace?.dispose();
    } catch {
      // Fall through to the forced cleanup below.
    }
  }
  const temp = realTempDir();
  for (const dir of leftovers) {
    if (dir.startsWith(`${temp}/`)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildDemoWorkspace", () => {
  test("produces the described Source Control groups", async () => {
    const parsed = await status(first.root);
    const expected = first.description.changes;
    expect(parsed.staged).toEqual(expected.staged);
    expect(parsed.unstaged).toEqual(expected.unstaged);
    expect(parsed.untracked.map((path) => path.normalize("NFC"))).toEqual(expected.untracked);
    expect(parsed.conflicted).toEqual([]);

    // The concrete facts the brief asks for, independent of the description.
    expect(parsed.unstaged.filter((change) => change.kind === "modified")).toHaveLength(4);
    expect(parsed.unstaged.filter((change) => change.kind === "deleted")).toHaveLength(1);
    expect(parsed.staged.find((change) => change.kind === "renamed")).toEqual({
      path: "docs/getting-started.md",
      kind: "renamed",
      from: "docs/setup.md",
    });
    const both = parsed.staged.filter((change) =>
      parsed.unstaged.some((other) => other.path === change.path),
    );
    expect(both.map((change) => change.path)).toEqual(["src/ui/components/CommandPalette.tsx"]);
    expect(parsed.untracked).toContain("bench/");
    expect(parsed.untracked.map((path) => path.normalize("NFC"))).toContain("docs/çalışma-notları.md");

    const all = await git(first.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const untrackedFiles = all
      .split("\0")
      .filter((entry) => entry.startsWith("?? "))
      .map((entry) => entry.slice(3).normalize("NFC"))
      .sort();
    expect(untrackedFiles).toEqual(expected.untrackedFiles);
  });

  test("checks out the feature branch, one commit ahead of its upstream, with one stash", async () => {
    const parsed = await status(first.root);
    const { head } = first.description;
    expect(parsed.head).toBe(head.branch);
    expect(parsed.upstream).toBe(head.upstream);
    expect(parsed.ahead).toBe(head.ahead);
    expect(parsed.behind).toBe(head.behind);
    expect(parsed.stashCount).toBe(1);

    expect((await git(first.root, ["stash", "list", "--format=%gs"])).trim().split("\n")).toEqual(
      first.description.stashes,
    );
    const branches = (
      await git(first.root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
    ).trim();
    expect(branches.split("\n")).toEqual(first.description.branches);
    const remotes = (
      await git(first.root, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"])
    ).trim();
    expect(remotes.split("\n")).toEqual(first.description.remoteBranches);

    const subjects = (await git(first.root, ["log", "--format=%s", "HEAD"])).trim().split("\n");
    expect(subjects).toEqual(first.description.headCommitSubjects);
    const mainCount = Number((await git(first.root, ["rev-list", "--count", "main"])).trim());
    expect(mainCount).toBe(first.description.mainCommitCount);
    expect(mainCount).toBeGreaterThanOrEqual(6);
    expect((await git(first.root, ["rev-list", "--count", "main..HEAD"])).trim()).toBe("2");
  });

  test("uses a local bare repository as origin, so nothing touches the network", async () => {
    const url = (await git(first.root, ["remote", "get-url", "origin"])).trim();
    expect(url).toBe(first.originDir);
    expect((await git(first.originDir, ["rev-parse", "--is-bare-repository"])).trim()).toBe("true");
  });

  test("lays out the fixture with renamed dotfiles and no outer-repository litter", () => {
    expect(existsSync(join(first.root, ".gitignore"))).toBe(true);
    expect(existsSync(join(first.root, "_gitignore"))).toBe(false);
    expect(existsSync(join(first.containerDir, OWNER_MARKER_NAME))).toBe(true);
    expect(existsSync(join(first.root, OWNER_MARKER_NAME))).toBe(false);
    expect(statSync(join(first.root, "scripts/dev.sh")).mode & 0o111).not.toBe(0);
  });

  test("is deterministic: identical hashes, status and files across builds", async () => {
    const refs = ["HEAD", "main", "fix/reload-shortcut", "origin/feature/command-palette", "refs/stash"];
    const firstRefs = await git(first.root, ["rev-parse", ...refs]);
    expect(await git(second.root, ["rev-parse", ...refs])).toBe(firstRefs);

    const statusArgs = [
      "status",
      "--porcelain=v2",
      "-z",
      "--branch",
      "--show-stash",
      "--untracked-files=all",
    ];
    expect(await git(second.root, statusArgs)).toBe(await git(first.root, statusArgs));
    expect(await git(second.root, ["ls-files", "--stage"])).toBe(
      await git(first.root, ["ls-files", "--stage"]),
    );
    expect(treeDigest(second.root)).toEqual(treeDigest(first.root));
  });

  test("leaves a merge in progress with an unmerged path in the conflict variant", async () => {
    const parsed = await status(conflicted.root);
    const expected = conflicted.description;
    expect(expected.merge).toEqual({ inProgress: true, branch: "fix/reload-shortcut" });
    expect(parsed.conflicted).toEqual(expected.changes.conflicted);
    expect(parsed.conflicted).toEqual(["src/ui/App.tsx"]);
    expect(parsed.staged).toEqual(expected.changes.staged);
    expect(parsed.unstaged).toEqual(expected.changes.unstaged);

    const mergeHead = readFileSync(join(conflicted.root, ".git/MERGE_HEAD"), "utf8").trim();
    expect(mergeHead).toBe((await git(conflicted.root, ["rev-parse", "fix/reload-shortcut"])).trim());
    const content = readFileSync(join(conflicted.root, "src/ui/App.tsx"), "utf8");
    expect(content).toContain("<<<<<<< HEAD");
    expect(content).toContain(">>>>>>> fix/reload-shortcut");
    // The rest of the history is unaffected by the variant.
    expect(await git(conflicted.root, ["rev-parse", "HEAD"])).toBe(
      await git(first.root, ["rev-parse", "HEAD"]),
    );
  });

  test("leaves the outer repository untouched", async () => {
    expect(await outerRepositorySnapshot()).toEqual(outerBefore);
  });
});

describe("buildDemoWorkspace safety", () => {
  test("refuses a target directory that exists and is not empty", async () => {
    const target = mkdtempSync(join(realTempDir(), "lucy-demo-test-"));
    try {
      writeFileSync(join(target, "keep.txt"), "user data\n");
      const attempt = buildDemoWorkspace({ targetDir: target });
      await expect(attempt).rejects.toThrow("not empty");
      await attempt.catch((error) => expect(isLucyError(error, "ALREADY_EXISTS")).toBe(true));
      expect(readdirSync(target)).toEqual(["keep.txt"]);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("refuses a target directory outside the temporary directory", async () => {
    const target = join(OUTER_REPO, "examples", "lucy-demo-must-not-exist");
    await expect(buildDemoWorkspace({ targetDir: target })).rejects.toThrow("temporary directory");
    expect(existsSync(target)).toBe(false);
  });

  test(
    "accepts an empty existing target and empties it on dispose without removing it",
    async () => {
      const target = mkdtempSync(join(realTempDir(), "lucy-demo-test-"));
      leftovers.push(target);
      const workspace = await buildDemoWorkspace({ targetDir: target });
      expect(workspace.containerDir).toBe(target);
      expect(existsSync(join(target, "orbit/.git"))).toBe(true);
      workspace.dispose();
      expect(readdirSync(target)).toEqual([]);
      rmSync(target, { recursive: true, force: true });
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "dispose refuses a directory whose ownership marker is missing",
    async () => {
      const workspace = track(await buildDemoWorkspace());
      rmSync(join(workspace.containerDir, OWNER_MARKER_NAME));
      let thrown: unknown;
      try {
        workspace.dispose();
      } catch (error) {
        thrown = error;
      }
      expect(isLucyError(thrown, "PERMISSION_DENIED")).toBe(true);
      expect(existsSync(workspace.root)).toBe(true);
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    "dispose removes the whole build, and is idempotent",
    async () => {
      const workspace = track(await buildDemoWorkspace());
      workspace.dispose();
      expect(existsSync(workspace.containerDir)).toBe(false);
      expect(() => workspace.dispose()).not.toThrow();
    },
    BUILD_TIMEOUT_MS,
  );

  test("removeOwnedDirectory refuses foreign markers and paths outside the temp directory", () => {
    const dir = mkdtempSync(join(realTempDir(), "lucy-demo-test-"));
    try {
      expect(() => removeOwnedDirectory(dir, "token")).toThrow("no ownership marker");
      writeFileSync(join(dir, OWNER_MARKER_NAME), JSON.stringify({ createdBy: "lucy-demo", token: "other" }));
      expect(() => removeOwnedDirectory(dir, "token")).toThrow("no ownership marker");
      mkdirSync(join(dir, "nested"));
      expect(existsSync(join(dir, "nested"))).toBe(true);
      expect(() => removeOwnedDirectory(OUTER_REPO, "token")).toThrow("not inside the temporary directory");
      expect(() => removeOwnedDirectory(realTempDir(), "token")).toThrow(
        "not inside the temporary directory",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
