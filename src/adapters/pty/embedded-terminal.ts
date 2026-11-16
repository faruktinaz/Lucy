/**
 * Glue between a `TerminalSession` and OpenTUI's `EmbeddedTerminalRenderable`.
 *
 * The renderable is a native VT emulator (libghostty-vt) that does not manage a process. When it
 * has focus it turns key presses, pastes, mouse and focus changes into bytes and reports them via
 * `onData(bytes, "input")`; answers to terminal queries arrive as `onData(bytes, "response")`.
 * Both must be written to the PTY. Its `onTerminalResize(cols, rows)` fires after layout changes
 * its size, and the PTY must follow so the program sees the new size (SIGWINCH).
 *
 * Typed structurally so this adapter has no runtime dependency on OpenTUI.
 */
import { type Disposable, toDisposable } from "@/core/events";
import type { TerminalSession } from "./terminal-session";

export interface EmbeddedTerminalLike {
  write(data: string | Uint8Array): void;
  onData: ((data: Uint8Array, source: "input" | "response") => void) | undefined;
  onTerminalResize: ((cols: number, rows: number) => void) | undefined;
  readonly width?: number;
  readonly height?: number;
}

export interface ConnectEmbeddedTerminalOptions {
  /** Replay buffered output into the terminal first (default true). */
  replay?: boolean;
  /** Resize the PTY to the terminal's current size on connect (default true). */
  syncSize?: boolean;
  /**
   * Bytes written to the emulator itself (never to the PTY) on connect and after every restart.
   * Use it to set default colours so programs that query them (OSC 10/11, used for light/dark
   * detection) see Lucy's theme instead of the emulator's built-in black background, e.g.
   * `"\x1b]10;rgb:e6/e6/e6\x1b\\\x1b]11;rgb:1e/1e/2e\x1b\\"`. A getter is read each time, so a
   * restart after a theme change uses the current theme.
   */
  screenPrelude?: string | (() => string);
}

/** Full reset (RIS) plus clearing scrollback, for a restarted process. */
const RESET_SCREEN = "\x1bc\x1b[3J";

/**
 * Wires a renderable to a session: input and query responses go to the PTY, output goes to the
 * renderable, renderable resizes resize the PTY. Dispose to detach (the renderable is not
 * destroyed; the session keeps running).
 */
export function connectEmbeddedTerminal(
  session: TerminalSession,
  terminal: EmbeddedTerminalLike,
  options: ConnectEmbeddedTerminalOptions = {},
): Disposable {
  const onData = (data: Uint8Array, source: "input" | "response") => {
    if (source === "response") session.sendResponse(data);
    else session.sendInput(data);
  };
  const onTerminalResize = (cols: number, rows: number) => session.resize(cols, rows);
  terminal.onData = onData;
  terminal.onTerminalResize = onTerminalResize;
  const prelude = () =>
    typeof options.screenPrelude === "function" ? options.screenPrelude() : (options.screenPrelude ?? "");
  const initial = prelude();
  if (initial) terminal.write(initial);
  const { width, height } = terminal;
  if ((options.syncSize ?? true) && width !== undefined && height !== undefined && width > 0 && height > 0) {
    session.resize(width, height);
  }
  const attachment = session.attach(
    {
      write: (data) => terminal.write(data),
      reset: () => {
        terminal.write(RESET_SCREEN);
        const current = prelude();
        if (current) terminal.write(current);
      },
    },
    { replay: options.replay ?? true },
  );
  return toDisposable(() => {
    attachment.dispose();
    if (terminal.onData === onData) terminal.onData = undefined;
    if (terminal.onTerminalResize === onTerminalResize) terminal.onTerminalResize = undefined;
  });
}
