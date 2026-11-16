import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PtyRegistry } from "@/adapters/pty";
import { killMatching, sleepers, sleepMarker, waitFor } from "./helpers";

const markers: string[] = [];

afterEach(() => {
  for (const marker of markers.splice(0)) killMatching(marker);
});

function newMarker(): string {
  const marker = sleepMarker();
  markers.push(marker);
  return marker;
}

async function runFixture(
  mode: "exit" | "signal",
  treeMarkers: string[],
): Promise<{ code: number | null; signal: string | null }> {
  const child = Bun.spawn(
    ["bun", join(import.meta.dir, "fixtures", "registry-shutdown.ts"), mode, ...treeMarkers],
    {
      cwd: join(import.meta.dir, "..", ".."),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const reader = child.stdout.getReader();
  let output = "";
  while (!output.includes("ready")) {
    const { value, done } = await reader.read();
    if (done) break;
    output += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  expect(output).toContain("ready");
  for (const marker of treeMarkers) expect(sleepers(marker).length).toBe(1);
  if (mode === "signal") child.kill("SIGTERM");
  const code = await child.exited;
  return { code: child.signalCode ? null : code, signal: child.signalCode ? String(child.signalCode) : null };
}

describe("PtyRegistry", () => {
  test("tracks live PTYs and forgets them when they exit", async () => {
    const registry = new PtyRegistry();
    const quick = registry.spawn({ argv: ["/bin/sh", "-c", "exit 0"] });
    const slow = registry.spawn({ argv: ["/bin/sleep", newMarker()] });
    expect(registry.size).toBe(2);
    await quick.exited;
    expect(await waitFor(() => registry.size === 1)).toBe(true);
    expect(registry.list()).toEqual([slow]);
    registry.disposeAll();
    expect(registry.size).toBe(0);
  });

  test("disposeAll() synchronously kills every tree, including HUP/TERM-ignoring grandchildren", () => {
    const registry = new PtyRegistry();
    const a = newMarker();
    const b = newMarker();
    registry.spawn({ argv: ["/bin/sh", "-c", `trap '' HUP TERM; sleep ${a} & wait`] });
    registry.spawn({ argv: ["/bin/sh", "-c", `sleep ${b}`] });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (sleepers(a).length === 0 || sleepers(b).length === 0)) Bun.sleepSync(20);
    expect(sleepers(a).length).toBe(1);
    expect(sleepers(b).length).toBe(1);
    // No await anywhere: this is what an exit handler can do.
    registry.disposeAll({ graceMs: 100 });
    expect(sleepers(a).length).toBe(0);
    expect(sleepers(b).length).toBe(0);
    registry.disposeAll();
  });

  test("shutdown() kills all trees without blocking the event loop", async () => {
    const registry = new PtyRegistry();
    const marker = newMarker();
    registry.spawn({ argv: ["/bin/sh", "-c", `sleep ${marker}`] });
    expect(await waitFor(() => sleepers(marker).length === 1)).toBe(true);
    await registry.shutdown({ graceMs: 100 });
    expect(await waitFor(() => sleepers(marker).length === 0, 2000)).toBe(true);
    expect(registry.size).toBe(0);
  });

  test("exit hook: process.exit() leaves no orphaned processes", async () => {
    const treeMarkers = [newMarker(), newMarker()];
    const result = await runFixture("exit", treeMarkers);
    expect(result).toEqual({ code: 0, signal: null });
    for (const marker of treeMarkers)
      expect(await waitFor(() => sleepers(marker).length === 0, 2000)).toBe(true);
  }, 20_000);

  test("signal hook: SIGTERM cleans up and exits with 143", async () => {
    const treeMarkers = [newMarker()];
    const result = await runFixture("signal", treeMarkers);
    expect(result).toEqual({ code: 143, signal: null });
    for (const marker of treeMarkers)
      expect(await waitFor(() => sleepers(marker).length === 0, 2000)).toBe(true);
  }, 20_000);
});
