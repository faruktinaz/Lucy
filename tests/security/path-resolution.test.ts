/**
 * Item: executables planted in the opened folder are never found through a relative PATH entry.
 *
 * Every test builds a temp directory holding fake `git` and `ps` scripts that create a marker
 * file, puts "." (and other relative entries) first on PATH, and makes that directory the
 * process working directory (Bun resolves relative PATH entries against it, not against the
 * `cwd` option), exactly the situation of `lucy .` in an untrusted repository.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProcessesSync } from "@/adapters/pty/process-tree";
import { spawnPty } from "@/adapters/pty/pty-process";
import { isLucyError } from "@/core/errors";
import { absolutePathEntries, resolveCommand, run, runStreaming, which } from "@/core/process";

let dir: string;
let markers: string;

async function plant(name: string): Promise<void> {
  await writeFile(join(dir, name), `#!/bin/sh\ntouch "${markers}/${name}"\necho planted\n`, { mode: 0o755 });
  await mkdir(join(dir, "bin"), { recursive: true });
  await writeFile(join(dir, "bin", name), `#!/bin/sh\ntouch "${markers}/bin-${name}"\n`, { mode: 0o755 });
}

/** A PATH that lists relative and empty entries before the real one. */
function hostilePath(): string {
  return [".", "bin", "", "./bin", "~/bin", process.env.PATH ?? "/usr/bin:/bin"].join(":");
}

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "lucy-path-")));
  markers = join(dir, ".markers");
  await mkdir(markers);
  for (const name of ["git", "ps", "lucy-only-here"]) await plant(name);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Runs `fn` with the planted directory as the process working directory. */
async function inWorkspace<T>(fn: () => T | Promise<T>): Promise<T> {
  const saved = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(saved);
  }
}

describe("PATH lookup ignores relative entries", () => {
  test("sanity: Bun itself would run the planted git from a '.' PATH entry", async () => {
    const result = await inWorkspace(() =>
      Bun.spawnSync(["git", "--version"], { cwd: dir, env: { PATH: hostilePath() } }),
    );
    expect(result.stdout.toString()).toContain("planted");
    expect(await Bun.file(join(markers, "git")).exists()).toBe(true);
  });

  test("absolutePathEntries keeps only absolute directories", () => {
    expect(absolutePathEntries(".:bin::/usr/bin:./x:~/bin:/bin:")).toEqual(["/usr/bin", "/bin"]);
    expect(absolutePathEntries(undefined)).toEqual(["/usr/bin", "/bin"]);
  });

  test("which() and resolveCommand() never return a workspace binary", async () => {
    await inWorkspace(() => assertLookups());
  });

  function assertLookups(): void {
    const path = hostilePath();
    const git = which("git", { PATH: path });
    expect(git).not.toBeNull();
    expect(git?.startsWith("/")).toBe(true);
    expect(git?.startsWith(dir)).toBe(false);
    expect(which("lucy-only-here", { PATH: path })).toBeNull();
    expect(which("lucy-only-here", { PATH: "." })).toBeNull();
    expect(resolveCommand("lucy-only-here", { PATH: path })).toBeNull();
    // An explicit path (containing a slash) is used as given, not looked up.
    expect(resolveCommand("./lucy-only-here", { PATH: path })).toBe("./lucy-only-here");
  }

  test("run(): a bare name resolves through absolute PATH entries only; the marker never appears", async () => {
    const result = await inWorkspace(() =>
      run(["git", "--version"], { cwd: dir, env: { PATH: hostilePath() } }),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toStartWith("git version");
    const missing = await inWorkspace(() =>
      run(["lucy-only-here"], { cwd: dir, env: { PATH: hostilePath() } }).catch((error: unknown) => error),
    );
    expect(isLucyError(missing, "SPAWN_FAILED")).toBe(true);
    expect(await readdir(markers)).toEqual([]);
  });

  test("runStreaming(): same resolution", async () => {
    const lines: string[] = [];
    await inWorkspace(async () => {
      const handle = runStreaming(["git", "--version"], {
        cwd: dir,
        env: { PATH: hostilePath() },
        onLine: (line) => lines.push(line),
      });
      await handle.done;
    });
    expect(lines[0]).toStartWith("git version");
    const error = await inWorkspace(() => {
      try {
        runStreaming(["lucy-only-here"], { cwd: dir, env: { PATH: "." }, onLine: () => {} });
        return null;
      } catch (e) {
        return e;
      }
    });
    expect(isLucyError(error, "SPAWN_FAILED")).toBe(true);
    expect(await readdir(markers)).toEqual([]);
  });

  test("PTY sessions resolve argv[0] the same way", async () => {
    const chunks: Uint8Array[] = [];
    await inWorkspace(async () => {
      const pty = spawnPty({ argv: ["git", "--version"], cwd: dir, env: { PATH: hostilePath() } });
      pty.onData((data) => chunks.push(data));
      await pty.exited;
      pty.dispose();
    });
    expect(Buffer.concat(chunks).toString()).toContain("git version");
    const error = await inWorkspace(() => {
      try {
        spawnPty({ argv: ["lucy-only-here"], cwd: dir, env: { PATH: hostilePath() } });
        return null;
      } catch (e) {
        return e;
      }
    });
    expect(isLucyError(error, "SPAWN_FAILED")).toBe(true);
    expect(await readdir(markers)).toEqual([]);
  });

  test("the synchronous process listing (exit handlers) does not run a planted ps", async () => {
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = hostilePath();
      const table = await inWorkspace(() => listProcessesSync());
      expect(table).not.toBeNull();
      expect(table?.some((entry) => entry.pid === process.pid)).toBe(true);
    } finally {
      process.env.PATH = savedPath;
    }
    expect(await readdir(markers)).toEqual([]);
  });
});
