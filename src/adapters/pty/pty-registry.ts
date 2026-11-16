/**
 * Tracks every live PTY so that quitting Lucy leaves no orphaned processes behind.
 *
 * What happens without any cleanup (verified in spikes/pty/05-parent-death.ts): if Lucy dies
 * abruptly, the kernel closes the PTY masters, the session leaders get SIGHUP and interactive
 * shells forward it to their jobs, so most trees die anyway. Only processes that ignore SIGHUP
 * survive. The registry closes that gap on every orderly exit and on catchable signals.
 *
 * Note for the app: OpenTUI's own signal handler only destroys the renderer and does not exit.
 * Call `registry.disposeAll()` (or `await registry.shutdown()`) when the renderer is destroyed,
 * otherwise live PTYs keep the event loop, and therefore Lucy, alive.
 */
import { constants } from "node:os";
import { type Disposable, toDisposable } from "@/core/events";
import { killProcessTreesSync } from "./process-tree";
import { type PtyKillOptions, type PtyProcess, type PtySpawnOptions, spawnPty } from "./pty-process";

export class PtyRegistry implements Disposable {
  private readonly live = new Set<PtyProcess>();
  private disposingAll = false;

  constructor(private readonly spawner: (options: PtySpawnOptions) => PtyProcess = spawnPty) {}

  /** Number of tracked PTYs whose process has not been reaped yet. */
  get size(): number {
    return this.live.size;
  }

  list(): readonly PtyProcess[] {
    return [...this.live];
  }

  /** Spawns a PTY and tracks it until its process exits. */
  spawn = (options: PtySpawnOptions): PtyProcess => this.track(this.spawner(options));

  /** Tracks an existing PTY until its process exits. */
  track(pty: PtyProcess): PtyProcess {
    if (!pty.isRunning) return pty;
    this.live.add(pty);
    // `exited` always resolves, even when the PTY's listeners were disposed.
    void pty.exited.then(() => this.live.delete(pty));
    return pty;
  }

  /**
   * Kills every tracked process tree, blocking until they are gone or SIGKILL was sent.
   * Synchronous on purpose: safe to call from `process.on("exit")` and signal handlers, where
   * awaiting is impossible. Idempotent and re-entrancy safe.
   */
  disposeAll(options: PtyKillOptions = {}): void {
    if (this.disposingAll) return;
    this.disposingAll = true;
    try {
      const all = [...this.live];
      const running = all.filter((pty) => pty.isRunning);
      if (running.length > 0) {
        killProcessTreesSync(
          running.map((pty) => ({ rootPid: pty.pid })),
          { graceMs: options.graceMs },
        );
      }
      for (const pty of all) {
        pty.hangup();
        pty.dispose();
      }
      this.live.clear();
    } finally {
      this.disposingAll = false;
    }
  }

  /** Non-blocking variant for an orderly quit: kills all trees concurrently. */
  async shutdown(options: PtyKillOptions = {}): Promise<void> {
    const all = [...this.live];
    await Promise.all(all.map((pty) => pty.kill(options)));
    for (const pty of all) pty.dispose();
    this.live.clear();
  }

  dispose(): void {
    this.disposeAll();
  }
}

export interface PtyShutdownHookOptions {
  /** Signals that trigger cleanup. Default SIGINT, SIGTERM, SIGHUP, SIGQUIT. */
  signals?: readonly NodeJS.Signals[];
  /**
   * After cleanup, exit with 128+n when no other listener handles the signal (installing a
   * listener disables Node's default "terminate" action). Default true.
   */
  exitOnSignal?: boolean;
  graceMs?: number;
}

const DEFAULT_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

/**
 * Runs `registry.disposeAll()` on process exit and on the given signals. Returns a Disposable
 * that removes the hooks. Install once during bootstrap.
 */
export function installPtyShutdownHooks(
  registry: PtyRegistry,
  options: PtyShutdownHookOptions = {},
): Disposable {
  const kill = () => registry.disposeAll({ graceMs: options.graceMs });
  process.on("exit", kill);
  const handlers = (options.signals ?? DEFAULT_SIGNALS).map((signal) => {
    const handler = () => {
      kill();
      if ((options.exitOnSignal ?? true) && process.listenerCount(signal) <= 1) {
        process.exit(128 + (constants.signals[signal] ?? 0));
      }
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  return toDisposable(() => {
    process.off("exit", kill);
    for (const { signal, handler } of handlers) process.off(signal, handler);
  });
}
