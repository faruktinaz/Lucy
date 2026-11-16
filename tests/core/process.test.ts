import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isLucyError } from "@/core/errors";
import { run, runStreaming, which } from "@/core/process";
import { makeTempDirs, type TempDirs } from "./helpers";

const bun = process.execPath;

let temp: TempDirs;
beforeEach(async () => {
  temp = await makeTempDirs();
});
afterEach(async () => {
  await temp.cleanup();
});

describe("run", () => {
  test("captures stdout, stderr and the exit code", async () => {
    const result = await run([bun, "-e", "console.log('out'); console.error('err'); process.exit(3)"]);
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toBe("err\n");
    expect(result.code).toBe(3);
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.aborted).toBe(false);
  });

  test("passes arguments verbatim: no shell interpretation", async () => {
    const tricky = ["$HOME", "`whoami`", "$(id)", "a b", "x; rm -rf /tmp/nothing", "*", "'quoted'", "ş ğ ü"];
    const result = await run([bun, "-e", "console.log(JSON.stringify(process.argv.slice(1)))", ...tricky]);
    expect(JSON.parse(result.stdout)).toEqual(tricky);
  });

  test("feeds stdin from a string or bytes", async () => {
    expect((await run(["cat"], { stdin: "hello ş" })).stdout).toBe("hello ş");
    expect((await run(["cat"], { stdin: new Uint8Array([104, 105]) })).stdout).toBe("hi");
  });

  test("merges env and removes variables set to undefined", async () => {
    const script = "console.log(JSON.stringify([process.env.LUCY_A, process.env.LUCY_B ?? null]))";
    const result = await run([bun, "-e", script], { env: { LUCY_A: "1", LUCY_B: undefined } });
    expect(JSON.parse(result.stdout)).toEqual(["1", null]);
  });

  test("runs in the given cwd", async () => {
    const result = await run(["pwd"], { cwd: temp.root });
    expect(result.stdout.trim()).toBe(temp.root);
  });

  test("times out and kills the process", async () => {
    const started = performance.now();
    const result = await run(["sleep", "5"], { timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const script = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
    const result = await run([bun, "-e", script], { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
  });

  test("aborts via AbortSignal, also when already aborted", async () => {
    const controller = new AbortController();
    const pending = run(["sleep", "5"], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.code).toBeNull();

    const pre = new AbortController();
    pre.abort();
    expect((await run(["sleep", "5"], { signal: pre.signal })).aborted).toBe(true);
  });

  test("truncates stdout at maxOutputBytes and stops the producer", async () => {
    const result = await run(["yes"], { maxOutputBytes: 1000, timeoutMs: 5000 });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBe(1000);
    expect(result.timedOut).toBe(false);
  });

  test("spawn failure is a SPAWN_FAILED LucyError", async () => {
    const error = await run(["definitely-not-a-binary-lucy"]).catch((e: unknown) => e);
    expect(isLucyError(error, "SPAWN_FAILED")).toBe(true);
  });

  test("invalid argv is rejected before spawning", async () => {
    expect(isLucyError(await run([]).catch((e: unknown) => e), "INVALID_ARGUMENT")).toBe(true);
    expect(isLucyError(await run([""]).catch((e: unknown) => e), "INVALID_ARGUMENT")).toBe(true);
    expect(isLucyError(await run(["echo", "a\0b"]).catch((e: unknown) => e), "INVALID_ARGUMENT")).toBe(true);
  });
});

describe("runStreaming", () => {
  test("splits lines, strips CRLF and flushes a final unterminated line", async () => {
    const lines: string[] = [];
    const handle = runStreaming([bun, "-e", "process.stdout.write('a\\r\\nb\\n\\nc\\r')"], {
      onLine: (line) => lines.push(line),
    });
    const result = await handle.done;
    expect(result.code).toBe(0);
    expect(lines).toEqual(["a", "b", "", "c"]);
  });

  test("a multi-byte character split across chunks is decoded intact", async () => {
    // "ş" is C5 9F; the two bytes arrive in separate writes.
    const script =
      "process.stdout.write(Buffer.from([0x78, 0xc5])); await Bun.sleep(60); process.stdout.write(Buffer.from([0x9f, 0x0a, 0x79]))";
    const lines: string[] = [];
    await runStreaming([bun, "-e", script], { onLine: (line) => lines.push(line) }).done;
    expect(lines).toEqual(["xş", "y"]);
  });

  test("a multi-megabyte single line is cut at maxLineBytes, the rest discarded, and flagged", async () => {
    // 6 MiB without a newline, written in many chunks, then two normal lines.
    const script =
      "const chunk = 'x'.repeat(64 * 1024); for (let i = 0; i < 96; i++) process.stdout.write(chunk); process.stdout.write('TAIL\\nnext\\r\\nlast')";
    const seen: Array<{ length: number; truncated: boolean; head: string }> = [];
    const handle = runStreaming([bun, "-e", script], {
      maxLineBytes: 1024 * 1024,
      onLine: (line, truncated) => seen.push({ length: line.length, truncated, head: line.slice(0, 4) }),
    });
    const result = await handle.done;
    expect(result.code).toBe(0);
    expect(seen).toEqual([
      { length: 1024 * 1024, truncated: true, head: "xxxx" },
      { length: 4, truncated: false, head: "next" },
      { length: 4, truncated: false, head: "last" },
    ]);
  });

  test("the default line limit is 1 MiB and normal lines report truncated = false", async () => {
    const lines: Array<[number, boolean]> = [];
    await runStreaming([bun, "-e", "process.stdout.write('a'.repeat(3 * 1024 * 1024) + '\\nok\\n')"], {
      onLine: (line, truncated) => lines.push([line.length, truncated]),
    }).done;
    expect(lines).toEqual([
      [1024 * 1024, true],
      [2, false],
    ]);
  });

  test("a cut never splits a UTF-8 character", async () => {
    // "ş" is two bytes; a 5-byte limit falls in the middle of the third one.
    const lines: Array<[string, boolean]> = [];
    await runStreaming([bun, "-e", "process.stdout.write('şşşşş\\nşş\\n')"], {
      maxLineBytes: 5,
      onLine: (line, truncated) => lines.push([line, truncated]),
    }).done;
    expect(lines).toEqual([
      ["şş", true],
      ["şş", false],
    ]);
  });

  test("kill() stops a long-running process", async () => {
    const lines: string[] = [];
    const handle = runStreaming([bun, "-e", "setInterval(() => console.log('tick'), 10)"], {
      onLine: (line) => lines.push(line),
    });
    await Bun.sleep(100);
    handle.kill();
    const result = await handle.done;
    expect(result.aborted).toBe(true);
    expect(result.code).toBeNull();
    expect(lines.length).toBeGreaterThan(0);
  });

  test("collects stderr and honors the timeout", async () => {
    const handle = runStreaming([bun, "-e", "console.error('warn'); setInterval(() => {}, 1000)"], {
      onLine: () => {},
      timeoutMs: 150,
    });
    const result = await handle.done;
    expect(result.timedOut).toBe(true);
    expect(result.stderr).toBe("warn\n");
  });

  test("spawn failure throws synchronously as SPAWN_FAILED", () => {
    let error: unknown;
    try {
      runStreaming(["definitely-not-a-binary-lucy"], { onLine: () => {} });
    } catch (e) {
      error = e;
    }
    expect(isLucyError(error, "SPAWN_FAILED")).toBe(true);
  });
});

describe("which", () => {
  test("finds executables on PATH and honors a custom PATH", async () => {
    expect(which("sh")).not.toBeNull();
    expect(which("definitely-not-a-binary-lucy")).toBeNull();
    const tool = join(temp.root, "lucy-tool");
    await writeFile(tool, "#!/bin/sh\n", { mode: 0o755 });
    expect(which("lucy-tool", { PATH: temp.root })).toBe(tool);
    expect(which("lucy-tool", { PATH: "/nonexistent" })).toBeNull();
  });
});
