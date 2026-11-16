/**
 * Fixed flags and environment for every Git command Lucy runs. See README.md ("Threat model")
 * for why each entry exists; changing them weakens guarantees the tests pin down.
 */

/** What a command does, which decides locking and prompt policy. */
export type GitCommandKind = "read" | "write" | "network";

/**
 * Prepended to every invocation.
 * - `--no-pager`: never spawn `core.pager` (repository config could name any program).
 * - `core.quotepath=false`: UTF-8 names stay readable in diff headers.
 * - `core.fsmonitor=false`: never run a repository-configured fsmonitor hook.
 * - `color.ui=false`: machine-readable output regardless of user config.
 * - `log.showSignature=false`: `git log` must not run `gpg.program` to verify signatures.
 * - `i18n.logOutputEncoding=UTF-8`: log/stash output is decoded as UTF-8 regardless of repo config.
 *
 * Deliberately NOT `--literal-pathspecs`: it is exported to child processes as
 * `GIT_LITERAL_PATHSPECS=1`, which breaks Git's own internal pathspecs (`stash -u` runs
 * `git clean -- :/` and would leave untracked files behind) and changes how user hooks behave.
 * Every pathspec we pass carries `:(literal)` magic instead (see `paths.ts`).
 */
export const GIT_BASE_ARGS: readonly string[] = [
  "--no-pager",
  "-c",
  "core.quotepath=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "color.ui=false",
  "-c",
  "log.showSignature=false",
  "-c",
  "i18n.logOutputEncoding=UTF-8",
];

/**
 * Extra flags for commands that talk to remotes. The `ext::` transport runs arbitrary commands
 * from a remote URL; nobody needs it from a GUI, so it is refused even if repository config allows it.
 */
export const GIT_NETWORK_ARGS: readonly string[] = ["-c", "protocol.ext.allow=never"];

/**
 * Inherited variables that would silently retarget or reconfigure our commands: a `GIT_DIR` from
 * a parent hook, a global pathspec mode that conflicts with `--literal-pathspecs`, an external
 * diff driver, or tracing that pollutes the stderr we classify.
 */
const REMOVED_VARIABLES: readonly string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_EXTERNAL_DIFF",
  "GIT_DIFF_OPTS",
  "GIT_LITERAL_PATHSPECS",
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
  "GIT_TRACE",
  "GIT_TRACE2",
  "GIT_TRACE2_EVENT",
  "GIT_TRACE2_PERF",
  "GIT_TRACE_PACKET",
  "GIT_TRACE_PACKFILE",
  "GIT_TRACE_PERFORMANCE",
  "GIT_TRACE_SETUP",
  "GIT_TRACE_CURL",
  "GIT_TRACE_SHALLOW",
  "GIT_TRACE_FSMONITOR",
  "GIT_TRACE_REFS",
  "GIT_PAGER_IN_USE",
  // gettext would prefer LANGUAGE over LC_MESSAGES and translate the messages we classify.
  "LANGUAGE",
  // Without a TTY name, gpg/pinentry cannot draw a passphrase prompt over the TUI.
  "GPG_TTY",
];

/** Locale categories that keep the user's value so hooks see their usual locale. */
const PRESERVED_LOCALE_CATEGORIES = [
  "LC_CTYPE",
  "LC_COLLATE",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_MONETARY",
] as const;

export interface GitEnvironmentOptions {
  /** Absolute path of a program that exits non-zero, used as SSH askpass for network commands. */
  failingAskpass?: string | null;
}

/**
 * Builds the full environment for one Git command from the effective environment
 * (`process.env` plus adapter overrides). Keys mapped to `undefined` must be removed.
 *
 * Locale: only `LC_MESSAGES` is forced to `C` so messages are English and parseable. File names
 * are bytes to Git and stay UTF-8 regardless; keeping `LC_CTYPE` etc. means hooks (Ruby, Perl)
 * still run in the user's UTF-8 locale. A user `LC_ALL` would override `LC_MESSAGES`, so it is
 * removed and its value copied to the other categories instead.
 */
export function buildGitEnvironment(
  effective: Readonly<Record<string, string | undefined>>,
  kind: GitCommandKind,
  options: GitEnvironmentOptions = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...effective };
  for (const name of REMOVED_VARIABLES) env[name] = undefined;

  const lcAll = effective.LC_ALL;
  env.LC_ALL = undefined;
  if (lcAll) {
    for (const category of PRESERVED_LOCALE_CATEGORIES) env[category] = lcAll;
  }
  env.LC_MESSAGES = "C";

  // No command may ever block on a prompt, a pager or an editor. An unexpected editor
  // invocation fails the command (fail closed) instead of committing an unreviewed message.
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  env.GIT_EDITOR = "false";
  env.GIT_SEQUENCE_EDITOR = "false";
  env.GIT_MERGE_AUTOEDIT = "no";
  env.GCM_INTERACTIVE = "never";

  if (kind === "read") {
    // Background reads must never take index.lock: no contention with the user's own Git
    // commands (or Claude Code's) and no opportunistic index refresh writes.
    env.GIT_OPTIONAL_LOCKS = "0";
  } else {
    env.GIT_OPTIONAL_LOCKS = undefined;
  }

  if (kind === "read") {
    // In a partial clone (`--filter=blob:none`), a read that needs a missing object (a diff
    // against an old blob, `cat-file` of an old revision) would otherwise download it from the
    // promisor remote on demand. Reads run in the background (status, diffs, file contents), so
    // that would be network traffic nobody asked for. With this set, such a command fails
    // instead ("could not fetch ... from promisor remote", "bad file").
    // Requires Git 2.44 or newer (GIT_NO_LAZY_FETCH and --no-lazy-fetch arrived together in
    // 2.44.0); older Git ignores the variable, so on those versions the lazy fetch still happens.
    env.GIT_NO_LAZY_FETCH = "1";
  } else {
    // Write and network commands are explicit user actions (switch branch, stash, pull, push).
    // Fetching the objects they need is part of what the user asked for, and refusing would
    // break branch switching in partial clones. An inherited value must not leak into them.
    env.GIT_NO_LAZY_FETCH = undefined;
  }

  if (kind === "network") {
    // ssh opens /dev/tty for passphrases and host-key questions, which would corrupt the TUI.
    // Forcing askpass routes every prompt to a program; without a user-provided one it is a
    // program that fails, so ssh reports an authentication failure instead of hanging.
    if (!effective.SSH_ASKPASS && options.failingAskpass) env.SSH_ASKPASS = options.failingAskpass;
    if (env.SSH_ASKPASS) env.SSH_ASKPASS_REQUIRE = "force";
  }
  return env;
}

/** How to run one read-only Git command outside the adapter: argv prefix, environment, session. */
export interface ReadOnlyGitInvocation {
  /** `["git", ...GIT_BASE_ARGS, ...args]`. A bare `git` is resolved by `run()` on absolute PATH entries. */
  readonly argv: string[];
  /** Full environment for `run()`/`runStreaming()` (`undefined` entries remove a variable). */
  readonly env: Record<string, string | undefined>;
  /** Always `true`: own session, no controlling terminal, a timeout kills the whole group. */
  readonly detached: true;
}

/**
 * The adapter's hardening for read-only Git commands that run outside `GitRunner`: the explorer's
 * ignore detection, the file index (`ls-files`) and `git grep`. Same base flags and environment
 * as the runner's `"read"` commands (no pager, no fsmonitor, no lazy fetch, no prompts, no
 * inherited `GIT_DIR`, never `index.lock`), and the same detached session. `overrides` are merged
 * over `process.env` first (tests pass an isolated `GIT_CONFIG_GLOBAL`).
 */
export function readOnlyGitInvocation(
  args: readonly string[],
  overrides?: Readonly<Record<string, string | undefined>>,
): ReadOnlyGitInvocation {
  return {
    argv: ["git", ...GIT_BASE_ARGS, ...args],
    env: buildGitEnvironment({ ...process.env, ...overrides }, "read"),
    detached: true,
  };
}
