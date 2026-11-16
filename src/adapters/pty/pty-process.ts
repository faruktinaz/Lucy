/**
 * A thin, well-behaved wrapper over Bun's built-in PTY: `Bun.spawn(argv, { terminal })`.
 *
 * Verified facts about Bun 1.3.14 on macOS (spikes/pty/01..05) that shape this module:
 * - The child is a session leader with the PTY as its controlling terminal.
 * - `exited` resolves to 128+n for a signal death; the real signal name is `signalCode`.
 *   `Subprocess.killed` is true even after a normal exit, so it is never used.
 * - The terminal's `exit` callback (PTY EOF) arrives before `exited` when the process tree ends
 *   normally, so all output is already delivered. On Linux a grandchild can keep the slave open
 *   after the leader exits; a short drain timeout covers that case.
 * - The terminal stays open after the child exits and leaks two fds until GC unless `close()`d.
 * - Spawn errors (ENOENT, EACCES, missing cwd) throw synchronously and leak nothing.
 * - `resize()` throws for 0 or for values above 65535; `write()`/`resize()` throw once closed.
 *
 * Output is passed through as raw bytes. Nothing here decodes UTF-8: chunk boundaries split
 * multi-byte characters and escape sequences, and only the emulator may interpret them.
 * Payloads are never logged.
 */
import type { Subprocess, Terminal } from "bun";
import { errorMessage, LucyError } from "@/core/errors";
import { type Disposable, Emitter } from "@/core/events";
import { log } from "@/core/log";
import { resolveCommand } from "@/core/process";
import { OutputCoalescer, type OutputCoalescerOptions } from "./output-coalescer";
import { killProcessTree, killProcessTreesSync } from "./process-tree";
import { buildPtyEnv } from "./pty-env";
import { clampTerminalSize, type TerminalSize } from "./terminal-size";

const logger = log.child("pty");

export interface PtyExitInfo {
  /** Exit code, or `null` when the process was terminated by a signal. */
  code: number | null;
  /** Signal name (for example `"SIGTERM"`), or `null` for a normal exit. */
  signal: string | null;
}

export interface PtySpawnOptions {
  /** Program and arguments. Never a shell string; use `["/bin/zsh", "-l"]` for a shell. */
  argv: readonly string[];
  cwd?: string;
  /**
   * Overrides applied on top of `buildPtyEnv()` (the user's environment with terminal identity
   * fixed up). A value of `undefined` removes the variable.
   */
  env?: Record<string, string | undefined>;
  cols?: number;
  rows?: number;
  /** Per-tick output batching (default on). `false` delivers every PTY read as-is. */
  coalesce?: false | OutputCoalescerOptions;
  /** How long to wait for PTY EOF after the child exited before closing anyway. Default 250 ms. */
  exitDrainMs?: number;
}

export interface PtyKillOptions {
  /** Grace period between SIGHUP, SIGTERM and SIGKILL. */
  graceMs?: number;
}

export interface PtyProcess extends Disposable {
  readonly pid: number;
  readonly argv: readonly string[];
  readonly cols: number;
  readonly rows: number;
  /** False once the child process has exited. */
  readonly isRunning: boolean;
  /** Set once the exit was delivered (after the last output). */
  readonly exitInfo: PtyExitInfo | null;
  /** Resolves after all output has been delivered and the PTY is closed. Never rejects. */
  readonly exited: Promise<PtyExitInfo>;
  /** Sends bytes (or UTF-8 text) to the child. Returns false when the PTY is already closed. */
  write(data: string | Uint8Array): boolean;
  /** Resizes the PTY (clamped to at least 1x1). No-op once closed or when unchanged. */
  resize(cols: number, rows: number): void;
  /** Kills the whole process tree: SIGHUP, then SIGTERM, then SIGKILL. Idempotent. */
  kill(options?: PtyKillOptions): Promise<PtyExitInfo>;
  /** Blocking tree kill for exit and signal handlers. */
  killSync(options?: PtyKillOptions): void;
  /**
   * Closes the PTY master without signalling anything, like closing a terminal window: the
   * kernel sends SIGHUP to the session, and processes that ignore it keep running. After a
   * hangup, `dispose()` no longer starts a tree kill.
   */
  hangup(): void;
  onData(listener: (data: Uint8Array) => void): Disposable;
  /** Fires once, after the last `onData`. Late subscribers should use `exited`. */
  onExit(listener: (info: PtyExitInfo) => void): Disposable;
  /** Kills the tree if still running (in the background), closes the PTY and drops listeners. */
  dispose(): void;
}

function assertArgv(argv: readonly string[]): void {
  if (argv.length === 0 || !argv[0]) {
    throw new LucyError("INVALID_ARGUMENT", "Cannot start a terminal with an empty command");
  }
  for (const arg of argv) {
    if (typeof arg !== "string" || arg.includes("\0")) {
      throw new LucyError("INVALID_ARGUMENT", "Command arguments must be strings without NUL bytes");
    }
  }
}

class BunPtyProcess implements PtyProcess {
  readonly pid: number;
  readonly argv: readonly string[];
  readonly exited: Promise<PtyExitInfo>;
  private size: TerminalSize;
  private readonly child: Subprocess;
  private readonly terminal: Terminal;
  private readonly dataEmitter = new Emitter<Uint8Array>();
  private readonly exitEmitter = new Emitter<PtyExitInfo>();
  private readonly coalescer: OutputCoalescer | null;
  private readonly exitDrainMs: number;
  private resolveExited: (info: PtyExitInfo) => void = () => {};
  private childExited = false;
  private ptyEof = false;
  private finished = false;
  private disposed = false;
  private hungUp = false;
  private info: PtyExitInfo | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private killing: Promise<PtyExitInfo> | null = null;

  constructor(options: PtySpawnOptions) {
    assertArgv(options.argv);
    this.argv = [...options.argv];
    this.size = clampTerminalSize(options.cols, options.rows);
    this.exitDrainMs = Math.max(0, options.exitDrainMs ?? 250);
    this.coalescer =
      options.coalesce === false ? null : new OutputCoalescer((data) => this.deliver(data), options.coalesce);
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });

    // Resolved here rather than by Bun.spawn, which would honor relative PATH entries such as
    // "." and could run a program planted in the opened folder (see `resolveCommand`).
    const env = buildPtyEnv({ overrides: options.env });
    const program = resolveCommand(this.argv[0] as string, env);
    if (program === null) {
      this.coalescer?.dispose();
      throw new LucyError("SPAWN_FAILED", `Could not start "${this.argv[0]}": not found on PATH`, {
        details: { command: this.argv[0], code: "ENOENT" },
      });
    }
    let child: Subprocess;
    try {
      child = Bun.spawn([program, ...this.argv.slice(1)], {
        cwd: options.cwd,
        env,
        terminal: {
          cols: this.size.cols,
          rows: this.size.rows,
          name: "xterm-256color",
          data: (_terminal, bytes) => this.receive(bytes),
          exit: () => this.onPtyEof(),
        },
      });
    } catch (cause) {
      this.coalescer?.dispose();
      const code = (cause as { code?: unknown } | null)?.code;
      throw new LucyError("SPAWN_FAILED", `Could not start "${this.argv[0]}": ${errorMessage(cause)}`, {
        cause,
        details: { command: this.argv[0], code: typeof code === "string" ? code : undefined },
      });
    }
    const terminal = child.terminal;
    if (!terminal) {
      child.kill("SIGKILL");
      throw new LucyError("SPAWN_FAILED", `Could not attach a terminal to "${this.argv[0]}"`);
    }
    this.child = child;
    this.terminal = terminal;
    this.pid = child.pid;
    logger.debug("spawned", {
      pid: this.pid,
      command: this.argv[0],
      cols: this.size.cols,
      rows: this.size.rows,
    });
    child.exited.then(
      () => this.onChildExit(),
      () => this.onChildExit(),
    );
  }

  get cols(): number {
    return this.size.cols;
  }

  get rows(): number {
    return this.size.rows;
  }

  get isRunning(): boolean {
    return !this.childExited;
  }

  get exitInfo(): PtyExitInfo | null {
    return this.finished ? this.info : null;
  }

  write(data: string | Uint8Array): boolean {
    if (this.finished || this.terminal.closed) return false;
    try {
      this.terminal.write(data);
      return true;
    } catch {
      return false;
    }
  }

  resize(cols: number, rows: number): void {
    const next = clampTerminalSize(cols, rows, this.size);
    if (next.cols === this.size.cols && next.rows === this.size.rows) return;
    this.size = next;
    if (this.finished || this.terminal.closed) return;
    try {
      this.terminal.resize(next.cols, next.rows);
    } catch (error) {
      logger.warn("resize failed", { pid: this.pid, error: errorMessage(error) });
    }
  }

  kill(options: PtyKillOptions = {}): Promise<PtyExitInfo> {
    if (this.childExited) {
      // The leader is gone; closing the master hangs up anything still attached to the tty.
      this.finish();
      return this.exited;
    }
    this.killing ??= killProcessTree({
      rootPid: this.pid,
      graceMs: options.graceMs,
      isRootAlive: () => !this.childExited,
    })
      .catch((error: unknown) => {
        logger.warn("tree kill failed, falling back to SIGKILL", {
          pid: this.pid,
          error: errorMessage(error),
        });
      })
      .then(() => {
        if (!this.childExited) this.child.kill("SIGKILL");
        return this.exited;
      });
    return this.killing;
  }

  killSync(options: PtyKillOptions = {}): void {
    if (!this.childExited) killProcessTreesSync([{ rootPid: this.pid }], { graceMs: options.graceMs });
    this.closeTerminal();
  }

  hangup(): void {
    this.hungUp = true;
    this.closeTerminal();
  }

  onData(listener: (data: Uint8Array) => void): Disposable {
    return this.dataEmitter.on(listener);
  }

  onExit(listener: (info: PtyExitInfo) => void): Disposable {
    return this.exitEmitter.on(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dataEmitter.dispose();
    this.exitEmitter.dispose();
    if (this.childExited) this.finish();
    else if (!this.hungUp) void this.kill();
  }

  private closeTerminal(): void {
    try {
      if (!this.terminal.closed) this.terminal.close();
    } catch {
      // Closing twice or after the peer vanished is harmless.
    }
  }

  private receive(bytes: Uint8Array): void {
    if (this.finished) return;
    if (this.coalescer) this.coalescer.push(bytes);
    else this.deliver(bytes);
  }

  private deliver(data: Uint8Array): void {
    this.dataEmitter.emit(data);
  }

  private onPtyEof(): void {
    this.ptyEof = true;
    if (this.childExited) this.finish();
  }

  private onChildExit(): void {
    if (this.childExited) return;
    this.childExited = true;
    const signal = this.child.signalCode;
    this.info = {
      code: signal === null || signal === undefined ? (this.child.exitCode ?? null) : null,
      signal: signal === null || signal === undefined ? null : String(signal),
    };
    if (this.ptyEof) this.finish();
    else this.drainTimer = setTimeout(() => this.finish(), this.exitDrainMs);
  }

  private finish(): void {
    if (this.finished) return;
    if (!this.childExited) return;
    if (this.drainTimer !== null) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    // Output first, exit last: consumers rely on seeing every byte before the exit event.
    this.coalescer?.flush();
    this.coalescer?.dispose();
    this.finished = true;
    this.closeTerminal();
    const info = this.info ?? { code: null, signal: null };
    logger.debug("exited", { pid: this.pid, code: info.code, signal: info.signal });
    this.resolveExited(info);
    this.exitEmitter.emit(info);
    this.exitEmitter.dispose();
  }
}

/**
 * Starts `argv` in a new PTY. Throws `LucyError("SPAWN_FAILED")` when the program cannot be
 * started and `LucyError("INVALID_ARGUMENT")` for an empty or malformed argv.
 */
export function spawnPty(options: PtySpawnOptions): PtyProcess {
  return new BunPtyProcess(options);
}
