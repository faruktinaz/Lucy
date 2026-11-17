/**
 * Owns the agent sessions of a workspace: each one is a provider launch running in a
 * `TerminalSession`, plus a coarse activity status for tabs and badges.
 *
 * Activity is a HEURISTIC in this phase, derived only from the terminal byte stream:
 * - exited:    the process ended (or failed to start);
 * - attention: the program rang the bell or sent a desktop notification (OSC 9/99/777) that the
 *              user has not acknowledged by interacting with the terminal;
 * - working:   output arrived recently (or the program reports OSC 9;4 progress), ignoring output
 *              that is just the echo of the user's own typing;
 * - idle:      otherwise.
 * "Waiting for approval" is NOT detected precisely: Claude Code shows a permission dialog and then
 * goes quiet, which looks "idle" unless it also rings the bell or notifies. Precise status needs
 * Claude Code hooks (see docs/dev/PTY_NOTES.md), planned for a later phase.
 */
import { randomUUID } from "node:crypto";
import type { PasteResult, PtySpawner, TerminalSessionOptions, TerminalSessionState } from "@/adapters/pty";
import { TerminalSession } from "@/adapters/pty";
import { LucyError } from "@/core/errors";
import type { Disposable } from "@/core/events";
import { Store } from "@/core/store";
import { sanitizeForDisplay, truncateEnd } from "@/core/text";
import type { AgentLaunch, AgentLaunchMode, AgentLaunchWarning, AgentProvider } from "./agent-provider";

export type AgentActivity = "working" | "idle" | "attention" | "exited";

export interface AgentSession {
  id: string;
  providerId: string;
  mode: AgentLaunchMode;
  title: string;
  cwd: string;
  createdAt: number;
  terminal: TerminalSession;
  activity: AgentActivity;
  /** Launch warnings (for example a permission-bypass flag in the user's extra args). */
  warnings: readonly AgentLaunchWarning[];
}

export interface AgentSessionManagerState {
  sessions: readonly AgentSession[];
}

export interface ActivityOptions {
  /** Output within this window counts as working. Default 1500 ms. */
  workingWindowMs?: number;
  /** Output this soon after input is treated as echo of the user's typing. Default 300 ms. */
  echoWindowMs?: number;
}

export interface AgentSessionManagerOptions extends ActivityOptions {
  providers: readonly AgentProvider[];
  /** How PTYs are spawned; pass `registry.spawn` so they are cleaned up on quit. */
  spawn?: PtySpawner;
  /** Extra options for every terminal (buffer size, coalescing, ...). */
  terminalDefaults?: Partial<Omit<TerminalSessionOptions, "argv" | "cwd" | "env" | "spawn">>;
  /** Interval for re-evaluating time-based activity. Default 500 ms. */
  tickMs?: number;
  now?: () => number;
  /** Test seam. */
  createTerminal?: (options: TerminalSessionOptions) => TerminalSession;
}

export interface CreateAgentSessionInput {
  providerId: string;
  mode: AgentLaunchMode;
  cwd: string;
  title?: string;
  cols?: number;
  rows?: number;
  extraArgs?: readonly string[];
  /**
   * Start the process right away (default). Pass false to start it with `terminal.start()`
   * once a screen is attached, so the program's first terminal queries are answered live.
   */
  autoStart?: boolean;
  /** Restore and persistence: a stable id (the tmux session name), instead of a random one. */
  id?: string;
  /** Use this launch instead of asking the provider (already built, warnings already shown). */
  launch?: AgentLaunch;
  /** How this session's PTY starts (a tmux attach); defaults to the manager's spawner. */
  spawn?: PtySpawner;
  createdAt?: number;
  /** Restored as ended; Restart runs the launch (for example `claude --continue`). */
  ended?: TerminalSessionOptions["ended"];
  /** Runs in Lucy's background tmux server and survives quitting. */
  persistent?: boolean;
}

/** Pure activity derivation from a terminal's state. */
export function deriveAgentActivity(
  state: TerminalSessionState,
  now: number,
  options: ActivityOptions = {},
): AgentActivity {
  const workingWindowMs = options.workingWindowMs ?? 1500;
  const echoWindowMs = options.echoWindowMs ?? 300;
  if (state.status === "exited" || state.status === "failed") return "exited";
  if (state.unseenBell || state.notification) return "attention";
  if (state.status === "starting") return "working";
  if (state.progress && (state.progress.state === "normal" || state.progress.state === "indeterminate")) {
    return "working";
  }
  const output = state.lastOutputAt;
  if (output !== null && now - output <= workingWindowMs) {
    const input = state.lastInputAt;
    if (input === null || output - input > echoWindowMs) return "working";
  }
  return "idle";
}

function cleanTitle(title: string | undefined): string {
  return truncateEnd(sanitizeForDisplay((title ?? "").replace(/\s+/g, " ").trim()), 80);
}

function defaultTitle(provider: AgentProvider, mode: AgentLaunchMode): string {
  switch (mode.kind) {
    case "new":
      return provider.displayName;
    case "continue":
      return `${provider.displayName} (continued)`;
    case "resume-picker":
      return `${provider.displayName} (resume)`;
    case "resume":
      return `${provider.displayName} (${cleanTitle(mode.sessionId).slice(0, 8)})`;
  }
}

export class AgentSessionManager implements Disposable {
  readonly state = new Store<AgentSessionManagerState>({ sessions: [] });
  private readonly providers: Map<string, AgentProvider>;
  private readonly unsubscribers = new Map<string, () => void>();
  private readonly options: AgentSessionManagerOptions;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(options: AgentSessionManagerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.providers = new Map(options.providers.map((provider) => [provider.id, provider]));
  }

  provider(id: string): AgentProvider | undefined {
    return this.providers.get(id);
  }

  /** Every registered provider, in registration order. */
  allProviders(): readonly AgentProvider[] {
    return [...this.providers.values()];
  }

  list(): readonly AgentSession[] {
    return this.state.get().sessions;
  }

  get(id: string): AgentSession | undefined {
    return this.state.get().sessions.find((session) => session.id === id);
  }

  /**
   * Launches an agent in a new terminal. Throws `LucyError` when the provider is unknown or cannot
   * build a launch (for example `NOT_FOUND` when the CLI is missing). A process that fails to start
   * yields a session whose terminal status is "failed".
   */
  create(input: CreateAgentSessionInput): AgentSession {
    if (this.disposed) throw new LucyError("CANCELLED", "The agent session manager was disposed");
    const provider = this.providers.get(input.providerId);
    if (!provider) throw new LucyError("NOT_FOUND", `Unknown agent provider "${input.providerId}"`);
    if (input.id !== undefined && this.get(input.id)) {
      throw new LucyError("ALREADY_EXISTS", "An agent session with this id already exists");
    }
    const launch =
      input.launch ?? provider.buildLaunch(input.mode, { cwd: input.cwd, extraArgs: input.extraArgs });
    const terminalOptions: TerminalSessionOptions = {
      ...this.options.terminalDefaults,
      argv: launch.argv,
      cwd: launch.cwd,
      env: launch.env,
      cols: input.cols,
      rows: input.rows,
      spawn: input.spawn ?? this.options.spawn,
      autoStart: input.autoStart ?? this.options.terminalDefaults?.autoStart,
      ended: input.ended,
      persistent: input.persistent,
    };
    const terminal = this.options.createTerminal?.(terminalOptions) ?? new TerminalSession(terminalOptions);
    const session: AgentSession = {
      id: input.id ?? randomUUID(),
      providerId: provider.id,
      mode: input.mode,
      title: cleanTitle(input.title) || defaultTitle(provider, input.mode),
      cwd: launch.cwd,
      createdAt: input.createdAt ?? this.now(),
      terminal,
      activity: deriveAgentActivity(terminal.state.get(), this.now(), this.options),
      warnings: launch.warnings,
    };
    this.state.set((prev) => ({ sessions: [...prev.sessions, session] }));
    this.unsubscribers.set(
      session.id,
      terminal.state.subscribe(() => this.refresh(session.id)),
    );
    this.ensureTimer();
    return session;
  }

  rename(id: string, title: string): void {
    const clean = cleanTitle(title);
    if (!clean) throw new LucyError("INVALID_ARGUMENT", "A session title cannot be empty");
    this.patch(id, (session) => (session.title === clean ? session : { ...session, title: clean }));
  }

  /** Pastes text into the agent's input. Never submits it: the user presses Enter. */
  pastePrompt(id: string, text: string): PasteResult {
    const session = this.get(id);
    if (!session) throw new LucyError("NOT_FOUND", "Unknown agent session");
    return session.terminal.paste(text);
  }

  /** Stops a session: kills its process tree (default) or only hangs up, then forgets it. */
  close(id: string, options: { kill?: boolean } = {}): void {
    const session = this.get(id);
    if (!session) return;
    this.unsubscribers.get(id)?.();
    this.unsubscribers.delete(id);
    session.terminal.dispose(options);
    this.state.set((prev) => ({ sessions: prev.sessions.filter((entry) => entry.id !== id) }));
    if (this.state.get().sessions.length === 0) this.stopTimer();
  }

  /** Re-derives activity (for one session or all). Called on terminal changes and on a timer. */
  refresh(id?: string): void {
    const now = this.now();
    const sessions = this.state.get().sessions;
    let changed = false;
    const next = sessions.map((session) => {
      if (id !== undefined && session.id !== id) return session;
      const activity = deriveAgentActivity(session.terminal.state.get(), now, this.options);
      if (activity === session.activity) return session;
      changed = true;
      return { ...session, activity };
    });
    if (changed) this.state.set({ sessions: next });
  }

  dispose(): void {
    if (this.disposed) return;
    for (const session of [...this.state.get().sessions]) this.close(session.id);
    this.disposed = true;
    this.stopTimer();
  }

  private patch(id: string, update: (session: AgentSession) => AgentSession): void {
    const sessions = this.state.get().sessions;
    const index = sessions.findIndex((session) => session.id === id);
    const current = sessions[index];
    if (!current) throw new LucyError("NOT_FOUND", "Unknown agent session");
    const next = update(current);
    if (next === current) return;
    this.state.set({ sessions: sessions.map((session, i) => (i === index ? next : session)) });
  }

  private ensureTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.refresh(), this.options.tickMs ?? 500);
    // Activity polling must never keep Lucy alive on its own.
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
