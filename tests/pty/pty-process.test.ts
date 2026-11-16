import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { type PtyProcess, spawnPty } from "@/adapters/pty";
import { isLucyError } from "@/core/errors";
import { which } from "@/core/process";
import { collect, killMatching, openFdCount, sleepers, sleepMarker, waitFor } from "./helpers";

const live: PtyProcess[] = [];
const markers: string[] = [];

function start(argv: string[], options: Partial<Parameters<typeof spawnPty>[0]> = {}): PtyProcess {
  const pty = spawnPty({ argv, ...options });
  live.push(pty);
  return pty;
}

afterEach(async () => {
  for (const pty of live.splice(0)) {
    pty.dispose();
    await pty.exited;
  }
  for (const marker of markers.splice(0)) killMatching(marker);
});

afterAll(() => {
  for (const marker of markers) killMatching(marker);
});

describe("spawnPty", () => {
  test("echo output arrives as raw bytes, then a clean exit", async () => {
    const pty = start(["/bin/echo", "hello pty"]);
    const out = collect(pty);
    const info = await pty.exited;
    expect(info).toEqual({ code: 0, signal: null });
    expect(out.chunks.every((chunk) => chunk instanceof Uint8Array)).toBe(true);
    expect(out.text()).toBe("hello pty\r\n");
    expect(pty.isRunning).toBe(false);
    expect(pty.exitInfo).toEqual({ code: 0, signal: null });
  });

  test("reports a non-zero exit code", async () => {
    const pty = start(["/bin/sh", "-c", "exit 7"]);
    expect(await pty.exited).toEqual({ code: 7, signal: null });
  });

  test("reports death by signal with the signal name and a null code", async () => {
    const pty = start(["/bin/sh", "-c", "kill -TERM $$; sleep 5"]);
    expect(await pty.exited).toEqual({ code: null, signal: "SIGTERM" });
  });

  test("delivers every byte before the exit event", async () => {
    const pty = start(["/bin/sh", "-c", "seq 1 20000; printf END"]);
    const order: string[] = [];
    let text = "";
    pty.onData((data) => {
      text += Buffer.from(data).toString("latin1");
      order.push("data");
    });
    pty.onExit(() => order.push(text.endsWith("END") ? "exit-after-END" : "exit-too-early"));
    await pty.exited;
    expect(order.at(-1)).toBe("exit-after-END");
    expect(text).toContain("\r\n20000\r\n");
  });

  test("the child is reaped: no zombie remains", async () => {
    const pty = start(["/bin/sh", "-c", "exit 0"]);
    await pty.exited;
    const result = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pty.pid)], { stdout: "pipe" });
    expect(result.stdout.toString().trim()).toBe("");
  });

  test("resize is observed by the child via stty size, and sizes are clamped to 1x1", async () => {
    const pty = start(["/bin/sh", "-c", "stty size; read a; stty size; read b; stty size"], {
      cols: 100,
      rows: 30,
    });
    const out = collect(pty);
    expect(await waitFor(() => out.text().includes("30 100"))).toBe(true);
    pty.resize(132, 43);
    expect(pty.cols).toBe(132);
    pty.write("\n");
    expect(await waitFor(() => out.text().includes("43 132"))).toBe(true);
    pty.resize(0, -5);
    expect({ cols: pty.cols, rows: pty.rows }).toEqual({ cols: 1, rows: 1 });
    pty.write("\n");
    expect(await waitFor(() => out.text().includes("1 1\r\n"))).toBe(true);
    expect(await pty.exited).toEqual({ code: 0, signal: null });
  });

  test("write/read round trip through cat, including Turkish UTF-8", async () => {
    const pty = start(["/bin/cat"]);
    const out = collect(pty);
    const turkish = "çğıöşü ÇĞİÖŞÜ";
    expect(pty.write(`ping ${turkish}\n`)).toBe(true);
    // Line discipline echo plus cat's own output: the line appears twice.
    expect(await waitFor(() => out.text().split(`ping ${turkish}\r\n`).length === 3)).toBe(true);
    pty.write(new Uint8Array([0x04])); // Ctrl+D: EOF for cat
    expect(await pty.exited).toEqual({ code: 0, signal: null });
  });

  test("Turkish output split across chunks is passed through byte-exact", async () => {
    // printf with octal escapes emits the UTF-8 bytes of "ğİ" one byte at a time.
    const pty = start(
      ["/bin/sh", "-c", "for b in '\\304' '\\237' '\\304' '\\260'; do printf \"$b\"; sleep 0.02; done"],
      {
        coalesce: false,
      },
    );
    const out = collect(pty);
    await pty.exited;
    expect(out.chunks.length).toBeGreaterThan(1);
    expect(out.text()).toBe("ğİ");
  });

  test("environment: TERM, COLORTERM and TERM_PROGRAM are set; overrides apply", async () => {
    const pty = start(["/usr/bin/env"], { env: { LUCY_TEST_VAR: "yes", TMUX: "/tmp/fake,1,0" } });
    const out = collect(pty);
    await pty.exited;
    const lines = out.text().split("\r\n");
    expect(lines).toContain("TERM=xterm-256color");
    expect(lines).toContain("COLORTERM=truecolor");
    expect(lines).toContain("TERM_PROGRAM=lucy");
    expect(lines).toContain("LUCY_TEST_VAR=yes");
    // Explicit overrides win even over identity stripping.
    expect(lines).toContain("TMUX=/tmp/fake,1,0");
    expect(lines.some((line) => line.startsWith("GHOSTTY_"))).toBe(false);
  });

  test("tree kill reaches background and foreground jobs of an interactive zsh", async () => {
    const zsh = which("zsh");
    if (!zsh) return; // zsh is the user's shell on macOS; skip where it is missing.
    const bg = sleepMarker();
    const fg = sleepMarker();
    markers.push(bg, fg);
    const pty = start([zsh, "-f", "-i"], { env: { PS1: "%% " } });
    const out = collect(pty);
    expect(await waitFor(() => out.text().includes("%"))).toBe(true);
    pty.write(`sleep ${bg} &\n`);
    pty.write(`sleep ${fg}\n`);
    expect(await waitFor(() => sleepers(bg).length === 1 && sleepers(fg).length === 1)).toBe(true);
    const info = await pty.kill({ graceMs: 300 });
    expect(info.code === null || info.code !== undefined).toBe(true);
    expect(await waitFor(() => sleepers(bg).length === 0 && sleepers(fg).length === 0, 3000)).toBe(true);
    expect(pty.isRunning).toBe(false);
  });

  test("tree kill escalates to SIGKILL for a grandchild that ignores SIGHUP and SIGTERM", async () => {
    const marker = sleepMarker();
    markers.push(marker);
    const pty = start([
      "/bin/sh",
      "-c",
      `trap '' HUP TERM; sh -c "trap '' HUP TERM; sleep ${marker}" & wait`,
    ]);
    expect(await waitFor(() => sleepers(marker).length === 1)).toBe(true);
    const started = Date.now();
    await pty.kill({ graceMs: 200 });
    expect(await waitFor(() => sleepers(marker).length === 0, 3000)).toBe(true);
    // Two grace periods passed before SIGKILL, so the ladder really escalated.
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  });

  test("a huge output burst is consumed with bounded memory and coalesced chunks", async () => {
    const target = 50 * 1024 * 1024;
    Bun.gc(true);
    const rssBefore = process.memoryUsage().rss;
    let peak = rssBefore;
    let total = 0;
    let deliveries = 0;
    let largest = 0;
    const pty = start(["/bin/sh", "-c", `yes 'lucy burst line 0123456789' | head -c ${target}`], {
      cols: 200,
    });
    pty.onData((data) => {
      total += data.byteLength;
      deliveries++;
      largest = Math.max(largest, data.byteLength);
      if (deliveries % 64 === 0) peak = Math.max(peak, process.memoryUsage().rss);
    });
    expect(await pty.exited).toEqual({ code: 0, signal: null });
    // ONLCR turns each "\n" into "\r\n", so slightly more than the target arrives.
    expect(total).toBeGreaterThanOrEqual(target);
    expect(largest).toBeLessThanOrEqual(256 * 1024 + 64 * 1024);
    expect(deliveries).toBeLessThan(total / 1024);
    expect(peak - rssBefore).toBeLessThan(200 * 1024 * 1024);
  }, 30_000);

  test("dispose is idempotent and kills a running process", async () => {
    const marker = sleepMarker();
    markers.push(marker);
    const pty = start(["/bin/sleep", marker]);
    expect(await waitFor(() => sleepers(marker).length === 1)).toBe(true);
    pty.dispose();
    pty.dispose();
    await pty.exited;
    expect(pty.isRunning).toBe(false);
    expect(pty.write("late")).toBe(false);
    pty.resize(10, 10);
    pty.dispose();
    expect(await waitFor(() => sleepers(marker).length === 0)).toBe(true);
  });

  test("spawn failure throws LucyError SPAWN_FAILED; empty argv is INVALID_ARGUMENT", () => {
    const attempts = [
      () => spawnPty({ argv: ["/nonexistent/lucy-binary"] }),
      () => spawnPty({ argv: ["/bin/echo"], cwd: "/nonexistent/lucy-dir" }),
      () => spawnPty({ argv: ["/etc/hosts"] }),
    ];
    for (const attempt of attempts) {
      let caught: unknown;
      try {
        attempt();
      } catch (error) {
        caught = error;
      }
      expect(isLucyError(caught, "SPAWN_FAILED")).toBe(true);
    }
    let invalid: unknown;
    try {
      spawnPty({ argv: [] });
    } catch (error) {
      invalid = error;
    }
    expect(isLucyError(invalid, "INVALID_ARGUMENT")).toBe(true);
  });

  test("creating and disposing 30 PTYs leaks no file descriptors", async () => {
    // Warm up: Bun lazily opens a few event-loop descriptors on the first spawn.
    const warm = spawnPty({ argv: ["/bin/sh", "-c", "exit 0"] });
    await warm.exited;
    await Bun.sleep(50);
    const before = openFdCount();
    const ptys = Array.from({ length: 30 }, () => spawnPty({ argv: ["/bin/sh", "-c", "sleep 30"] }));
    expect(openFdCount()).toBeGreaterThan(before);
    for (const pty of ptys) pty.dispose();
    await Promise.all(ptys.map((pty) => pty.exited));
    expect(await waitFor(() => openFdCount() <= before, 3000)).toBe(true);
  }, 20_000);
});
