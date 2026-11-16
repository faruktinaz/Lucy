/**
 * One terminal: a `PtyProcess` plus everything the UI needs around it, without depending on the
 * UI. A "screen" (normally an `EmbeddedTerminalRenderable`, see `connectEmbeddedTerminal`) attaches
 * to receive output and detaches when it goes away.
 *
 * Attach/detach design (see docs/dev/PTY_NOTES.md for the measurements):
 * - Preferred: keep ONE renderable per session alive for the session's whole life and hide it
 *   (`visible = false`) instead of unmounting it. A hidden renderable keeps parsing output and,
 *   crucially, keeps answering terminal queries (DA1, DSR, OSC 11, kitty `CSI ? u`) in real time.
 *   Programs such as Claude Code send those queries and expect timely answers; replay cannot do
 *   that. The emulator also holds the exact screen, scrollback and modes.
 * - Fallback: output is also kept in a bounded ring buffer (2 MiB by default) and replayed into a
 *   screen when it attaches, for screens created late (session started before the panel) or
 *   recreated after being destroyed. When the buffer has dropped its beginning, the modes that were
 *   active at the cut are re-established first, and replay starts at a sequence boundary. Query
 *   responses produced while replaying are discarded: they answer questions asked long ago.
 */
import { errorMessage, isLucyError, type LucyErrorCode } from "@/core/errors";
import { type Disposable, DisposableStore, Emitter, toDisposable } from "@/core/events";
import { log } from "@/core/log";
import { Store } from "@/core/store";
import { ByteRingBuffer } from "./byte-ring-buffer";
import { type PtyExitInfo, type PtyProcess, type PtySpawnOptions, spawnPty } from "./pty-process";
import { clampTerminalSize } from "./terminal-size";
import {
  type TerminalModes,
  type TerminalProgress,
  type TerminalStreamEvent,
  TerminalStreamSniffer,
} from "./terminal-stream-sniffer";

const logger = log.child("terminal");

export type TerminalStatus = "starting" | "running" | "exited" | "failed";

export interface TerminalNotification {
  title: string | null;
  body: string;
  at: number;
}

export interface TerminalSessionState {
  status: TerminalStatus;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  error: { code: LucyErrorCode | null; message: string } | null;
  /** Title set by the program (OSC 0/2), sanitized for display; "" when none. */
  title: string;
  cols: number;
  rows: number;
  /** Working directory reported by the shell (OSC 7), if any. */
  cwd: string | null;
  startedAt: number | null;
  /** Throttled: may lag the true last output by up to `activityThrottleMs`. */
  lastOutputAt: number | null;
  lastInputAt: number | null;
  /** A bell or notification arrived and the user has not interacted since. */
  unseenBell: boolean;
  notification: TerminalNotification | null;
  progress: TerminalProgress | null;
  restarts: number;
}

/** Anything that can display terminal output, typically an `EmbeddedTerminalRenderable`. */
export interface TerminalScreen {
  write(data: Uint8Array): void;
  /** Called when the session restarts so the screen can clear itself. */
  reset?(): void;
}

export type PtySpawner = (options: PtySpawnOptions) => PtyProcess;

export interface TerminalSessionOptions {
  argv: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  cols?: number;
  rows?: number;
  /** How to start the PTY; pass `registry.spawn` so the process is cleaned up on quit. */
  spawn?: PtySpawner;
  /** Replay buffer size. Default 2 MiB. */
  bufferBytes?: number;
  /** Minimum interval between `lastOutputAt`/`lastInputAt` store updates. Default 250 ms. */
  activityThrottleMs?: number;
  /** Start immediately (default). Otherwise call `start()`. */
  autoStart?: boolean;
  coalesce?: PtySpawnOptions["coalesce"];
  /** Clock, injectable for tests. */
  now?: () => number;
}

export interface PasteResult {
  /** False when nothing was sent (empty text or no running process). */
  sent: boolean;
  /** True when the program had enabled bracketed paste and the text was wrapped. */
  bracketed: boolean;
  /** The pasted text spans several lines. Without bracketed paste each line may run on its own. */
  multiline: boolean;
}

const DEFAULT_BUFFER_BYTES = 2 * 1024 * 1024;
const BRACKET_START = "\x1b[200~";
const BRACKET_END = "\x1b[201~";
const encoder = new TextEncoder();

/**
 * Removes control characters that could break out of a paste or act as commands (ESC would
 * allow a crafted `ESC[201~` to end bracketed paste early). Tabs and newlines are kept.
 */
function sanitizePasteText(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/** First offset in `bytes` where replay can safely start after the buffer dropped data. */
function resyncOffset(bytes: Uint8Array, atBoundary: boolean): number {
  let offset = 0;
  if (!atBoundary) {
    // The cut fell inside an escape sequence: skip to the next ESC or line feed.
    const limit = Math.min(bytes.byteLength, 64 * 1024);
    while (offset < limit && bytes[offset] !== 0x1b && bytes[offset] !== 0x0a) offset++;
    if (offset === limit) offset = 0;
  }
  // Never start in the middle of a UTF-8 character.
  while (offset < bytes.byteLength && ((bytes[offset] as number) & 0xc0) === 0x80) offset++;
  return offset;
}

/** Leading + trailing throttle for a timestamp field in the store. */
class ThrottledStamp implements Disposable {
  private pending: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastWritten = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly intervalMs: number,
    private readonly write: (value: number) => void,
  ) {}

  touch(now: number): void {
    if (now - this.lastWritten >= this.intervalMs && this.timer === null) {
      this.lastWritten = now;
      this.write(now);
      return;
    }
    this.pending = now;
    if (this.timer !== null) return;
    const wait = Math.max(0, this.intervalMs - (now - this.lastWritten));
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.pending === null) return;
      this.lastWritten = this.pending;
      this.write(this.pending);
      this.pending = null;
    }, wait);
  }

  reset(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.lastWritten = Number.NEGATIVE_INFINITY;
  }

  dispose(): void {
    this.reset();
  }
}

function initialState(cols: number, rows: number): TerminalSessionState {
  return {
    status: "starting",
    pid: null,
    exitCode: null,
    signal: null,
    error: null,
    title: "",
    cols,
    rows,
    cwd: null,
    startedAt: null,
    lastOutputAt: null,
    lastInputAt: null,
    unseenBell: false,
    notification: null,
    progress: null,
    restarts: 0,
  };
}

export class TerminalSession implements Disposable {
  readonly state: Store<TerminalSessionState>;
  private readonly options: TerminalSessionOptions;
  private readonly spawn: PtySpawner;
  private readonly now: () => number;
  private readonly buffer: ByteRingBuffer;
  private readonly screens = new Set<TerminalScreen>();
  private readonly outputEmitter = new Emitter<Uint8Array>();
  private readonly eventEmitter = new Emitter<TerminalStreamEvent>();
  private readonly outputStamp: ThrottledStamp;
  private readonly inputStamp: ThrottledStamp;
  private sniffer: TerminalStreamSniffer;
  /** Fed with evicted bytes: knows the modes in effect at the oldest retained byte. */
  private evictedSniffer = new TerminalStreamSniffer();
  private pty: PtyProcess | null = null;
  private ptySubscriptions = new DisposableStore();
  private generation = 0;
  private replaying = false;
  private disposed = false;

  constructor(options: TerminalSessionOptions) {
    this.options = { ...options, argv: [...options.argv] };
    this.spawn = options.spawn ?? spawnPty;
    this.now = options.now ?? Date.now;
    this.buffer = new ByteRingBuffer(options.bufferBytes ?? DEFAULT_BUFFER_BYTES);
    const size = clampTerminalSize(options.cols, options.rows);
    this.state = new Store(initialState(size.cols, size.rows));
    const throttle = options.activityThrottleMs ?? 250;
    this.outputStamp = new ThrottledStamp(throttle, (at) => this.state.update({ lastOutputAt: at }));
    this.inputStamp = new ThrottledStamp(throttle, (at) => this.state.update({ lastInputAt: at }));
    this.sniffer = new TerminalStreamSniffer((event) => this.handleEvent(event));
    if (options.autoStart ?? true) this.start();
  }

  get argv(): readonly string[] {
    return this.options.argv;
  }

  /** Input-relevant modes the program has requested (bracketed paste, kitty flags, ...). */
  get modes(): TerminalModes {
    return this.sniffer.modes;
  }

  get isRunning(): boolean {
    return this.pty?.isRunning ?? false;
  }

  get attachedScreenCount(): number {
    return this.screens.size;
  }

  /** `start()` has been called at least once (with `autoStart: false`, until then it has not). */
  get hasStarted(): boolean {
    return this.generation > 0;
  }

  /**
   * True when the output so far does not end inside an escape sequence: bytes written to an
   * attached emulator now (a colour prelude) cannot corrupt a sequence the program is sending.
   */
  get atSequenceBoundary(): boolean {
    return this.sniffer.atSequenceBoundary;
  }

  /** Starts the process if it is not running. Failures are reported through `state`. */
  start(): void {
    if (this.disposed || this.pty) return;
    const generation = ++this.generation;
    const { cols, rows } = this.state.get();
    this.state.update({ status: "starting", error: null, exitCode: null, signal: null, pid: null });
    let pty: PtyProcess;
    try {
      pty = this.spawn({
        argv: this.options.argv,
        cwd: this.options.cwd,
        env: this.options.env,
        cols,
        rows,
        coalesce: this.options.coalesce,
      });
    } catch (error) {
      logger.warn("start failed", { command: this.options.argv[0], error: errorMessage(error) });
      this.state.update({
        status: "failed",
        error: { code: isLucyError(error) ? error.code : null, message: errorMessage(error) },
      });
      return;
    }
    this.pty = pty;
    this.ptySubscriptions = new DisposableStore();
    this.ptySubscriptions.add(pty.onData((data) => this.handleOutput(generation, data)));
    this.ptySubscriptions.add(pty.onExit((info) => this.handleExit(generation, info)));
    this.state.update({ status: "running", pid: pty.pid, startedAt: this.now() });
  }

  /**
   * Connects a screen. With `replay` (default), the buffered output is written to it first so a
   * freshly created screen shows what happened before it existed. Detach with the returned
   * Disposable.
   */
  attach(screen: TerminalScreen, options: { replay?: boolean } = {}): Disposable {
    if (this.disposed) return toDisposable(() => {});
    if ((options.replay ?? true) && this.buffer.size > 0) this.replayInto(screen);
    this.screens.add(screen);
    return toDisposable(() => {
      this.screens.delete(screen);
    });
  }

  /** Raw output as it arrives (after per-tick coalescing). */
  onOutput(listener: (data: Uint8Array) => void): Disposable {
    return this.outputEmitter.on(listener);
  }

  /** Bell, title, notification, progress, cwd and mode events from the output stream. */
  onEvent(listener: (event: TerminalStreamEvent) => void): Disposable {
    return this.eventEmitter.on(listener);
  }

  /** User input (keystrokes, mouse, focus reports). Counts as interaction. */
  sendInput(data: string | Uint8Array): boolean {
    if (!this.pty?.isRunning) return false;
    const ok = this.pty.write(data);
    if (ok) this.noteInteraction();
    return ok;
  }

  /** Emulator answers to terminal queries. Not user input; dropped while replaying. */
  sendResponse(data: Uint8Array): boolean {
    if (this.replaying || !this.pty?.isRunning) return false;
    return this.pty.write(data);
  }

  /**
   * Pastes text as if the user pasted it. Bracketed when the program enabled bracketed paste.
   * Never appends Enter: a trailing line break is removed when the paste is not bracketed (where
   * it would submit), and kept verbatim inside brackets (where the program decides).
   */
  paste(text: string): PasteResult {
    let clean = sanitizePasteText(text);
    const bracketed = this.sniffer.modes.bracketedPaste;
    if (!bracketed) clean = clean.replace(/\n+$/, "");
    const multiline = clean.includes("\n");
    if (clean.length === 0 || !this.pty?.isRunning) return { sent: false, bracketed, multiline };
    // Unbracketed: terminals send CR for a newline; LF would be read as Ctrl+J by many programs.
    const payload = bracketed ? `${BRACKET_START}${clean}${BRACKET_END}` : clean.replace(/\n/g, "\r");
    const sent = this.pty.write(encoder.encode(payload));
    if (sent) this.noteInteraction();
    return { sent, bracketed, multiline };
  }

  resize(cols: number, rows: number): void {
    const current = this.state.get();
    const size = clampTerminalSize(cols, rows, { cols: current.cols, rows: current.rows });
    if (size.cols === current.cols && size.rows === current.rows) return;
    this.state.update(size);
    this.pty?.resize(size.cols, size.rows);
  }

  /** Clears the attention flag (call when the user looks at the terminal). */
  markSeen(): void {
    const state = this.state.get();
    if (state.unseenBell || state.notification) this.state.update({ unseenBell: false, notification: null });
  }

  /** Kills the current process tree (if any), clears the screen and starts the command again. */
  async restart(): Promise<void> {
    if (this.disposed) return;
    const previous = this.pty;
    this.generation++;
    this.ptySubscriptions.dispose();
    this.pty = null;
    if (previous) {
      await previous.kill();
      previous.dispose();
    }
    if (this.disposed) return;
    this.buffer.clear();
    this.sniffer.reset();
    this.evictedSniffer = new TerminalStreamSniffer();
    this.outputStamp.reset();
    this.inputStamp.reset();
    for (const screen of this.screens) {
      try {
        screen.reset?.();
      } catch (error) {
        logger.warn("screen reset failed", { error: errorMessage(error) });
      }
    }
    this.state.update({
      title: "",
      cwd: null,
      lastOutputAt: null,
      lastInputAt: null,
      unseenBell: false,
      notification: null,
      progress: null,
      restarts: this.state.get().restarts + 1,
    });
    this.start();
  }

  /**
   * Releases the session. `kill` (default) kills the whole process tree with escalation;
   * `kill: false` only hangs up the PTY, like closing a terminal window (SIGHUP to the session).
   */
  dispose(options: { kill?: boolean } = {}): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.ptySubscriptions.dispose();
    const pty = this.pty;
    this.pty = null;
    if (pty) {
      if (options.kill === false) pty.hangup();
      pty.dispose();
    }
    this.screens.clear();
    this.outputStamp.dispose();
    this.inputStamp.dispose();
    this.outputEmitter.dispose();
    this.eventEmitter.dispose();
  }

  private replayInto(screen: TerminalScreen): void {
    const bytes = this.buffer.toBytes();
    let prelude = "";
    let payload = bytes;
    if (this.buffer.droppedBytes > 0) {
      prelude = this.evictedSniffer.modePrelude();
      payload = bytes.subarray(resyncOffset(bytes, this.evictedSniffer.atSequenceBoundary));
    }
    this.replaying = true;
    try {
      if (prelude) screen.write(encoder.encode(prelude));
      screen.write(payload);
    } catch (error) {
      logger.warn("replay failed", { error: errorMessage(error) });
    } finally {
      this.replaying = false;
    }
  }

  private handleOutput(generation: number, data: Uint8Array): void {
    if (generation !== this.generation) return;
    this.sniffer.feed(data);
    this.buffer.push(data, (evicted) => this.evictedSniffer.feed(evicted));
    for (const screen of this.screens) {
      try {
        screen.write(data);
      } catch (error) {
        logger.warn("screen write failed", { error: errorMessage(error) });
      }
    }
    this.outputEmitter.emit(data);
    this.outputStamp.touch(this.now());
  }

  private handleExit(generation: number, info: PtyExitInfo): void {
    if (generation !== this.generation) return;
    this.ptySubscriptions.dispose();
    this.pty = null;
    this.state.update({ status: "exited", exitCode: info.code, signal: info.signal });
  }

  private handleEvent(event: TerminalStreamEvent): void {
    const at = this.now();
    switch (event.type) {
      case "bell":
        this.state.update({ unseenBell: true });
        break;
      case "notification":
        this.state.update({ unseenBell: true, notification: { title: event.title, body: event.body, at } });
        break;
      case "title":
        this.state.update({ title: event.title });
        break;
      case "cwd":
        this.state.update({ cwd: event.path });
        break;
      case "progress":
        this.state.update({ progress: event.progress.state === "none" ? null : event.progress });
        break;
      default:
        break;
    }
    this.eventEmitter.emit(event);
  }

  private noteInteraction(): void {
    this.inputStamp.touch(this.now());
    this.markSeen();
  }
}
