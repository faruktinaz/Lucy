import { describe, expect, test } from "bun:test";
import { run } from "@/core/process";

/** True while a process with this pid exists. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(20);
  }
  return predicate();
}

// The shell starts a long-running grandchild, prints its pid, then waits on it.
const SPAWN_GRANDCHILD = ["sh", "-c", "sleep 300 & echo $!; wait"];

describe("run({ detached })", () => {
  test("a timeout kills the whole process group, including grandchildren", async () => {
    const result = await run(SPAWN_GRANDCHILD, { detached: true, timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    const grandchild = Number.parseInt(result.stdout.trim(), 10);
    expect(Number.isInteger(grandchild)).toBe(true);
    expect(await waitUntil(() => !isAlive(grandchild), 3000)).toBe(true);
  });

  test("without detached, the grandchild outlives the timeout (documents the difference)", async () => {
    const result = await run(SPAWN_GRANDCHILD, { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    const grandchild = Number.parseInt(result.stdout.trim(), 10);
    try {
      expect(isAlive(grandchild)).toBe(true);
    } finally {
      try {
        process.kill(grandchild, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  test("a detached command has no controlling terminal", async () => {
    // Opening /dev/tty fails with ENXIO for a process without a controlling terminal.
    const result = await run(["sh", "-c", "exec 3</dev/tty && echo has-tty || echo no-tty"], {
      detached: true,
    });
    expect(result.stdout.trim()).toBe("no-tty");
  });

  test("a detached command still returns output, exit code and stdin normally", async () => {
    const result = await run(["sh", "-c", "cat; exit 3"], { detached: true, stdin: "çalışma" });
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("çalışma");
    expect(result.timedOut).toBe(false);
  });
});
