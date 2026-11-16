/**
 * The single place Git is executed. Internal to the adapter: everything else calls `git()` here so
 * the safety flags, environment, timeouts, cancellation and error typing can never be bypassed.
 */
import { isLucyError, LucyError } from "@/core/errors";
import type { Disposable } from "@/core/events";
import { log } from "@/core/log";
import { run, which } from "@/core/process";
import { buildGitEnvironment, GIT_BASE_ARGS, GIT_NETWORK_ARGS, type GitCommandKind } from "./environment";
import { gitFailure, gitPrecondition } from "./errors";

const logger = log.child("git");

export interface GitExecOptions {
  /** Default `"read"`. Decides `GIT_OPTIONAL_LOCKS` and prompt handling. */
  kind?: GitCommandKind;
  stdin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /** Exit codes treated as success by `git()`. Default `[0]`. */
  okExitCodes?: readonly number[];
  /** Extra `-c key=value` entries placed before the subcommand. */
  config?: readonly string[];
}

export interface GitExecResult {
  args: readonly string[];
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout hit `maxOutputBytes` and was cut. */
  truncated: boolean;
}

export interface GitRunnerOptions {
  cwd: string;
  /** Merged over `process.env`; `undefined` removes a variable. */
  env?: Record<string, string | undefined>;
  gitPath?: string;
  defaultTimeoutMs?: number;
}

/**
 * Flags that could discard work on the remote or locally. No code path passes them; this guard
 * makes a future mistake fail loudly instead of force-pushing.
 */
const FORBIDDEN_ARGS = new Set([
  "--force",
  "-f",
  "--force-with-lease",
  "--force-if-includes",
  "--mirror",
  "--delete",
  "--no-verify",
  "--discard-changes",
  "--hard",
]);

/** Commands where `-f` is required for a narrow, explicit purpose (clean of given paths). */
const FORCE_ALLOWED = new Set(["clean"]);

function assertSafeArgs(args: readonly string[]): void {
  const command = args[0] ?? "";
  for (const arg of args) {
    if (arg === "--") break;
    if (FORBIDDEN_ARGS.has(arg) && !(arg === "-f" && FORCE_ALLOWED.has(command))) {
      throw new LucyError("INTERNAL", `Refusing to run git ${command} with ${arg}`);
    }
    if (command === "push" && arg.startsWith("+")) {
      throw new LucyError("INTERNAL", "Refusing to push a forced refspec");
    }
  }
}

export function resolveGitPath(env?: Record<string, string | undefined>): string | null {
  return which("git", env?.PATH === undefined ? undefined : { PATH: env.PATH });
}

export class GitRunner implements Disposable {
  private readonly controller = new AbortController();
  private readonly effectiveEnv: Record<string, string | undefined>;
  private readonly gitPath: string;
  private readonly failingAskpass: string | null;

  constructor(private readonly options: GitRunnerOptions) {
    this.effectiveEnv = { ...process.env, ...options.env };
    const gitPath = options.gitPath ?? resolveGitPath(this.effectiveEnv);
    if (!gitPath) throw gitPrecondition("git-missing", "Git is not installed or not on PATH.");
    this.gitPath = gitPath;
    this.failingAskpass = which("false", { PATH: this.effectiveEnv.PATH }) ?? null;
  }

  get cwd(): string {
    return this.options.cwd;
  }

  get isDisposed(): boolean {
    return this.controller.signal.aborted;
  }

  /**
   * Runs Git and returns the result for any exit code. Throws only for spawn failures,
   * timeouts and cancellation.
   */
  async exec(args: readonly string[], options: GitExecOptions = {}): Promise<GitExecResult> {
    if (this.controller.signal.aborted) {
      throw gitPrecondition("cancelled", "The Git adapter was disposed.");
    }
    assertSafeArgs(args);
    const kind = options.kind ?? "read";
    const argv = [
      this.gitPath,
      ...GIT_BASE_ARGS,
      ...(kind === "network" ? GIT_NETWORK_ARGS : []),
      ...(options.config ?? []).flatMap((entry) => ["-c", entry]),
      ...args,
    ];
    const signal = options.signal
      ? AbortSignal.any([this.controller.signal, options.signal])
      : this.controller.signal;
    const timeoutMs = options.timeoutMs ?? this.options.defaultTimeoutMs ?? 30_000;

    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await run(argv, {
        cwd: this.options.cwd,
        env: buildGitEnvironment(this.effectiveEnv, kind, { failingAskpass: this.failingAskpass }),
        timeoutMs,
        stdin: options.stdin,
        maxOutputBytes: options.maxOutputBytes,
        signal,
        // Own session: hooks, ssh, credential helpers and filter drivers started by Git can
        // never prompt on or draw over the TUI's terminal, and a timeout kills them too.
        detached: true,
      });
    } catch (error) {
      if (isLucyError(error, "SPAWN_FAILED")) {
        throw gitPrecondition("git-missing", "Git could not be started.", { cause: error.message });
      }
      throw error;
    }

    logger.debug("git", {
      args: args.slice(0, 8),
      code: result.code,
      ms: Math.round(result.durationMs),
      truncated: result.truncated || undefined,
    });

    if (result.aborted) {
      throw gitFailure({
        args,
        exitCode: result.code,
        stderr: result.stderr,
        stdout: "",
        kind: "cancelled",
        message: "The Git command was cancelled.",
      });
    }
    if (result.timedOut) {
      throw gitFailure({
        args,
        exitCode: result.code,
        stderr: result.stderr,
        stdout: "",
        kind: "timeout",
        message: `git ${args[0] ?? ""} did not finish within ${Math.round(timeoutMs / 1000)} s.`,
      });
    }
    return {
      args,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      // The kernel kills the child when the cap is hit; a non-zero code is then expected.
      truncated: result.truncated,
    };
  }

  /** Runs Git and throws a typed `GIT_FAILED` error unless the exit code is acceptable. */
  async git(args: readonly string[], options: GitExecOptions = {}): Promise<GitExecResult> {
    const result = await this.exec(args, options);
    const ok = options.okExitCodes ?? [0];
    if (result.truncated || (result.code !== null && ok.includes(result.code))) return result;
    throw gitFailure({ args, exitCode: result.code, stderr: result.stderr, stdout: result.stdout });
  }

  dispose(): void {
    this.controller.abort();
  }
}
