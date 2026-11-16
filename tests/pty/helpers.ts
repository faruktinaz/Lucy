import { readdirSync } from "node:fs";
import type { PtyExitInfo, PtyKillOptions, PtyProcess } from "@/adapters/pty";
import type { Disposable } from "@/core/events";

/** Polls `predicate` until it is true or `timeoutMs` elapses. Returns the final result. */
export async function waitFor(predicate: () => boolean, timeoutMs = 5000, intervalMs = 10): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(intervalMs);
  }
  return predicate();
}

/** Accumulates a PTY's raw output; `text()` decodes everything received so far. */
export function collect(pty: Pick<PtyProcess, "onData">): {
  chunks: Uint8Array[];
  bytes(): number;
  text(): string;
} {
  const chunks: Uint8Array[] = [];
  pty.onData((data) => chunks.push(data));
  return {
    chunks,
    bytes: () => chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
    text: () => Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"),
  };
}

/** `ps` rows (pid + full command) whose command line contains `needle`. */
export function psMatching(needle: string): Array<{ pid: number; command: string }> {
  const result = Bun.spawnSync(["ps", "-A", "-o", "pid=,command="], { stdout: "pipe" });
  return result.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const space = line.indexOf(" ");
      return { pid: Number(line.slice(0, space)), command: line.slice(space + 1) };
    })
    .filter((row) => row.command.includes(needle) && !row.command.includes("ps -A"));
}

/** The `sleep <marker>` processes themselves (not shells whose command line mentions the marker). */
export function sleepers(marker: string): Array<{ pid: number; command: string }> {
  return psMatching(marker).filter(
    (row) => row.command === `sleep ${marker}` || row.command.endsWith(`/sleep ${marker}`),
  );
}

/** Kills leftovers by command-line marker, so a failing test never leaks processes. */
export function killMatching(needle: string): void {
  for (const row of psMatching(needle)) {
    try {
      process.kill(row.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** Open file descriptors of this process. */
export function openFdCount(): number {
  return readdirSync("/dev/fd").length;
}

/** A unique `sleep` duration that doubles as a command-line marker visible in `ps`. */
export function sleepMarker(): string {
  return `${3000 + Math.floor(Math.random() * 900)}.${process.pid}${Math.floor(Math.random() * 1000)}`;
}

/** Minimal in-memory PtyProcess for deterministic session tests. */
export class FakePty implements PtyProcess {
  static nextPid = 900_000;
  readonly pid = FakePty.nextPid++;
  readonly argv: readonly string[];
  cols: number;
  rows: number;
  writes: Uint8Array[] = [];
  disposed = false;
  hungUp = false;
  killed = false;
  private running = true;
  private info: PtyExitInfo | null = null;
  private dataListeners = new Set<(data: Uint8Array) => void>();
  private exitListeners = new Set<(info: PtyExitInfo) => void>();
  private resolveExited: (info: PtyExitInfo) => void = () => {};
  readonly exited: Promise<PtyExitInfo>;

  constructor(options: { argv: readonly string[]; cols?: number; rows?: number }) {
    this.argv = options.argv;
    this.cols = options.cols ?? 80;
    this.rows = options.rows ?? 24;
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  get exitInfo(): PtyExitInfo | null {
    return this.info;
  }

  /** Simulates program output. */
  emit(data: string | Uint8Array): void {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    for (const listener of [...this.dataListeners]) listener(bytes);
  }

  /** Simulates the program exiting. */
  exit(info: PtyExitInfo = { code: 0, signal: null }): void {
    if (!this.running) return;
    this.running = false;
    this.info = info;
    for (const listener of [...this.exitListeners]) listener(info);
    this.resolveExited(info);
  }

  writtenText(): string {
    return Buffer.concat(this.writes.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }

  write(data: string | Uint8Array): boolean {
    if (!this.running) return false;
    this.writes.push(typeof data === "string" ? new TextEncoder().encode(data) : data.slice());
    return true;
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
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
    this.hungUp = true;
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
    if (this.running && !this.hungUp) void this.kill();
  }
}
