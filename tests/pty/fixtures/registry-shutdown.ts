/**
 * Child process for pty-registry.test.ts: starts PTY trees through a registry with shutdown hooks,
 * prints "ready", then either exits normally (`exit`) or waits for a signal (`signal`).
 * Usage: bun registry-shutdown.ts <exit|signal> <marker...>
 */
import { installPtyShutdownHooks, PtyRegistry } from "@/adapters/pty";

const [mode, ...markers] = process.argv.slice(2);
const registry = new PtyRegistry();
installPtyShutdownHooks(registry, { graceMs: 100 });

for (const marker of markers) {
  // A grandchild that ignores SIGHUP and SIGTERM: only the escalation reaches it.
  registry.spawn({ argv: ["/bin/sh", "-c", `trap '' HUP TERM; sleep ${marker} & wait`] });
}

// Wait until every grandchild is visible before announcing readiness.
const deadline = Date.now() + 5000;
while (Date.now() < deadline) {
  const ps = Bun.spawnSync(["ps", "-A", "-o", "command="], { stdout: "pipe" }).stdout.toString();
  if (markers.every((marker) => ps.includes(`sleep ${marker}`))) break;
  await Bun.sleep(20);
}
process.stdout.write("ready\n");

if (mode === "exit") {
  process.exit(0);
} else {
  setInterval(() => {}, 1000);
}
