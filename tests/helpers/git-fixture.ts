/**
 * Isolated, deterministic Git repositories for tests. Shared with other engineers.
 *
 * Everything lives in a fresh `mkdtemp` directory. Git never sees the user's configuration:
 * global/system config are disabled, HOME and XDG_CONFIG_HOME point into the temp directory (so
 * ~/.config/git/ignore and attributes are not read either), templates are disabled (no sample
 * hooks), and identity and dates are fixed. Pass `fixture.env` to any adapter under test so it
 * runs with the same isolation.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type RunResult, run } from "@/core/process";

export const FIXTURE_IDENTITY = {
  name: "Lucy Test",
  email: "lucy-test@example.invalid",
  date: "2026-01-01T12:00:00+0000",
} as const;

/** Variables that would let an outer Git process (e.g. a hook running the tests) retarget Git. */
const INHERITED_GIT_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "GIT_EDITOR",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "GIT_TRACE",
  "GIT_TRACE2",
  "GIT_TRACE2_EVENT",
  "GIT_LITERAL_PATHSPECS",
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
] as const;

/** The isolated environment for a fixture whose home directory is `home`. */
export function fixtureEnv(home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: FIXTURE_IDENTITY.name,
    GIT_AUTHOR_EMAIL: FIXTURE_IDENTITY.email,
    GIT_AUTHOR_DATE: FIXTURE_IDENTITY.date,
    GIT_COMMITTER_NAME: FIXTURE_IDENTITY.name,
    GIT_COMMITTER_EMAIL: FIXTURE_IDENTITY.email,
    GIT_COMMITTER_DATE: FIXTURE_IDENTITY.date,
    TZ: "UTC",
    LC_ALL: "C",
    LANGUAGE: undefined,
  };
  for (const name of INHERITED_GIT_VARIABLES) env[name] = undefined;
  return env;
}

export interface TempDir {
  /** Symlink-resolved absolute path (on macOS `/var` is a symlink to `/private/var`). */
  path: string;
  dispose(): void;
}

export function createTempDir(prefix = "lucy-git-"): TempDir {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return {
    path,
    dispose: () => rmSync(path, { recursive: true, force: true }),
  };
}

export interface FixtureRepo {
  /** Absolute, symlink-resolved working tree root. */
  root: string;
  /** Temp directory holding the repo, its fake HOME and any remotes. Removed by `dispose`. */
  base: string;
  /** Environment to pass to adapters (`openGitRepository(root, { env: fixture.env })`). */
  env: Record<string, string | undefined>;
  /** Runs Git in `root` (or `options.cwd`); throws with stderr on a non-zero exit. Returns stdout. */
  git(...args: string[]): Promise<string>;
  /** Runs Git and returns the full result without throwing. */
  gitRaw(args: readonly string[], options?: { cwd?: string; stdin?: string }): Promise<RunResult>;
  /** Writes a file relative to `root`, creating parent directories. */
  write(path: string, content: string | Uint8Array): Promise<void>;
  read(path: string): Promise<string>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** `git add -A && git commit -m message`; returns the new commit id. */
  commitAll(message: string): Promise<string>;
  /** Creates a bare repository under `base` and adds it as a remote. Returns its path. */
  addBareRemote(name?: string): Promise<string>;
  /** Clones `source` (a path) under `base`, returning a fixture-like handle sharing this cleanup. */
  clone(source: string, directory: string): Promise<FixtureRepo>;
  dispose(): void;
}

export interface FixtureOptions {
  /** Default `true`. `false` leaves a plain directory (not a repository). */
  init?: boolean;
  /** Files to write before the first commit. */
  files?: Record<string, string | Uint8Array>;
  /** Commit the initial files with this message (requires `files`). */
  commit?: string;
  /** Create a bare repository instead of a working tree. */
  bare?: boolean;
}

async function gitIn(
  cwd: string,
  env: Record<string, string | undefined>,
  args: readonly string[],
  stdin?: string,
): Promise<RunResult> {
  return run(["git", ...args], { cwd, env, stdin, timeoutMs: 30_000 });
}

function handle(
  root: string,
  base: string,
  env: Record<string, string | undefined>,
  cleanup: () => void,
): FixtureRepo {
  const fixture: FixtureRepo = {
    root,
    base,
    env,
    async gitRaw(args, options) {
      return gitIn(options?.cwd ?? root, env, args, options?.stdin);
    },
    async git(...args) {
      const result = await gitIn(root, env, args);
      if (result.code !== 0) {
        throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
      }
      return result.stdout;
    },
    async write(path, content) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    },
    read: (path) => readFile(join(root, path), "utf8"),
    remove: (path) => rm(join(root, path), { recursive: true, force: true }),
    async exists(path) {
      try {
        await lstat(join(root, path));
        return true;
      } catch {
        return false;
      }
    },
    async commitAll(message) {
      await fixture.git("add", "-A");
      await fixture.git("commit", "-q", "-m", message);
      return (await fixture.git("rev-parse", "HEAD")).trim();
    },
    async addBareRemote(name = "origin") {
      const path = join(base, `${name}-remote.git`);
      await gitIn(base, env, ["init", "-q", "--bare", "--template=", "--initial-branch=main", path]);
      await fixture.git("remote", "add", name, path);
      return path;
    },
    async clone(source, directory) {
      const target = join(base, directory);
      const result = await gitIn(base, env, ["clone", "-q", "--template=", source, target]);
      if (result.code !== 0) throw new Error(`git clone failed: ${result.stderr.trim()}`);
      return handle(target, base, env, () => {});
    },
    dispose: cleanup,
  };
  return fixture;
}

/** Creates an isolated repository on branch `main`. Always `dispose()` it (e.g. in `afterEach`). */
export async function createFixtureRepo(options: FixtureOptions = {}): Promise<FixtureRepo> {
  const temp = createTempDir("lucy-git-fixture-");
  try {
    const home = join(temp.path, "home");
    mkdirSync(join(home, ".config"), { recursive: true });
    const env = fixtureEnv(home);
    const root = join(temp.path, options.bare ? "repo.git" : "repo");
    mkdirSync(root, { recursive: true });
    const fixture = handle(root, temp.path, env, temp.dispose);
    if (options.init !== false) {
      const args = ["init", "-q", "--template=", "--initial-branch=main"];
      if (options.bare) args.push("--bare");
      await fixture.git(...args);
    }
    for (const [path, content] of Object.entries(options.files ?? {})) await fixture.write(path, content);
    if (options.commit) await fixture.commitAll(options.commit);
    return fixture;
  } catch (error) {
    temp.dispose();
    throw error;
  }
}
