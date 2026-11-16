import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "@/core/process";
import {
  INTEGRATION_TOOLS,
  IntegrationsModel,
  parseVersion,
  type TerminalCapabilities,
  type ToolRow,
  type ToolRunner,
} from "@/features/settings/model/integrations-model";
import { makeTempDirs, type TempDirs } from "../core/helpers";

const TERMINAL: TerminalCapabilities = {
  name: "Ghostty",
  truecolor: true,
  kittyKeyboard: false,
  mouse: true,
  hyperlinks: false,
};
const FEATURES = [
  { id: "explorer", title: "Explorer" },
  { id: "scm", title: "Source Control" },
];

let temp: TempDirs;
let bin: string;
beforeEach(async () => {
  temp = await makeTempDirs();
  bin = join(temp.root, "bin");
  await mkdir(bin, { recursive: true });
});
afterEach(async () => {
  await temp.cleanup();
});

async function tool(name: string, script: string, mode = 0o755): Promise<string> {
  const path = join(bin, name);
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, mode);
  return path;
}

/**
 * The fake machine: some tools present with varied output, some missing (rg, hx, lazygit).
 * Every tool answers promptly here; the timeout is tested separately with tools that never
 * answer. (Sharing one short timeout between a deliberately slow tool and the normal ones
 * made the normal ones time out too when the whole suite loaded the machine.)
 */
async function populate(): Promise<void> {
  await tool("git", 'echo "git version 2.43.0"');
  await tool("claude", 'echo "1.0.33 (Claude Code)"');
  await tool("nvim", 'printf "NVIM v0.10.0\\nBuild type: Release\\n"');
  // Prints to stderr and exits non-zero: still a version.
  await tool("vim", 'echo "VIM - Vi IMproved 9.1 (2024 Jan 02)" >&2; exit 1');
  await tool(
    "tmux",
    'if [ "$1" = "-V" ]; then echo "tmux 3.4"; else echo "tmux: unknown option" >&2; exit 1; fi',
  );
  await tool("fzf", 'echo "0.54.3 (brew)"');
  // No version anywhere in the output.
  await tool("atuin", 'echo "hello from atuin"');
  await tool("zoxide", 'echo "zoxide v0.9.4"');
  // Present but not executable: not found on PATH.
  await tool("micro", 'echo "Version: 2.0.13"', 0o644);
}

function model(options: { runner?: ToolRunner; timeoutMs?: number } = {}) {
  return new IntegrationsModel({
    terminal: TERMINAL,
    features: FEATURES,
    env: { PATH: bin },
    // Generous: spawning a shell script can take hundreds of milliseconds on a loaded machine.
    timeoutMs: options.timeoutMs ?? 10_000,
    runner: options.runner,
    now: () => new Date("2026-11-16T12:00:00.000Z"),
  });
}

const byId = (m: IntegrationsModel) => new Map(m.state.tools.map((r) => [r.id, r]));

describe("parseVersion", () => {
  test.each([
    ["git version 2.43.0", "2.43.0"],
    ["ripgrep 14.1.0 (rev abc123)\n-SIMD", "14.1.0"],
    ["1.0.33 (Claude Code)", "1.0.33"],
    ["NVIM v0.10.0\nBuild type: Release", "0.10.0"],
    ["VIM - Vi IMproved 9.1 (2024 Jan 02, compiled)", "9.1"],
    ["Version: 2.0.13\nCommit hash: 68d88b57", "2.0.13"],
    ["helix 24.07 (079f5442)", "24.07"],
    ["commit=abc1234, build date=2024-01-02T10:00:00Z, version=0.40.2, os=darwin", "0.40.2"],
    ["tmux 3.4", "3.4"],
    ["tmux next-3.5", "3.5"],
    ["0.54.3 (brew)", "0.54.3"],
    ["atuin 18.3.0-beta.1", "18.3.0-beta.1"],
    ["\u001b[1mzoxide\u001b[0m 0.9.4", "0.9.4"],
    ["no version here", null],
    ["", null],
  ])("%j -> %j", (output, expected) => {
    expect(parseVersion(output)).toBe(expected);
  });
});

describe("IntegrationsModel", () => {
  test("found, missing, odd output and non-zero exit", async () => {
    await populate();
    const m = model();
    await m.refresh();
    const rows = byId(m);
    const pick = (id: string) => rows.get(id) as ToolRow;

    expect(pick("git")).toMatchObject({
      status: "found",
      path: join(bin, "git"),
      version: "2.43.0",
      versionStatus: "ok",
      required: true,
    });
    expect(pick("claude")).toMatchObject({ version: "1.0.33", versionStatus: "ok" });
    expect(pick("nvim").version).toBe("0.10.0");
    expect(pick("vim")).toMatchObject({ version: "9.1", versionStatus: "ok" });
    expect(pick("tmux")).toMatchObject({ version: "3.4", versionStatus: "ok" });
    expect(pick("fzf")).toMatchObject({ version: "0.54.3", versionStatus: "ok" });
    expect(pick("atuin")).toMatchObject({ status: "found", versionStatus: "unknown", version: null });
    expect(pick("zoxide").version).toBe("0.9.4");
    for (const id of ["ripgrep", "hx", "lazygit", "micro"]) {
      expect(pick(id)).toMatchObject({ status: "missing", path: null, version: null });
      expect(pick(id).note?.length).toBeGreaterThan(10);
      expect(pick(id).required).toBe(false);
    }
    expect(m.state.loading).toBe(false);
    expect(m.state.checkedAt).toBe("2026-11-16T12:00:00.000Z");
  }, 30_000);

  test("tools that never answer time out, in parallel", async () => {
    for (const name of ["fzf", "atuin", "zoxide"]) await tool(name, "exec /bin/sleep 30");
    const m = model({ timeoutMs: 1000 });
    const started = performance.now();
    await m.refresh();
    const elapsed = performance.now() - started;
    for (const id of ["fzf", "atuin", "zoxide"]) {
      expect(byId(m).get(id)).toMatchObject({ status: "found", versionStatus: "timeout", version: null });
      expect(byId(m).get(id)?.note).toContain("too long");
    }
    // Checked one after another this would take at least 3 s.
    expect(elapsed).toBeLessThan(2900);
  }, 30_000);

  test("every tool says what Lucy uses it for; hints never offer to install", () => {
    expect(INTEGRATION_TOOLS.map((t) => t.bin)).toEqual([
      "git",
      "rg",
      "claude",
      "micro",
      "hx",
      "nvim",
      "vim",
      "lazygit",
      "tmux",
      "fzf",
      "atuin",
      "zoxide",
    ]);
    for (const spec of INTEGRATION_TOOLS) {
      expect(spec.purpose.length).toBeGreaterThan(10);
      expect(spec.missingHint.toLowerCase()).not.toContain("lucy will install");
    }
    expect(INTEGRATION_TOOLS.filter((t) => t.required).map((t) => t.id)).toEqual(["git"]);
  });

  test("rows start in a loading state while checks run", async () => {
    await populate();
    const m = model();
    const pending = m.refresh();
    expect(m.state.loading).toBe(true);
    expect(
      m.state.tools.every((r) => r.status === "checking" || r.status === "found" || r.status === "missing"),
    ).toBe(true);
    await pending;
    expect(m.state.tools.some((r) => r.status === "checking")).toBe(false);
  }, 30_000);

  test("versions are cached until the executable changes or a forced refresh", async () => {
    await populate();
    const calls: string[] = [];
    const runner: ToolRunner = (argv, options) => {
      calls.push(argv[0]?.split("/").pop() ?? "");
      return run(argv, options);
    };
    const m = model({ runner });
    await m.refresh();
    const first = calls.length;
    expect(first).toBe(8);
    await m.refresh();
    // Unchanged executables come from the cache.
    expect(calls.slice(first)).toEqual([]);
    expect(byId(m).get("git")?.version).toBe("2.43.0");

    await writeFile(join(bin, "git"), '#!/bin/sh\necho "git version 2.44.1"\n');
    await utimes(join(bin, "git"), new Date(), new Date(Date.now() + 5000));
    const before = calls.length;
    await m.refresh();
    expect(calls.slice(before)).toEqual(["git"]);
    expect(byId(m).get("git")?.version).toBe("2.44.1");

    const beforeForce = calls.length;
    await m.refresh({ force: true });
    expect(calls.length - beforeForce).toBe(8);
  }, 30_000);

  test("cancel stops a running refresh and marks unfinished rows", async () => {
    await populate();
    await tool("fzf", "exec /bin/sleep 30");
    const m = model();
    const pending = m.refresh();
    await Bun.sleep(150);
    m.cancel();
    expect(m.state.loading).toBe(false);
    expect(byId(m).get("fzf")?.versionStatus).toBe("cancelled");
    await pending;
    // Late results of the cancelled run do not overwrite the cancelled state.
    expect(byId(m).get("fzf")?.versionStatus).toBe("cancelled");
    expect(m.state.checkedAt).toBeNull();
  }, 30_000);

  test("a new refresh supersedes one still running", async () => {
    await populate();
    const m = model();
    const first = m.refresh();
    const second = m.refresh({ force: true });
    await Promise.all([first, second]);
    expect(m.state.loading).toBe(false);
    expect(byId(m).get("git")?.version).toBe("2.43.0");
  }, 30_000);

  test("a runner failure becomes a row error with a note", async () => {
    await tool("git", 'echo "git version 2.43.0"');
    const m = model({
      runner: () => Promise.reject(new Error("spawn exploded")),
    });
    await m.refresh();
    expect(byId(m).get("git")).toMatchObject({ status: "found", versionStatus: "error" });
    expect(byId(m).get("git")?.note).toContain("spawn exploded");
  });

  test("terminal capabilities and built-in features are shown as injected", () => {
    const m = model();
    expect(m.state.terminalName).toBe("Ghostty");
    expect(m.state.capabilities.map((c) => [c.id, c.supported])).toEqual([
      ["truecolor", true],
      ["kittyKeyboard", false],
      ["mouse", true],
      ["hyperlinks", false],
    ]);
    expect(m.state.capabilities.find((c) => c.id === "kittyKeyboard")?.note).toContain("fallbacks");
    expect(m.state.features).toEqual(FEATURES);
    m.setTerminal({ ...TERMINAL, name: "kitty", kittyKeyboard: true });
    expect(m.state.terminalName).toBe("kitty");
    expect(m.state.capabilities.find((c) => c.id === "kittyKeyboard")?.supported).toBe(true);
    m.dispose();
  });
});
