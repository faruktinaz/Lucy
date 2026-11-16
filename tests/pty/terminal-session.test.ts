import { afterEach, describe, expect, test } from "bun:test";
import { type PtySpawnOptions, type TerminalScreen, TerminalSession } from "@/adapters/pty";
import { FakePty, waitFor } from "./helpers";

const sessions: TerminalSession[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

function fakeSession(options: { bufferBytes?: number } = {}) {
  const ptys: FakePty[] = [];
  const session = new TerminalSession({
    argv: ["fake-program"],
    bufferBytes: options.bufferBytes,
    activityThrottleMs: 0,
    spawn: (spawnOptions: PtySpawnOptions) => {
      const pty = new FakePty(spawnOptions);
      ptys.push(pty);
      return pty;
    },
  });
  sessions.push(session);
  const current = () => ptys.at(-1) as FakePty;
  return { session, ptys, current };
}

function recordingScreen(): TerminalScreen & { text(): string; writes: Uint8Array[]; resets: number } {
  const writes: Uint8Array[] = [];
  const screen = {
    writes,
    resets: 0,
    write: (data: Uint8Array) => writes.push(data.slice()),
    reset: () => {
      screen.resets++;
    },
    text: () => Buffer.concat(writes.map((chunk) => Buffer.from(chunk))).toString("utf8"),
  };
  return screen;
}

describe("TerminalSession with a fake PTY", () => {
  test("status: starting -> running -> exited, with code and signal", () => {
    const { session, current } = fakeSession();
    expect(session.state.get().status).toBe("running");
    expect(session.state.get().pid).toBe(current().pid);
    expect(session.state.get().startedAt).not.toBeNull();
    current().exit({ code: null, signal: "SIGKILL" });
    expect(session.state.get()).toMatchObject({ status: "exited", exitCode: null, signal: "SIGKILL" });
  });

  test("output is buffered while detached and replayed on attach", () => {
    const { session, current } = fakeSession();
    current().emit("before attach\r\n");
    const first = recordingScreen();
    const attachment = session.attach(first);
    expect(first.text()).toBe("before attach\r\n");
    current().emit("live\r\n");
    expect(first.text()).toBe("before attach\r\nlive\r\n");
    attachment.dispose();
    current().emit("while hidden\r\n");
    expect(first.text()).not.toContain("while hidden");
    const second = recordingScreen();
    session.attach(second);
    expect(second.text()).toBe("before attach\r\nlive\r\nwhile hidden\r\n");
    const noReplay = recordingScreen();
    session.attach(noReplay, { replay: false });
    expect(noReplay.writes.length).toBe(0);
  });

  test("after the ring buffer wraps, replay restores the modes active at the cut", () => {
    const { session, current } = fakeSession({ bufferBytes: 64 });
    current().emit("\x1b[?1049h\x1b[?2004h");
    current().emit(`\x1b]2;my title\x07${"x".repeat(100)}`);
    current().emit("tail-ğ");
    const screen = recordingScreen();
    session.attach(screen);
    const replayed = screen.text();
    expect(replayed.startsWith("\x1b[?1049h\x1b[?2004h")).toBe(true);
    expect(replayed.endsWith("tail-ğ")).toBe(true);
    expect(session.state.get().title).toBe("my title");
  });

  test("query responses produced during replay never reach the PTY", () => {
    const { session, current } = fakeSession();
    current().emit("\x1b[c");
    const answering: TerminalScreen = {
      // Mimics the emulator: answering DA1 synchronously while consuming output.
      write: (data) => {
        if (Buffer.from(data).toString("latin1").includes("\x1b[c"))
          session.sendResponse(new Uint8Array([0x1b, 0x5b, 0x3f, 0x63]));
      },
    };
    session.attach(answering);
    expect(current().writes.length).toBe(0);
    current().emit("\x1b[c");
    expect(current().writes.length).toBe(1);
    expect(session.state.get().lastInputAt).toBeNull();
  });

  test("bell, notification and title update the state; input marks them seen", () => {
    const { session, current } = fakeSession();
    current().emit("\x1b]0;Claude Code\x07");
    expect(session.state.get().title).toBe("Claude Code");
    current().emit("\x07");
    expect(session.state.get().unseenBell).toBe(true);
    current().emit("\x1b]777;notify;Claude;Needs your approval\x07");
    expect(session.state.get().notification).toMatchObject({ title: "Claude", body: "Needs your approval" });
    session.sendInput("x");
    expect(session.state.get().unseenBell).toBe(false);
    expect(session.state.get().notification).toBeNull();
    expect(session.state.get().lastInputAt).not.toBeNull();
    current().emit("\x07");
    session.markSeen();
    expect(session.state.get().unseenBell).toBe(false);
  });

  test("paste: raw without bracketed paste, never a trailing Enter", () => {
    const { session, current } = fakeSession();
    expect(session.paste("echo one\r\necho two\n\n")).toEqual({
      sent: true,
      bracketed: false,
      multiline: true,
    });
    expect(current().writtenText()).toBe("echo one\recho two");
  });

  test("paste: bracketed when the program enabled it, control characters stripped", () => {
    const { session, current } = fakeSession();
    current().emit("\x1b[?2004h");
    const result = session.paste("line 1\nhack\x1b[201~rm -rf ~\x03\n");
    expect(result).toEqual({ sent: true, bracketed: true, multiline: true });
    expect(current().writtenText()).toBe("\x1b[200~line 1\nhack[201~rm -rf ~\n\x1b[201~");
    expect(session.paste("").sent).toBe(false);
  });

  test("resize is clamped and forwarded", () => {
    const { session, current } = fakeSession();
    session.resize(120, 0);
    expect(session.state.get()).toMatchObject({ cols: 120, rows: 1 });
    expect({ cols: current().cols, rows: current().rows }).toEqual({ cols: 120, rows: 1 });
  });

  test("restart kills the old tree, resets screens and starts again", async () => {
    const { session, ptys, current } = fakeSession();
    const screen = recordingScreen();
    session.attach(screen);
    current().emit("old output\x07");
    await session.restart();
    expect(ptys.length).toBe(2);
    expect(ptys[0]?.killed).toBe(true);
    expect(screen.resets).toBe(1);
    expect(session.state.get()).toMatchObject({ status: "running", restarts: 1, unseenBell: false });
    // Output from the old process can no longer reach the session.
    ptys[0]?.emit("stale");
    expect(screen.text()).not.toContain("stale");
    const late = recordingScreen();
    session.attach(late);
    expect(late.text()).toBe("");
  });

  test("dispose kills by default; dispose({ kill: false }) only hangs up", () => {
    const killed = fakeSession();
    killed.session.dispose();
    expect(killed.current().killed).toBe(true);
    const hungUp = fakeSession();
    hungUp.session.dispose({ kill: false });
    expect(hungUp.current().hungUp).toBe(true);
    expect(hungUp.current().killed).toBe(false);
    hungUp.session.dispose();
  });
});

describe("TerminalSession with a real PTY", () => {
  test("failed spawn reports status failed with SPAWN_FAILED", () => {
    const session = new TerminalSession({ argv: ["/nonexistent/lucy-program"] });
    sessions.push(session);
    expect(session.state.get()).toMatchObject({ status: "failed", error: { code: "SPAWN_FAILED" } });
  });

  test("runs, records output time, exits with its code", async () => {
    const session = new TerminalSession({ argv: ["/bin/sh", "-c", "printf 'hi\\a'; exit 3"] });
    sessions.push(session);
    const screen = recordingScreen();
    session.attach(screen);
    expect(await waitFor(() => session.state.get().status === "exited")).toBe(true);
    expect(session.state.get()).toMatchObject({ exitCode: 3, signal: null, unseenBell: true });
    expect(session.state.get().lastOutputAt).not.toBeNull();
    expect(screen.text()).toBe("hi\x07");
  });
});
