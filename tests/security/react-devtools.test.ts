/**
 * Item: `@opentui/react` must never try to reach React DevTools (`ws://localhost:8097`).
 *
 * The check runs once, when the module is evaluated (see `src/core/react-devtools.ts`), so every
 * case runs in a fresh child process with `DEV=true`. The child replaces `WebSocket` with a
 * recorder: no socket is ever opened, and the control case proves the recorder sees the attempt.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { run } from "@/core/process";

setDefaultTimeout(30_000);

const CHILD = join(import.meta.dir, "fixtures", "devtools-child.ts");

interface ChildReport {
  attempts: string[];
  devAfter: string | null;
  childSeesDev: boolean;
}

async function runChild(mode: "direct" | "protected"): Promise<ChildReport> {
  const result = await run([process.execPath, "run", CHILD, mode], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { DEV: "true" },
    timeoutMs: 20_000,
  });
  expect(result.code).toBe(0);
  const last = result.stdout.trim().split("\n").pop() ?? "";
  return JSON.parse(last) as ChildReport;
}

describe("React DevTools connection", () => {
  test("control: importing @opentui/react with DEV=true tries ws://localhost:8097", async () => {
    const report = await runChild("direct");
    expect(report.attempts).toEqual(["ws://localhost:8097"]);
  });

  test("importWithoutReactDevTools: no attempt, and DEV=true is restored for child processes", async () => {
    const report = await runChild("protected");
    expect(report.attempts).toEqual([]);
    expect(report.devAfter).toBe("true");
    expect(report.childSeesDev).toBe(true);
  });

  test('a DEV value other than "true" is left untouched during the import', async () => {
    const { importWithoutReactDevTools } = await import("@/core/react-devtools");
    const saved = process.env.DEV;
    try {
      process.env.DEV = "1";
      let seen: string | undefined;
      await importWithoutReactDevTools(async () => {
        seen = process.env.DEV;
      });
      expect(seen).toBe("1");
      process.env.DEV = "true";
      await importWithoutReactDevTools(async () => {
        seen = process.env.DEV;
      });
      expect(seen).toBeUndefined();
      expect(process.env.DEV).toBe("true");
      // Restored also when the import fails.
      await importWithoutReactDevTools(() => Promise.reject(new Error("boom"))).catch(() => {});
      expect(process.env.DEV).toBe("true");
    } finally {
      if (saved === undefined) delete process.env.DEV;
      else process.env.DEV = saved;
    }
  });
});
