/**
 * Claude Code provider.
 *
 * Launch modes map to the flags verified against `claude --help` (Claude Code 2.1.325):
 *   new            -> claude
 *   continue       -> claude --continue        ("Continue the most recent conversation in the current directory")
 *   resume-picker  -> claude --resume          (interactive picker)
 *   resume <id>    -> claude --resume <id>     ("Resume a conversation by session ID or name")
 * followed by the user's configured extra arguments.
 *
 * Hard rules: the provider never adds `--dangerously-skip-permissions` or any other permission
 * bypass, and never passes a prompt. The user's own extra arguments are passed through unchanged,
 * but anything risky comes back as a warning for the UI.
 *
 * The executable is whatever the config override or PATH resolves to, kept as is: when PATH puts
 * a wrapper first (for example cmux's `claude` shim, which adds its own hooks), Lucy launches the
 * wrapper and never resolves through it.
 */
import { accessSync, constants } from "node:fs";
import { isAbsolute } from "node:path";
import { errorMessage, LucyError } from "@/core/errors";
import { run, which } from "@/core/process";
import { sanitizeForDisplay, truncateEnd } from "@/core/text";
import type {
  AgentDetection,
  AgentLaunch,
  AgentLaunchMode,
  AgentLaunchOptions,
  AgentProvider,
  AgentSessionListing,
} from "./agent-provider";
import { inspectClaudeArgs } from "./claude-args";
import { defaultClaudeProjectsDir, listClaudeSessions } from "./claude-sessions";

export const CLAUDE_PROVIDER_ID = "claude";

/** A value, or a getter read on every use (so settings changes apply without a restart). */
export type Live<T> = T | (() => T);

function read<T>(value: Live<T>): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

export interface ClaudeProviderConfig {
  /** Executable override: an absolute path, or a command name looked up on PATH. */
  executable?: Live<string | undefined>;
  /** User-configured extra arguments, appended to every launch. */
  extraArgs?: Live<readonly string[] | undefined>;
  /**
   * Environment overrides used to resolve the executable and run `--version` (merged over the
   * process environment). Tests use it to point PATH at a fake `claude`.
   */
  env?: Record<string, string | undefined>;
  /** Session discovery directory. Default `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`. */
  projectsDir?: string;
  /** Timeout for `claude --version`. Default 5000 ms. */
  versionTimeoutMs?: number;
}

const NOT_FOUND_HINT = "Install Claude Code, or set ai.executable to its full path.";

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return truncateEnd(sanitizeForDisplay(line.trim()), 160);
}

function assertArgs(args: readonly string[]): void {
  for (const arg of args) {
    if (typeof arg !== "string" || arg.includes("\0")) {
      throw new LucyError("INVALID_ARGUMENT", "Extra arguments must be strings without NUL bytes");
    }
  }
}

function modeArgs(mode: AgentLaunchMode): string[] {
  switch (mode.kind) {
    case "new":
      return [];
    case "continue":
      return ["--continue"];
    case "resume-picker":
      return ["--resume"];
    case "resume": {
      const id = mode.sessionId.trim();
      // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
      if (!id || id.startsWith("-") || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) {
        throw new LucyError("INVALID_ARGUMENT", "Invalid Claude Code session id", {
          details: { length: id.length },
        });
      }
      return ["--resume", id];
    }
  }
}

export function createClaudeProvider(config: ClaudeProviderConfig = {}): AgentProvider {
  const env = { ...process.env, ...config.env };
  const versionTimeoutMs = config.versionTimeoutMs ?? 5000;

  const configuredExecutable = (): string | undefined => read(config.executable)?.trim() || undefined;
  const resolveExecutable = (): string | null => {
    const override = configuredExecutable();
    if (override) {
      if (isAbsolute(override)) return isExecutableFile(override) ? override : null;
      if (override.includes("/")) return null; // Relative paths are ambiguous: require absolute.
      return which(override, env);
    }
    return which("claude", env);
  };

  const notFoundMessage = () =>
    configuredExecutable()
      ? `The configured executable "${configuredExecutable()}" was not found or is not executable. ai.executable must be an absolute path or a command on PATH.`
      : `The claude command was not found on PATH. ${NOT_FOUND_HINT}`;

  return {
    id: CLAUDE_PROVIDER_ID,
    displayName: "Claude Code",
    capabilities: { continue: true, resumePicker: true, resumeById: true, sessionDiscovery: true },

    async detect(): Promise<AgentDetection> {
      const executable = resolveExecutable();
      if (!executable)
        return { available: false, executable: null, version: null, problem: notFoundMessage() };
      let result: Awaited<ReturnType<typeof run>>;
      try {
        result = await run([executable, "--version"], { timeoutMs: versionTimeoutMs, env: config.env });
      } catch (error) {
        return {
          available: false,
          executable,
          version: null,
          problem: `Could not start Claude Code: ${errorMessage(error)}`,
        };
      }
      if (result.timedOut) {
        return {
          available: true,
          executable,
          version: null,
          problem: `\`claude --version\` did not answer within ${Math.round(versionTimeoutMs / 1000)} s; Claude Code may still start.`,
        };
      }
      if (result.code !== 0) {
        const detail = firstLine(result.stderr) || firstLine(result.stdout);
        return {
          available: false,
          executable,
          version: null,
          problem: `\`claude --version\` failed${result.signal ? ` (${result.signal})` : ` with exit code ${result.code}`}${detail ? `: ${detail}` : ""}`,
        };
      }
      const version = /\d+\.\d+\.\d+[0-9A-Za-z.+-]*/.exec(result.stdout)?.[0] ?? null;
      return {
        available: true,
        executable,
        version,
        problem: version ? null : "Claude Code started but its version could not be read.",
      };
    },

    buildLaunch(mode: AgentLaunchMode, options: AgentLaunchOptions): AgentLaunch {
      const executable = resolveExecutable();
      if (!executable) throw new LucyError("NOT_FOUND", notFoundMessage());
      const extra = [...(read(config.extraArgs) ?? []), ...(options.extraArgs ?? [])];
      assertArgs(extra);
      return {
        argv: [executable, ...modeArgs(mode), ...extra],
        cwd: options.cwd,
        warnings: inspectClaudeArgs(extra),
      };
    },

    listSessions(cwd: string, options: { limit?: number } = {}): Promise<AgentSessionListing> {
      return listClaudeSessions(cwd, {
        limit: options.limit,
        projectsDir: config.projectsDir ?? defaultClaudeProjectsDir(env),
      });
    },
  };
}
