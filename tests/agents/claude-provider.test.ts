import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSessionManager,
  type AgentSessionManagerState,
  createClaudeProvider,
  inspectClaudeArgs,
} from "@/adapters/agents";
import { isLucyError } from "@/core/errors";
import { waitFor } from "../pty/helpers";

let root: string;
let binDir: string;
let realBinDir: string;
const managers: AgentSessionManager[] = [];

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lucy-agents-"));
  binDir = join(root, "bin");
  realBinDir = join(root, "real");
  mkdirSync(binDir);
  mkdirSync(realBinDir);
  // The fake prints its arguments one per bracket, then idles like an interactive program.
  const real = script(
    realBinDir,
    "claude-impl",
    [
      'if [ "$1" = "--version" ]; then echo "9.8.7 (Claude Code)"; exit 0; fi',
      "printf 'ARGS:'",
      `for a in "$@"; do printf '[%s]' "$a"; done`,
      "printf '\\n'",
      "sleep 30",
    ].join("\n"),
  );
  // A wrapper on PATH, like cmux's shim: it must be launched as is, not resolved through.
  symlinkSync(real, join(binDir, "claude"));
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const pathEnv = () => ({ PATH: `${binDir}:/usr/bin:/bin` });

describe("Claude provider: detection", () => {
  test("finds claude on PATH, keeps the PATH entry (no resolving through shims), reads the version", async () => {
    const detection = await createClaudeProvider({ env: pathEnv() }).detect();
    expect(detection).toEqual({
      available: true,
      executable: join(binDir, "claude"),
      version: "9.8.7",
      problem: null,
    });
  });

  test("missing executable is reported with a problem text", async () => {
    const empty = join(root, "empty");
    mkdirSync(empty, { recursive: true });
    const detection = await createClaudeProvider({ env: { PATH: empty } }).detect();
    expect(detection.available).toBe(false);
    expect(detection.executable).toBeNull();
    expect(detection.problem).toContain("not found on PATH");
    expect(detection.problem).not.toContain("`");
  });

  test("a failing --version is reported with its stderr", async () => {
    const broken = script(root, "broken-claude", 'echo "boom: missing runtime" >&2; exit 3');
    const detection = await createClaudeProvider({ executable: broken }).detect();
    expect(detection.available).toBe(false);
    expect(detection.problem).toContain("exit code 3");
    expect(detection.problem).toContain("boom: missing runtime");
  });

  test("a hanging --version times out without blocking", async () => {
    const slow = script(root, "slow-claude", "sleep 10");
    const started = Date.now();
    const detection = await createClaudeProvider({ executable: slow, versionTimeoutMs: 300 }).detect();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(detection).toMatchObject({ available: true, executable: slow, version: null });
    expect(detection.problem).toContain("did not answer");
  });

  test("config override: absolute path, command name, invalid values", async () => {
    const custom = script(root, "my-claude", 'echo "1.2.3"');
    expect((await createClaudeProvider({ executable: custom }).detect()).version).toBe("1.2.3");
    expect((await createClaudeProvider({ executable: "claude", env: pathEnv() }).detect()).available).toBe(
      true,
    );
    expect((await createClaudeProvider({ executable: "./relative/claude" }).detect()).available).toBe(false);
    expect((await createClaudeProvider({ executable: join(root, "nope") }).detect()).problem).toContain(
      "configured",
    );
  });
});

describe("Claude provider: launch", () => {
  const provider = () => createClaudeProvider({ env: pathEnv() });
  const exe = () => join(binDir, "claude");

  test("each mode maps to the verified flags; nothing else is added", () => {
    const cwd = "/work/space";
    expect(provider().buildLaunch({ kind: "new" }, { cwd })).toEqual({ argv: [exe()], cwd, warnings: [] });
    expect(provider().buildLaunch({ kind: "continue" }, { cwd }).argv).toEqual([exe(), "--continue"]);
    expect(provider().buildLaunch({ kind: "resume-picker" }, { cwd }).argv).toEqual([exe(), "--resume"]);
    expect(provider().buildLaunch({ kind: "resume", sessionId: " 8f1c-id " }, { cwd }).argv).toEqual([
      exe(),
      "--resume",
      "8f1c-id",
    ]);
  });

  test("configured extra args are appended, then per-launch extra args", () => {
    const launch = createClaudeProvider({ env: pathEnv(), extraArgs: ["--model", "opus"] }).buildLaunch(
      { kind: "continue" },
      { cwd: "/w", extraArgs: ["--verbose"] },
    );
    expect(launch.argv).toEqual([exe(), "--continue", "--model", "opus", "--verbose"]);
    expect(launch.warnings).toEqual([]);
  });

  test("a user's bypass flag is passed through, never stripped, and produces a warning", () => {
    const launch = createClaudeProvider({
      env: pathEnv(),
      extraArgs: ["--dangerously-skip-permissions"],
    }).buildLaunch({ kind: "new" }, { cwd: "/w" });
    expect(launch.argv).toEqual([exe(), "--dangerously-skip-permissions"]);
    expect(launch.warnings.map((warning) => warning.code)).toEqual(["PERMISSION_BYPASS"]);
    expect(launch.warnings[0]?.message).toContain("--dangerously-skip-permissions");
  });

  test("invalid session ids and a missing executable are LucyErrors", () => {
    for (const sessionId of ["", "  ", "--help", "a\nb"]) {
      let caught: unknown;
      try {
        provider().buildLaunch({ kind: "resume", sessionId }, { cwd: "/w" });
      } catch (error) {
        caught = error;
      }
      expect(isLucyError(caught, "INVALID_ARGUMENT")).toBe(true);
    }
    let missing: unknown;
    try {
      createClaudeProvider({ env: { PATH: join(root, "empty") } }).buildLaunch(
        { kind: "new" },
        { cwd: "/w" },
      );
    } catch (error) {
      missing = error;
    }
    expect(isLucyError(missing, "NOT_FOUND")).toBe(true);
  });
});

describe("inspectClaudeArgs", () => {
  const codes = (args: string[]) => inspectClaudeArgs(args).map((warning) => warning.code);

  test("every permission-bypass form is flagged", () => {
    expect(codes(["--dangerously-skip-permissions"])).toEqual(["PERMISSION_BYPASS"]);
    expect(codes(["--allow-dangerously-skip-permissions"])).toEqual(["PERMISSION_BYPASS"]);
    expect(codes(["--permission-mode", "bypassPermissions"])).toEqual(["PERMISSION_BYPASS"]);
    expect(codes(["--permission-mode=bypassPermissions"])).toEqual(["PERMISSION_BYPASS"]);
    expect(codes(["--settings", '{"permissions":{"defaultMode":"bypassPermissions"}}'])).toEqual([
      "PERMISSION_BYPASS",
    ]);
    expect(codes(["--permission-mode", "plan", "--settings", "/path/settings.json"])).toEqual([]);
  });

  test("option values are not prompts; real positionals are", () => {
    expect(
      codes(["--model", "opus", "--add-dir", "../a", "../b", "--debug", "api", "-n", "my session"]),
    ).toEqual([]);
    expect(codes(["fix the failing test"])).toEqual(["PROMPT_ARGUMENT"]);
    expect(codes(["--verbose", "mcp"])).toEqual(["PROMPT_ARGUMENT"]);
    expect(codes(["--", "--looks-like-a-flag"])).toEqual(["PROMPT_ARGUMENT"]);
  });

  test("non-interactive and mode-changing flags are flagged", () => {
    expect(codes(["-p"])).toEqual(["NON_INTERACTIVE"]);
    expect(codes(["--continue"])).toEqual(["MODE_OVERRIDE"]);
    expect(codes(["--resume", "abc"])).toEqual(["MODE_OVERRIDE"]);
  });
});

describe("AgentSessionManager with the Claude provider (fake claude in a PTY)", () => {
  test("launches the resolved executable with the mode's argv and tracks activity until close", async () => {
    const manager = new AgentSessionManager({
      providers: [createClaudeProvider({ env: pathEnv(), extraArgs: ["--model", "opus"] })],
      workingWindowMs: 150,
      tickMs: 25,
    });
    managers.push(manager);
    const states: AgentSessionManagerState[] = [];
    manager.state.subscribe(() => states.push(manager.state.get()));
    const session = manager.create({
      providerId: "claude",
      mode: { kind: "resume", sessionId: "abc-123" },
      cwd: root,
    });
    expect(session.title).toBe("Claude Code (abc-123)");
    let output = "";
    session.terminal.onOutput((data) => {
      output += Buffer.from(data).toString("utf8");
    });
    expect(await waitFor(() => output.includes("ARGS:"))).toBe(true);
    expect(output).toContain("ARGS:[--resume][abc-123][--model][opus]");
    expect(await waitFor(() => manager.get(session.id)?.activity === "idle", 3000)).toBe(true);
    expect(states.some((state) => state.sessions[0]?.activity === "working")).toBe(true);
    const pid = session.terminal.state.get().pid as number;
    manager.close(session.id);
    expect(manager.list()).toEqual([]);
    expect(
      await waitFor(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, 3000),
    ).toBe(true);
  });
});
