/**
 * Child process for `react-devtools.test.ts`. Replaces `WebSocket` with a recorder before
 * `@opentui/react` is loaded, imports it (directly or through `importWithoutReactDevTools`), and
 * prints what happened as JSON. Never opens a socket.
 */
import { importWithoutReactDevTools } from "@/core/react-devtools";

const attempts: string[] = [];

class RecordingWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 3;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  constructor(url: string) {
    attempts.push(String(url));
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  send(): void {}
  close(): void {}
}

(globalThis as unknown as { WebSocket: unknown }).WebSocket = RecordingWebSocket;

const mode = process.argv[2];
if (mode === "protected") {
  await importWithoutReactDevTools(() => import("@opentui/react"));
} else {
  await import("@opentui/react");
}
// connectToDevTools may defer its first attempt; give it a moment.
await Bun.sleep(300);
const child = Bun.spawnSync(["/usr/bin/env"], { stdout: "pipe" }).stdout.toString();
console.log(
  JSON.stringify({
    attempts,
    devAfter: process.env.DEV ?? null,
    childSeesDev: child.split("\n").includes("DEV=true"),
  }),
);
process.exit(0);
