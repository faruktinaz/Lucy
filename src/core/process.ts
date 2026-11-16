/**
 * The standard way to run external programs and capture their output.
 *
 * Commands are always an argv array handed straight to the OS: there is no shell, so file
 * names, branch names or search queries can never be interpreted as shell syntax. Do not
 * add a "run this string" helper; untrusted repository content flows through here.
 *
 * Two places spawn without `run()`, because they need the terminal rather than pipes: PTY
 * sessions (`src/adapters/pty/pty-process.ts`, the child owns a pseudo-terminal) and the
 * foreground external editor (`src/adapters/editor/open-in-external-editor.ts`, the child
 * inherits Lucy's terminal). Both follow the same rules: an argv array, never a shell, and a
 * bare program name resolved with `resolveCommand()` (absolute `PATH` entries only).
 */
import { isAbsolute } from "node:path";
import { LucyError } from "./errors";

export interface RunOptions {
  cwd?: string;
  /** Merged over `process.env`. A value of `undefined` removes the variable. */
  env?: Record<string, string | undefined>;
  /** Kill the process after this many milliseconds. Default 30 000. `0` disables the timeout. */
  timeoutMs?: number;
  stdin?: string | Uint8Array;
  /** Stop reading and kill the process once stdout exceeds this many bytes. Default 32 MiB. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /**
   * Run the command in its own session and process group. It then has no controlling
   * terminal, so it (or anything it starts: hooks, ssh, credential helpers, filters) cannot
   * read from or draw on the TUI's terminal, and a timeout or abort kills the whole group
   * rather than only the direct child. Use it for commands that may start other programs.
   */
  detached?: boolean;
}

export interface RunResult {
  /** Exit code, or `null` when the process was terminated by a signal. */
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** stdout hit `maxOutputBytes` and was cut. */
  truncated: boolean;
  aborted: boolean;
  durationMs: number;
}

export interface StreamOptions extends Omit<RunOptions, "maxOutputBytes"> {
  /**
   * Called for every complete stdout line (without the trailing newline). `truncated` is true
   * when the line was longer than `maxLineBytes`: `line` then holds only its beginning (cut at
   * a character boundary) and the rest up to the newline was discarded unread.
   */
  onLine: (line: string, truncated: boolean) => void;
  /**
   * Longest line kept, in UTF-8 bytes. Default 1 MiB. Bounds memory: a file with one enormous
   * line (a minified bundle) can no longer grow the pending buffer without limit.
   */
  maxLineBytes?: number;
}

export interface StreamHandle {
  /** Resolves when the process exited. Never rejects for a non-zero exit code. */
  done: Promise<Omit<RunResult, "stdout" | "truncated">>;
  /** Terminates the process (SIGTERM, then SIGKILL after a short grace period). */
  kill(): void;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT = 32 * 1024 * 1024;
/** Default `StreamOptions.maxLineBytes`. */
export const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const MAX_STDERR = 1024 * 1024;
const KILL_GRACE_MS = 500;
/**
 * After a timeout or abort, stop waiting for stdout/stderr this long after the kill started. A
 * grandchild (e.g. `sleep` under a shell-script wrapper) can inherit the pipes and keep them open
 * long after the process we killed is gone; without this, `timeoutMs` would not bound `run()`.
 */
const STREAM_CANCEL_AFTER_KILL_MS = KILL_GRACE_MS + 250;

/** Search path used when `PATH` is not set at all (the POSIX `confstr(_CS_PATH)` minimum). */
const FALLBACK_PATH = "/usr/bin:/bin";

/**
 * The absolute entries of a `PATH` value, in order. Relative entries (`.`, `bin`,
 * `node_modules/.bin`, a literal `~/bin`) and empty ones (which POSIX also reads as the current
 * directory) are dropped: Lucy runs with the opened folder as its working directory, so a
 * relative entry would let an untrusted repository supply its own `git` or `rg`.
 */
export function absolutePathEntries(path: string | undefined): string[] {
  return (path ?? FALLBACK_PATH).split(":").filter((entry) => entry !== "" && isAbsolute(entry));
}

/**
 * Absolute path of an executable found on `PATH`, or `null`. Only absolute `PATH` entries are
 * searched (see `absolutePathEntries`), so the result never depends on the working directory.
 * `PATH` comes from `env` when it has one, else from `process.env`.
 *
 * A name containing a slash is not a `PATH` lookup: it is resolved as a path (relative to the
 * process working directory), as before. Callers that read program names from untrusted input
 * must not pass relative paths.
 */
export function which(bin: string, env?: Record<string, string | undefined>): string | null {
  if (bin === "" || bin.includes("\0")) return null;
  if (bin.includes("/")) return Bun.which(bin);
  const entries = absolutePathEntries(env?.PATH ?? process.env.PATH);
  if (entries.length === 0) return null;
  return Bun.which(bin, { PATH: entries.join(":") });
}

/**
 * The program to execute for `argv0`: a value containing a slash is used as given; a bare name
 * is looked up on the absolute entries of `env.PATH`, where `env` is the child's complete
 * environment (default `process.env`; no `PATH` there means the POSIX default). `null` when not
 * found. Every spawn site resolves through this, because `Bun.spawn` itself would honor relative
 * `PATH` entries such as `.` against the process working directory (verified on Bun 1.3.14).
 */
export function resolveCommand(argv0: string, env?: Record<string, string | undefined>): string | null {
  if (argv0.includes("/")) return argv0;
  if (argv0 === "" || argv0.includes("\0")) return null;
  const entries = absolutePathEntries((env ?? process.env).PATH);
  return entries.length === 0 ? null : Bun.which(argv0, { PATH: entries.join(":") });
}

function assertArgv(argv: readonly string[]): void {
  if (argv.length === 0 || !argv[0]) {
    throw new LucyError("INVALID_ARGUMENT", "Cannot run an empty command");
  }
  for (const arg of argv) {
    if (typeof arg !== "string" || arg.includes("\0")) {
      throw new LucyError("INVALID_ARGUMENT", "Command arguments must be strings without NUL bytes");
    }
  }
}

function mergeEnv(extra?: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
  return env;
}

type Child = ReturnType<typeof Bun.spawn>;

/** Children started with `detached`: they lead their own process group, which we kill as a unit. */
const groupLeaders = new WeakSet<Child>();

function spawnChild(argv: readonly string[], options: RunOptions): Child {
  assertArgv(argv);
  const env = mergeEnv(options.env);
  const program = resolveCommand(argv[0] as string, env);
  if (program === null) {
    throw new LucyError("SPAWN_FAILED", `Could not start "${argv[0]}": not found on PATH`, {
      details: { command: argv[0], code: "ENOENT" },
    });
  }
  try {
    const child = Bun.spawn([program, ...argv.slice(1)], {
      cwd: options.cwd,
      env,
      stdin:
        options.stdin === undefined
          ? "ignore"
          : typeof options.stdin === "string"
            ? new TextEncoder().encode(options.stdin)
            : options.stdin,
      stdout: "pipe",
      stderr: "pipe",
      detached: options.detached === true,
    });
    if (options.detached === true) groupLeaders.add(child);
    return child;
  } catch (cause) {
    throw new LucyError("SPAWN_FAILED", `Could not start "${argv[0]}"`, {
      cause,
      details: { command: argv[0] },
    });
  }
}

function signalName(child: Child): string | null {
  return child.signalCode === null || child.signalCode === undefined ? null : String(child.signalCode);
}

function sendSignal(child: Child, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    // A negative pid addresses the process group, so grandchildren die with their leader.
    if (groupLeaders.has(child)) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // Already gone.
  }
}

function terminate(child: Child): void {
  sendSignal(child, "SIGTERM");
  const timer = setTimeout(() => sendSignal(child, "SIGKILL"), KILL_GRACE_MS);
  timer.unref?.();
  // A group can outlive its leader, so for a detached child the escalation must still run
  // after the leader exited; otherwise a grandchild that ignores SIGTERM would be orphaned.
  if (!groupLeaders.has(child)) void child.exited.finally(() => clearTimeout(timer));
}

/** Reads a stream up to `limit` bytes; calls `onLimit` once if there was more. Ends early on `stop`. */
async function collect(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onLimit?: () => void,
  stop?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  if (stop?.aborted) cancel();
  else stop?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (truncated) continue; // Keep draining so the child is never blocked on a full pipe.
      if (total + value.byteLength > limit) {
        chunks.push(value.subarray(0, Math.max(0, limit - total)));
        total = limit;
        truncated = true;
        onLimit?.();
        continue;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    stop?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

interface Watchdog {
  timedOut: boolean;
  aborted: boolean;
  /** Aborted shortly after a timeout/abort kill, so stream readers stop waiting for EOF. */
  streams: AbortSignal;
  /** Terminates the child and arms the stream cancellation. */
  kill(): void;
  stop(): void;
}

function watch(child: Child, options: RunOptions): Watchdog {
  const streams = new AbortController();
  const state: Watchdog = {
    timedOut: false,
    aborted: false,
    streams: streams.signal,
    kill: () => {},
    stop: () => {},
  };
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = () => {
    terminate(child);
    cancelTimer ??= setTimeout(() => streams.abort(), STREAM_CANCEL_AFTER_KILL_MS);
    cancelTimer.unref?.();
  };
  state.kill = kill;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          state.timedOut = true;
          kill();
        }, timeoutMs)
      : undefined;
  const onAbort = () => {
    state.aborted = true;
    kill();
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  state.stop = () => {
    if (timer) clearTimeout(timer);
    if (cancelTimer) clearTimeout(cancelTimer);
    options.signal?.removeEventListener("abort", onAbort);
  };
  return state;
}

const NEWLINE = 0x0a;

/**
 * Length of the longest prefix of `bytes` that ends on a UTF-8 character boundary, so a line cut
 * at an arbitrary byte does not end in half a character (which would decode to U+FFFD).
 */
function completeUtf8Length(bytes: Uint8Array): number {
  const n = bytes.length;
  for (let i = n - 1; i >= Math.max(0, n - 4); i--) {
    const byte = bytes[i] as number;
    if ((byte & 0xc0) === 0x80) continue; // Continuation byte: look further back for the lead.
    const size = byte < 0x80 ? 1 : (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : 4;
    return i + size <= n ? n : i;
  }
  return n;
}

/**
 * Splits a byte stream into lines without ever holding more than `maxBytes` of one line.
 *
 * Works on bytes, not decoded text: a newline byte never occurs inside a UTF-8 sequence, so each
 * line can be decoded on its own, and the limit is a real memory bound. A line longer than the
 * limit keeps its first `maxBytes` (cut back to a character boundary), the rest up to the next
 * newline is dropped as it arrives, and the line is delivered with `truncated = true`. A trailing
 * "\r" (CRLF) is removed; a final line without a newline is delivered unless it is empty.
 */
class LineSplitter {
  private readonly decoder = new TextDecoder("utf-8");
  private parts: Uint8Array[] = [];
  private length = 0;
  private overflow = false;

  constructor(
    private readonly maxBytes: number,
    private readonly emit: (line: string, truncated: boolean) => void,
  ) {}

  push(chunk: Uint8Array): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(NEWLINE, start);
      const end = newline === -1 ? chunk.length : newline;
      if (newline !== -1 && this.length === 0 && !this.overflow && end - start <= this.maxBytes) {
        // Fast path: the whole line is inside this chunk; decode it without copying.
        this.deliver(chunk.subarray(start, end), false);
      } else {
        this.append(chunk.subarray(start, end));
        if (newline === -1) return;
        this.endLine(false);
      }
      start = end + 1;
    }
  }

  /** Delivers a final line that had no newline. */
  finish(): void {
    if (this.length > 0 || this.overflow) this.endLine(true);
  }

  private append(bytes: Uint8Array): void {
    if (this.overflow || bytes.length === 0) return;
    const room = this.maxBytes - this.length;
    if (bytes.length > room) {
      this.overflow = true;
      bytes = bytes.subarray(0, room);
    }
    if (bytes.length === 0) return;
    // Copy: the stream may reuse its buffer for the next chunk.
    this.parts.push(bytes.slice());
    this.length += bytes.length;
  }

  private endLine(final: boolean): void {
    const whole = this.parts.length === 1 ? (this.parts[0] as Uint8Array) : Buffer.concat(this.parts);
    const truncated = this.overflow;
    this.parts = [];
    this.length = 0;
    this.overflow = false;
    this.deliver(truncated ? whole.subarray(0, completeUtf8Length(whole)) : whole, truncated, final);
  }

  private deliver(bytes: Uint8Array, truncated: boolean, final = false): void {
    let line = this.decoder.decode(bytes);
    if (!truncated && line.endsWith("\r")) line = line.slice(0, -1);
    // An unterminated final line that is empty (or was only "\r") is not a line.
    if (final && !truncated && line.length === 0) return;
    this.emit(line, truncated);
  }
}

/**
 * Runs a command to completion and returns its captured output.
 * A non-zero exit code is a normal result, not an exception; only failing to start throws.
 */
export async function run(argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const started = performance.now();
  const child = spawnChild(argv, options);
  const watchdog = watch(child, options);
  try {
    const [out, err] = await Promise.all([
      collect(
        child.stdout as ReadableStream<Uint8Array>,
        options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT,
        () => terminate(child),
        watchdog.streams,
      ),
      collect(child.stderr as ReadableStream<Uint8Array>, MAX_STDERR, undefined, watchdog.streams),
    ]);
    const code = await child.exited;
    return {
      code: child.signalCode ? null : code,
      signal: signalName(child),
      stdout: out.text,
      stderr: err.text,
      timedOut: watchdog.timedOut,
      truncated: out.truncated,
      aborted: watchdog.aborted,
      durationMs: performance.now() - started,
    };
  } finally {
    watchdog.stop();
  }
}

/**
 * Runs a command and delivers stdout line by line as it arrives. Use for long or
 * unbounded output (search results, logs) where the caller caps or cancels the work.
 */
export function runStreaming(argv: readonly string[], options: StreamOptions): StreamHandle {
  const started = performance.now();
  const child = spawnChild(argv, options);
  const watchdog = watch(child, options);

  const pump = async (): Promise<void> => {
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const cancel = () => void reader.cancel().catch(() => {});
    watchdog.streams.addEventListener("abort", cancel, { once: true });
    const splitter = new LineSplitter(options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES, options.onLine);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        splitter.push(value);
      }
      splitter.finish();
    } finally {
      watchdog.streams.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  };

  const done = (async () => {
    try {
      const [, err] = await Promise.all([
        pump(),
        collect(child.stderr as ReadableStream<Uint8Array>, MAX_STDERR, undefined, watchdog.streams),
      ]);
      const code = await child.exited;
      return {
        code: child.signalCode ? null : code,
        signal: signalName(child),
        stderr: err.text,
        timedOut: watchdog.timedOut,
        aborted: watchdog.aborted,
        durationMs: performance.now() - started,
      };
    } finally {
      watchdog.stop();
    }
  })();

  return {
    done,
    kill: () => {
      watchdog.aborted = true;
      watchdog.kill();
    },
  };
}
