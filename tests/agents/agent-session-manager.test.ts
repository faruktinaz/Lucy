import { afterEach, describe, expect, test } from "bun:test";
import {
  type AgentLaunchMode,
  type AgentProvider,
  AgentSessionManager,
  deriveAgentActivity,
} from "@/adapters/agents";
import type { PtySpawnOptions, TerminalSessionState } from "@/adapters/pty";
import { isLucyError } from "@/core/errors";
import { FakePty } from "../pty/helpers";

const managers: AgentSessionManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
});

const fakeProvider: AgentProvider = {
  id: "fake",
  displayName: "Fake Agent",
  capabilities: { continue: true, resumePicker: true, resumeById: true, sessionDiscovery: false },
  detect: async () => ({ available: true, executable: "/bin/fake", version: "1.0.0", problem: null }),
  buildLaunch: (mode: AgentLaunchMode, options) => ({
    argv: ["/bin/fake", mode.kind],
    cwd: options.cwd,
    warnings: options.extraArgs?.includes("--yolo")
      ? [{ code: "PERMISSION_BYPASS", arg: "--yolo", message: "bypass" }]
      : [],
  }),
};

function setup(now = { value: 10_000 }) {
  const ptys: FakePty[] = [];
  const manager = new AgentSessionManager({
    providers: [fakeProvider],
    spawn: (options: PtySpawnOptions) => {
      const pty = new FakePty(options);
      ptys.push(pty);
      return pty;
    },
    terminalDefaults: { activityThrottleMs: 0, now: () => now.value },
    now: () => now.value,
    workingWindowMs: 1000,
    echoWindowMs: 300,
    tickMs: 10_000,
  });
  managers.push(manager);
  return { manager, ptys, now };
}

function terminalState(partial: Partial<TerminalSessionState>): TerminalSessionState {
  return {
    status: "running",
    pid: 1,
    exitCode: null,
    signal: null,
    error: null,
    title: "",
    cols: 80,
    rows: 24,
    cwd: null,
    startedAt: 0,
    lastOutputAt: null,
    lastInputAt: null,
    unseenBell: false,
    notification: null,
    progress: null,
    restarts: 0,
    ...partial,
  };
}

describe("deriveAgentActivity", () => {
  test("exited, attention, working, idle, with echo suppression and progress", () => {
    const now = 5000;
    expect(deriveAgentActivity(terminalState({ status: "exited" }), now)).toBe("exited");
    expect(deriveAgentActivity(terminalState({ status: "failed" }), now)).toBe("exited");
    expect(deriveAgentActivity(terminalState({ unseenBell: true, lastOutputAt: now }), now)).toBe(
      "attention",
    );
    expect(deriveAgentActivity(terminalState({ lastOutputAt: now - 100 }), now)).toBe("working");
    expect(deriveAgentActivity(terminalState({ lastOutputAt: now - 5000 }), now)).toBe("idle");
    // Output right after a keystroke is just the echo of the user's typing.
    expect(deriveAgentActivity(terminalState({ lastInputAt: now - 120, lastOutputAt: now - 100 }), now)).toBe(
      "idle",
    );
    expect(
      deriveAgentActivity(terminalState({ lastInputAt: now - 1000, lastOutputAt: now - 100 }), now),
    ).toBe("working");
    expect(
      deriveAgentActivity(terminalState({ progress: { state: "indeterminate", value: null } }), now),
    ).toBe("working");
  });
});

describe("AgentSessionManager", () => {
  test("create, list, rename, close", () => {
    const { manager, ptys } = setup();
    const session = manager.create({
      providerId: "fake",
      mode: { kind: "continue" },
      cwd: "/w",
      extraArgs: ["--yolo"],
    });
    expect(session).toMatchObject({
      providerId: "fake",
      title: "Fake Agent (continued)",
      cwd: "/w",
      mode: { kind: "continue" },
    });
    expect(session.warnings.map((warning) => warning.code)).toEqual(["PERMISSION_BYPASS"]);
    expect(ptys[0]?.argv).toEqual(["/bin/fake", "continue"]);
    expect(manager.list().map((entry) => entry.id)).toEqual([session.id]);
    manager.rename(session.id, "  Fix\nthe  login bug ");
    expect(manager.get(session.id)?.title).toBe("Fix the login bug");
    manager.close(session.id);
    expect(manager.list()).toEqual([]);
    expect(ptys[0]?.killed).toBe(true);
  });

  test("activity follows the terminal: working, attention, idle, exited", () => {
    const { manager, ptys, now } = setup();
    const session = manager.create({ providerId: "fake", mode: { kind: "new" }, cwd: "/w" });
    const pty = ptys[0] as FakePty;
    pty.emit("thinking...");
    expect(manager.get(session.id)?.activity).toBe("working");
    now.value += 5000;
    manager.refresh();
    expect(manager.get(session.id)?.activity).toBe("idle");
    pty.emit("\x07");
    expect(manager.get(session.id)?.activity).toBe("attention");
    session.terminal.markSeen();
    expect(manager.get(session.id)?.activity).toBe("working");
    now.value += 5000;
    manager.refresh();
    expect(manager.get(session.id)?.activity).toBe("idle");
    pty.exit({ code: 0, signal: null });
    expect(manager.get(session.id)?.activity).toBe("exited");
  });

  test("pastePrompt pastes without ever pressing Enter", () => {
    const { manager, ptys } = setup();
    const session = manager.create({ providerId: "fake", mode: { kind: "new" }, cwd: "/w" });
    const pty = ptys[0] as FakePty;
    pty.emit("\x1b[?2004h");
    manager.pastePrompt(session.id, "Explain @src/a.ts");
    expect(pty.writtenText()).toBe("\x1b[200~Explain @src/a.ts\x1b[201~");
    expect(pty.writtenText()).not.toContain("\r");
  });

  test("errors are LucyErrors; dispose closes everything", () => {
    const { manager, ptys } = setup();
    let unknown: unknown;
    try {
      manager.create({ providerId: "nope", mode: { kind: "new" }, cwd: "/w" });
    } catch (error) {
      unknown = error;
    }
    expect(isLucyError(unknown, "NOT_FOUND")).toBe(true);
    const session = manager.create({ providerId: "fake", mode: { kind: "new" }, cwd: "/w" });
    let empty: unknown;
    try {
      manager.rename(session.id, " \n ");
    } catch (error) {
      empty = error;
    }
    expect(isLucyError(empty, "INVALID_ARGUMENT")).toBe(true);
    manager.dispose();
    expect(manager.list()).toEqual([]);
    expect(ptys[0]?.killed).toBe(true);
  });
});
