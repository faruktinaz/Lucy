/**
 * Provider abstraction for interactive CLI coding agents (Claude Code first; others later).
 *
 * A provider only describes how to find and launch its CLI. The agent always runs in a PTY as the
 * user's own interactive program: Lucy never answers its prompts, never submits input for the user
 * and never weakens its permission model.
 */

export type AgentLaunchMode =
  | { kind: "new" }
  /** Continue the most recent conversation in the working directory. */
  | { kind: "continue" }
  /** Let the agent show its own session picker. */
  | { kind: "resume-picker" }
  | { kind: "resume"; sessionId: string };

export interface AgentDetection {
  /** The CLI can be launched. */
  available: boolean;
  /** Path as resolved from the config override or PATH (shims are kept, never resolved through). */
  executable: string | null;
  version: string | null;
  /** Human-readable explanation when something is wrong or degraded; `null` when all is well. */
  problem: string | null;
}

export type AgentLaunchWarningCode =
  /** A user-supplied argument disables or weakens the agent's permission prompts. */
  | "PERMISSION_BYPASS"
  /** A user-supplied argument would be sent as a prompt (or run a subcommand) on launch. */
  | "PROMPT_ARGUMENT"
  /** A user-supplied argument makes the agent non-interactive. */
  | "NON_INTERACTIVE"
  /** A user-supplied argument changes the launch mode Lucy selected. */
  | "MODE_OVERRIDE";

export interface AgentLaunchWarning {
  code: AgentLaunchWarningCode;
  message: string;
  /** The offending argument. */
  arg: string;
}

export interface AgentLaunchOptions {
  cwd: string;
  /** Extra arguments for this launch only, appended after the configured ones. */
  extraArgs?: readonly string[];
}

export interface AgentLaunch {
  argv: string[];
  /** Environment overrides for the PTY (merged over the inherited environment). */
  env?: Record<string, string | undefined>;
  cwd: string;
  /** Things the UI should show the user before or while launching. Never silently dropped. */
  warnings: AgentLaunchWarning[];
}

export interface AgentCapabilities {
  continue: boolean;
  resumePicker: boolean;
  resumeById: boolean;
  /** `listSessions` is implemented. */
  sessionDiscovery: boolean;
}

export interface AgentSessionSummary {
  id: string;
  /** One sanitized, truncated line. */
  title: string;
  /** Epoch milliseconds of the last activity. */
  updatedAt: number;
  messageCount?: number;
}

export interface AgentSessionListing {
  sessions: AgentSessionSummary[];
  /** Why the list may be empty or incomplete; `null` when nothing went wrong. */
  problem: string | null;
}

export interface AgentProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: AgentCapabilities;
  detect(): Promise<AgentDetection>;
  /**
   * Builds the command line for a launch mode. Pure apart from resolving the executable.
   * Throws `LucyError("NOT_FOUND")` when the CLI cannot be found and `INVALID_ARGUMENT` for a
   * malformed session id.
   */
  buildLaunch(mode: AgentLaunchMode, options: AgentLaunchOptions): AgentLaunch;
  listSessions?(cwd: string, options?: { limit?: number }): Promise<AgentSessionListing>;
}
