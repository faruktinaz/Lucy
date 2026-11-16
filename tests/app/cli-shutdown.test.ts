import { describe, expect, test } from "bun:test";
import { helpText, parseArgs } from "@/app/cli";
import { ShutdownController, type ShutdownSteps } from "@/app/shutdown";
import { LucyError } from "@/core/errors";
import { describeWorkspaceError } from "@/main";

describe("parseArgs", () => {
  test("defaults to the current folder", () => {
    expect(parseArgs([])).toEqual({
      kind: "run",
      options: { path: ".", demo: false, conflict: false, debug: false, restore: true },
    });
  });

  test("accepts a path and every flag", () => {
    expect(parseArgs(["~/code/app", "--debug", "--no-restore"])).toEqual({
      kind: "run",
      options: { path: "~/code/app", demo: false, conflict: false, debug: true, restore: false },
    });
    expect(parseArgs(["--demo", "--conflict"])).toMatchObject({
      kind: "run",
      options: { demo: true, conflict: true },
    });
    expect(parseArgs(["--", "--weird-folder-name"])).toMatchObject({
      options: { path: "--weird-folder-name" },
    });
  });

  test("help and version win over everything else", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["-h", "some/path"])).toEqual({ kind: "help" });
    expect(parseArgs(["-v"])).toEqual({ kind: "version" });
    expect(parseArgs(["--version"])).toEqual({ kind: "version" });
  });

  test("unknown flags exit with code 2 and suggest the closest flag", () => {
    const result = parseArgs(["--demmo"]);
    expect(result).toMatchObject({ kind: "error", exitCode: 2 });
    if (result.kind === "error") {
      expect(result.message).toContain('Did you mean "--demo"');
      expect(result.message).toContain("lucy --help");
    }
    expect(parseArgs(["--frobnicate"])).toMatchObject({ kind: "error", exitCode: 2 });
  });

  test("contradictions are errors", () => {
    expect(parseArgs(["a", "b"])).toMatchObject({ kind: "error", exitCode: 2 });
    expect(parseArgs(["--conflict"])).toMatchObject({ kind: "error", exitCode: 2 });
    expect(parseArgs(["--demo", "some/path"])).toMatchObject({ kind: "error", exitCode: 2 });
  });

  test("the help text documents every option and the escape hatch", () => {
    const help = helpText("1.2.3");
    for (const flag of ["--demo", "--conflict", "--no-restore", "--debug", "--help", "--version"]) {
      expect(help).toContain(flag);
    }
    expect(help).toContain("Ctrl+\\");
  });

  test("workspace errors become calm sentences", () => {
    expect(describeWorkspaceError(new LucyError("NOT_FOUND", "x"), "nope")).toBe(
      'lucy: "nope" does not exist.',
    );
    expect(describeWorkspaceError(new LucyError("PERMISSION_DENIED", "x"), "/root")).toContain("permission");
  });
});

function recorder(overrides: Partial<ShutdownSteps> = {}): { steps: ShutdownSteps; calls: string[] } {
  const calls: string[] = [];
  const steps: ShutdownSteps = {
    disposeApp: async () => void calls.push("dispose"),
    killTerminals: () => void calls.push("kill"),
    destroyRenderer: async () => void calls.push("renderer"),
    cleanup: () => void calls.push("cleanup"),
    flushLogs: async () => void calls.push("logs"),
    exit: (code) => void calls.push(`exit:${code}`),
    onStepError: (step) => void calls.push(`error:${step}`),
    ...overrides,
  };
  return { steps, calls };
}

describe("ShutdownController", () => {
  test("runs every step once, in order, and exits with the first code", async () => {
    const { steps, calls } = recorder();
    const shutdown = new ShutdownController(steps);
    const first = shutdown.run(0);
    const second = shutdown.run(130);
    expect(second).toBe(first);
    await Promise.all([first, second, shutdown.run(1)]);
    expect(calls).toEqual(["dispose", "kill", "renderer", "cleanup", "logs", "exit:0"]);
    expect(shutdown.started).toBe(true);
  });

  test("a failing step is reported and the process still exits", async () => {
    const { steps, calls } = recorder({
      disposeApp: async () => {
        throw new Error("disk full");
      },
    });
    await new ShutdownController(steps).run(143);
    expect(calls).toEqual(["error:dispose app", "kill", "renderer", "cleanup", "logs", "exit:143"]);
  });
});
