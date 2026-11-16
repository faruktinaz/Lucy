/**
 * `configureOpenTuiDataPath` must keep OpenTUI's GLOBAL tree-sitter client (used by widgets that
 * are not given Lucy's client) inside the injected directory. Runs in a child process whose HOME
 * and XDG_DATA_HOME are temp dirs, so the real home is never touched either way, and so the
 * process-wide OpenTUI singletons of this test run are left alone.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { listTree, makeTempDir, removeTempDirs } from "./helpers";

const PROBE = join(import.meta.dir, "fixtures", "opentui-data-path-probe.tsx");
const REPO = resolve(import.meta.dir, "../..");

afterAll(() => removeTempDirs());

interface ProbeRun {
  readonly result: { codeColored: boolean; fenceColored: boolean; globalDataPath: string };
  readonly home: string;
  readonly xdgData: string;
  readonly injected: string;
}

function runProbe(mode: "configure" | "default"): ProbeRun {
  const base = makeTempDir(`confine-${mode}`);
  const home = join(base, "home");
  const xdgData = join(base, "xdg-data");
  const injected = join(base, "injected");
  mkdirSync(home);
  mkdirSync(xdgData);
  const child = Bun.spawnSync([process.execPath, PROBE, mode, injected], {
    cwd: REPO,
    env: {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: xdgData,
      XDG_CONFIG_HOME: join(base, "xdg-config"),
      XDG_CACHE_HOME: join(base, "xdg-cache"),
      // Keep Bun's own transpiler cache out of the fake home so only OpenTUI writes are observed.
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  const stdout = child.stdout.toString();
  if (child.exitCode !== 0) {
    throw new Error(`probe exited with ${child.exitCode}\n${stdout}\n${child.stderr.toString()}`);
  }
  const line = stdout.trim().split("\n").at(-1) ?? "{}";
  return { result: JSON.parse(line), home, xdgData, injected };
}

describe("configureOpenTuiDataPath", () => {
  test("<code> and <markdown> on the default client write only inside the injected directory", () => {
    const run = runProbe("configure");
    expect(run.result.codeColored).toBe(true);
    expect(run.result.fenceColored).toBe(true);
    expect(run.result.globalDataPath).toBe(run.injected);
    expect(listTree(run.injected)).toEqual([
      "tree-sitter/",
      "tree-sitter/languages/",
      "tree-sitter/queries/",
    ]);
    expect(listTree(run.home)).toEqual([]);
    expect(listTree(run.xdgData)).toEqual([]);
  }, 60_000);

  test("control: without it, OpenTUI writes to XDG_DATA_HOME/opentui (so the check above can fail)", () => {
    const run = runProbe("default");
    expect(run.result.codeColored).toBe(true);
    expect(run.result.globalDataPath).toBe(join(run.xdgData, "opentui"));
    expect(listTree(run.xdgData)).toContain("opentui/tree-sitter/languages/");
    expect(listTree(run.home)).toEqual([]);
  }, 60_000);

  test("rejects a relative directory", async () => {
    const { configureOpenTuiDataPath } = await import("../../src/adapters/syntax");
    const { isLucyError } = await import("../../src/core/errors");
    let error: unknown;
    try {
      configureOpenTuiDataPath("relative/dir");
    } catch (caught) {
      error = caught;
    }
    expect(isLucyError(error, "INVALID_ARGUMENT")).toBe(true);
  });
});
