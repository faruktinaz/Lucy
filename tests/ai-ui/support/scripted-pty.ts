/**
 * Deterministic stand-ins for real processes, for UI tests and screenshot scenarios: a PTY
 * that plays a canned transcript and records what it receives, and agent providers that never
 * run a real CLI. Nothing here imitates Claude Code's interface: the agent transcript is a
 * neutral "demo agent".
 */
import type {
  AgentDetection,
  AgentLaunchMode,
  AgentLaunchWarning,
  AgentProvider,
  AgentSessionListing,
} from "@/adapters/agents";
import { inspectClaudeArgs } from "@/adapters/agents";
import type { PtyExitInfo, PtyKillOptions, PtyProcess, PtySpawnOptions } from "@/adapters/pty";
import type { Disposable } from "@/core/events";

export interface PtyScript {
  /** Output chunks played right after the process starts. */
  readonly start?: readonly string[];
  /** Reacts to input (already decoded); call `pty.emit` to answer. */
  readonly onInput?: (input: string, pty: ScriptedPty) => void;
}

const encoder = new TextEncoder();

export class ScriptedPty implements PtyProcess {
  private static nextPid = 700_000;
  readonly pid = ScriptedPty.nextPid++;
  readonly argv: readonly string[];
  readonly exited: Promise<PtyExitInfo>;
  cols: number;
  rows: number;
  /** Everything written to the PTY: keys, pastes and the emulator's query answers. */
  readonly writes: Uint8Array[] = [];
  killed = false;
  disposed = false;
  private running = true;
  private info: PtyExitInfo | null = null;
  private readonly dataListeners = new Set<(data: Uint8Array) => void>();
  private readonly exitListeners = new Set<(info: PtyExitInfo) => void>();
  private resolveExited: (info: PtyExitInfo) => void = () => {};

  constructor(
    options: PtySpawnOptions,
    private readonly script: PtyScript,
  ) {
    this.argv = [...options.argv];
    this.cols = options.cols ?? 80;
    this.rows = options.rows ?? 24;
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    // Listeners attach right after spawn returns; play the transcript on the next microtask.
    queueMicrotask(() => {
      for (const chunk of script.start ?? []) this.emit(chunk);
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  get exitInfo(): PtyExitInfo | null {
    return this.info;
  }

  /** Everything written so far, decoded. */
  writtenText(): string {
    return Buffer.concat(this.writes.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }

  emit(data: string): void {
    if (!this.running) return;
    const bytes = encoder.encode(data);
    for (const listener of [...this.dataListeners]) listener(bytes);
  }

  exit(info: PtyExitInfo = { code: 0, signal: null }): void {
    if (!this.running) return;
    this.running = false;
    this.info = info;
    for (const listener of [...this.exitListeners]) listener(info);
    this.resolveExited(info);
  }

  write(data: string | Uint8Array): boolean {
    if (!this.running) return false;
    const bytes = typeof data === "string" ? encoder.encode(data) : data.slice();
    this.writes.push(bytes);
    this.script.onInput?.(Buffer.from(bytes).toString("utf8"), this);
    return true;
  }

  resize(cols: number, rows: number): void {
    this.cols = Math.max(1, Math.floor(cols));
    this.rows = Math.max(1, Math.floor(rows));
  }

  kill(_options?: PtyKillOptions): Promise<PtyExitInfo> {
    this.killed = true;
    this.exit({ code: null, signal: "SIGHUP" });
    return this.exited;
  }

  killSync(): void {
    void this.kill();
  }

  hangup(): void {
    this.exit({ code: null, signal: "SIGHUP" });
  }

  onData(listener: (data: Uint8Array) => void): Disposable {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (info: PtyExitInfo) => void): Disposable {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  dispose(): void {
    this.disposed = true;
    if (this.running) void this.kill();
  }
}

/** A spawner that plays `scriptFor(options)` and keeps every PTY it made, newest last. */
export function scriptedSpawn(scriptFor: (options: PtySpawnOptions) => PtyScript = () => ({})) {
  const ptys: ScriptedPty[] = [];
  const spawn = (options: PtySpawnOptions): PtyProcess => {
    const pty = new ScriptedPty(options, scriptFor(options));
    ptys.push(pty);
    return pty;
  };
  return { spawn, ptys, last: () => ptys.at(-1) };
}

// ------------------------------------------------------------------ transcripts

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** A neutral agent conversation (not Claude Code's interface). Enables bracketed paste. */
export const DEMO_AGENT_TRANSCRIPT: readonly string[] = [
  "\x1b[?2004h\x1b]0;demo agent\x07",
  `${BOLD}demo agent${RESET} ${DIM}0.4 · a stand-in for screenshots${RESET}\r\n`,
  `${DIM}folder: orbit${RESET}\r\n\r\n`,
  `${BOLD}you${RESET}  Why does the rate limiter let\r\n     bursts through?\r\n\r\n`,
  `${CYAN}read${RESET} src/server/middleware/rate-limit.ts\r\n`,
  `${CYAN}read${RESET} src/server/config.ts\r\n\r\n`,
  "The bucket refills before it is\r\nchecked, so a burst after an idle\r\nminute gets a full bucket twice.\r\n\r\n",
  `Proposed fix: check, then refill.\r\n${GREEN}+2${RESET} ${DIM}-1${RESET} in rate-limit.ts\r\n\r\n`,
  `${DIM}Apply the change? (y/n)${RESET} `,
];

/** A short shell session with a prompt; typing a line and Enter prints canned output. */
export function shellScript(name = "zsh"): PtyScript {
  const prompt = `${GREEN}orbit${RESET} ${DIM}%${RESET} `;
  let line = "";
  return {
    start: [
      `${DIM}Last login: Tue Nov 17 09:12 on ttys004${RESET}\r\n`,
      `${prompt}git status --short\r\n`,
      ` ${YELLOW}M${RESET} src/server/middleware/rate-limit.ts\r\n ${YELLOW}M${RESET} src/ui/components/TaskList.tsx\r\n${GREEN}??${RESET} notes/çalışma-notları.md\r\n`,
      `${prompt}bun test src/server\r\n`,
      `${DIM}bun test v1.3.14${RESET}\r\n\r\n${GREEN}✓${RESET} rate limit refills after the window ${DIM}[2.1ms]${RESET}\r\n${GREEN}✓${RESET} notes are sorted by date ${DIM}[0.4ms]${RESET}\r\n\r\n ${GREEN}12 pass${RESET}\r\n 0 fail\r\n`,
      prompt,
    ],
    onInput: (input, pty) => {
      for (const char of input) {
        if (char === "\r") {
          pty.emit(`\r\n${line ? `${name}: ran ${line}\r\n` : ""}${prompt}`);
          line = "";
        } else if (char >= " ") {
          line += char;
          pty.emit(char);
        }
      }
    },
  };
}

// ------------------------------------------------------------------ providers

export interface FakeProviderOptions {
  available?: boolean;
  executable?: string;
  version?: string;
  problem?: string | null;
  /** Configured extra arguments; warnings come from the real `inspectClaudeArgs`. */
  extraArgs?: readonly string[];
  history?: AgentSessionListing;
}

/** An agent provider that never runs a process: `buildLaunch` returns `["demo-agent", ...]`. */
export function fakeProvider(
  options: FakeProviderOptions = {},
): AgentProvider & { launches: AgentLaunchMode[] } {
  const launches: AgentLaunchMode[] = [];
  const available = options.available ?? true;
  const warnings = (): AgentLaunchWarning[] => inspectClaudeArgs(options.extraArgs ?? []);
  return {
    id: "claude",
    displayName: "Claude Code",
    capabilities: { continue: true, resumePicker: true, resumeById: true, sessionDiscovery: true },
    launches,
    detect: async (): Promise<AgentDetection> =>
      available
        ? {
            available: true,
            executable: options.executable ?? "/usr/local/bin/claude",
            version: options.version ?? "2.1.325",
            problem: options.problem ?? null,
          }
        : {
            available: false,
            executable: null,
            version: null,
            problem:
              options.problem ??
              "The claude command was not found on PATH. Install Claude Code, or set ai.executable to its full path.",
          },
    buildLaunch: (mode, launch) => {
      launches.push(mode);
      const modeArgs =
        mode.kind === "continue"
          ? ["--continue"]
          : mode.kind === "resume-picker"
            ? ["--resume"]
            : mode.kind === "resume"
              ? ["--resume", mode.sessionId]
              : [];
      return {
        argv: ["demo-agent", ...modeArgs, ...(options.extraArgs ?? [])],
        cwd: launch.cwd,
        warnings: warnings(),
      };
    },
    listSessions: async () =>
      options.history ?? { sessions: [], problem: "No Claude Code sessions recorded for this folder yet." },
  };
}
