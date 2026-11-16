/**
 * Runs Git for the demo builder in a fully isolated, deterministic environment.
 *
 * Nothing from the user's Git setup may leak in: their global and system configuration
 * could enable signing, hooks, a different default branch or conflict style, and any of
 * those would change hashes or make the build fail. Every `GIT_*` variable inherited from
 * the parent process is removed as well, because a stray `GIT_DIR` or `GIT_WORK_TREE`
 * (set, for example, when tests run inside a Git hook) would redirect commands to the
 * outer repository.
 */
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { LucyError } from "../../core/errors";
import { type RunResult, run } from "../../core/process";

export interface GitIdentity {
  name: string;
  email: string;
  /** ISO 8601 timestamp with an explicit offset, used for author and committer date. */
  date: string;
}

/** Applied as command-line configuration, which outranks every configuration file. */
const ISOLATED_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["init.defaultBranch", "main"],
  ["commit.gpgSign", "false"],
  ["tag.gpgSign", "false"],
  ["core.autocrlf", "false"],
  ["core.fsmonitor", "false"],
  // Pointing hooks at a non-directory disables them, including any template hooks.
  ["core.hooksPath", "/dev/null"],
  ["credential.helper", ""],
  ["gc.auto", "0"],
  ["maintenance.auto", "false"],
  ["merge.conflictStyle", "merge"],
  ["rerere.enabled", "false"],
  ["status.showUntrackedFiles", "normal"],
  ["status.renames", "true"],
  ["diff.renames", "true"],
  // Only local paths may be used as remotes, so a build can never reach the network.
  ["protocol.allow", "never"],
  ["protocol.file.allow", "always"],
];

/** Environment for a Git command that cannot see the user's configuration or an outer repository. */
export function isolatedGitEnv(
  ceilingDir: string,
  identity?: GitIdentity,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GIT_")) env[key] = undefined;
  }
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    // Repository discovery stops here, so a missing `.git` can never resolve to a parent repository.
    GIT_CEILING_DIRECTORIES: ceilingDir,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ADVICE: "0",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_PAGER: "cat",
    LC_ALL: "C",
    LANG: "C",
    TZ: "UTC",
    GIT_CONFIG_COUNT: String(ISOLATED_CONFIG.length),
  });
  ISOLATED_CONFIG.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  if (identity) {
    env.GIT_AUTHOR_NAME = identity.name;
    env.GIT_AUTHOR_EMAIL = identity.email;
    env.GIT_AUTHOR_DATE = identity.date;
    env.GIT_COMMITTER_NAME = identity.name;
    env.GIT_COMMITTER_EMAIL = identity.email;
    env.GIT_COMMITTER_DATE = identity.date;
  }
  return env;
}

export interface GitCallOptions {
  identity?: GitIdentity;
  stdin?: string;
  /** Exit codes that are expected results rather than failures. Default `[0]`. */
  okCodes?: readonly number[];
}

function failure(args: readonly string[], result: RunResult): LucyError {
  const reason = result.timedOut ? "timed out" : `exited with ${result.code ?? result.signal}`;
  return new LucyError(
    "GIT_FAILED",
    `git ${args[0]} ${reason}: ${result.stderr.trim() || result.stdout.trim()}`,
    {
      details: { args: [...args], code: result.code },
    },
  );
}

/**
 * A Git repository the demo builder created. Every command runs with the repository as its
 * explicit working directory and only after confirming that Git resolves that directory as
 * its own top level, so a mistake can never mutate the outer Lucy repository.
 */
export class DemoRepository {
  private constructor(
    /** Real (symlink-free) path of the work tree. */
    readonly root: string,
    private readonly ceilingDir: string,
    private readonly defaultIdentity: GitIdentity,
  ) {}

  /** Runs `git init` in `root`, which must be an existing directory the caller just created. */
  static async init(root: string, defaultIdentity: GitIdentity): Promise<DemoRepository> {
    const realRoot = realpathSync(root);
    const ceilingDir = dirname(realRoot);
    const args = ["init", "--quiet", "--template=", "--initial-branch=main"];
    const result = await run(["git", ...args], { cwd: realRoot, env: isolatedGitEnv(ceilingDir) });
    if (result.code !== 0) throw failure(args, result);
    const repository = new DemoRepository(realRoot, ceilingDir, defaultIdentity);
    await repository.assertOwnTopLevel();
    return repository;
  }

  /** Initialises a bare repository at `path` to act as the local `origin`. */
  static async initBare(path: string): Promise<void> {
    const parent = dirname(path);
    const args = ["init", "--quiet", "--bare", "--template=", "--initial-branch=main", path];
    const result = await run(["git", ...args], { cwd: parent, env: isolatedGitEnv(parent) });
    if (result.code !== 0) throw failure(args, result);
  }

  async assertOwnTopLevel(): Promise<void> {
    const args = ["rev-parse", "--show-toplevel"];
    const result = await run(["git", ...args], { cwd: this.root, env: isolatedGitEnv(this.ceilingDir) });
    if (result.code !== 0) throw failure(args, result);
    const topLevel = result.stdout.trim();
    if (topLevel !== this.root) {
      throw new LucyError("INTERNAL", "Refusing to run Git: the demo directory is not its own repository", {
        details: { root: this.root, topLevel },
      });
    }
  }

  async git(args: readonly string[], options: GitCallOptions = {}): Promise<RunResult> {
    await this.assertOwnTopLevel();
    const result = await run(["git", ...args], {
      cwd: this.root,
      env: isolatedGitEnv(this.ceilingDir, options.identity ?? this.defaultIdentity),
      stdin: options.stdin,
    });
    const okCodes = options.okCodes ?? [0];
    if (result.code === null || !okCodes.includes(result.code)) throw failure(args, result);
    return result;
  }
}
