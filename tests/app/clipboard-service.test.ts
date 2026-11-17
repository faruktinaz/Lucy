/**
 * The clipboard strategy per environment, with fake tools on a temporary PATH: each fake
 * writes its stdin to a file, so the tests see exactly the bytes a real tool would receive.
 * Nothing here touches the real clipboard (the platform tools are never on these PATHs).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClipboardService,
  clipboardTools,
  MemoryClipboardBackend,
  type Osc52Writer,
  SystemClipboardBackend,
} from "@/app/clipboard";

const root = mkdtempSync(join(process.env.LUCY_TEST_ROOT ?? tmpdir(), "clipboard-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const TEXT = "Merhaba dünya: ığüşöç İstanbul 日本語 🙂\nsecond line";

let counter = 0;
/** A PATH directory with fake tools; each records its stdin (and argv) under `out`. */
function fakeTools(tools: Record<string, string>): { path: string; out: string } {
  const dir = join(root, `bin-${counter++}`);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, "out");
  for (const [name, body] of Object.entries(tools)) {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }
  return { path: dir, out };
}

// Absolute paths: PATH holds only the fake tools, so a real clipboard tool can never be found.
const RECORD = '/bin/cat > "$OUT"; echo "$0 $*" > "$OUT.argv"';

function osc52(options: { supported?: boolean; throws?: boolean } = {}): Osc52Writer & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    isOsc52Supported: () => options.supported ?? true,
    copyToClipboardOSC52: (text) => {
      if (options.throws) throw new Error("no terminal");
      sent.push(text);
      return true;
    },
  };
}

function backend(env: Record<string, string>, platform: NodeJS.Platform, writer: Osc52Writer | null = null) {
  return new SystemClipboardBackend({ env, platform, osc52: () => writer, toolTimeoutMs: 2000 });
}

describe("platform strategies", () => {
  test("macOS: pbcopy gets the UTF-8 text on stdin", async () => {
    const bin = fakeTools({ pbcopy: RECORD });
    const writer = osc52();
    const result = await backend({ PATH: bin.path, OUT: bin.out }, "darwin", writer).copy(TEXT);
    expect(result).toEqual({ ok: true, method: "tool", tool: "pbcopy" });
    expect(readFileSync(bin.out, "utf8")).toBe(TEXT);
    expect(writer.sent).toEqual([]);
  });

  test("Linux Wayland: wl-copy comes first", async () => {
    const bin = fakeTools({ "wl-copy": RECORD, xclip: RECORD });
    const env = { PATH: bin.path, OUT: bin.out, WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" };
    const result = await backend(env, "linux").copy(TEXT);
    expect(result).toEqual({ ok: true, method: "tool", tool: "wl-copy" });
    expect(readFileSync(bin.out, "utf8")).toBe(TEXT);
  });

  test("Linux X11: xclip with the clipboard selection, xsel when xclip is missing", async () => {
    const withXclip = fakeTools({ xclip: RECORD, xsel: RECORD });
    const env = { PATH: withXclip.path, OUT: withXclip.out, DISPLAY: ":0" };
    expect(await backend(env, "linux").copy(TEXT)).toEqual({ ok: true, method: "tool", tool: "xclip" });
    expect(readFileSync(`${withXclip.out}.argv`, "utf8")).toContain("-selection clipboard");

    const onlyXsel = fakeTools({ xsel: RECORD });
    const env2 = { PATH: onlyXsel.path, OUT: onlyXsel.out, DISPLAY: ":0" };
    expect(await backend(env2, "linux").copy(TEXT)).toEqual({ ok: true, method: "tool", tool: "xsel" });
    expect(readFileSync(onlyXsel.out, "utf8")).toBe(TEXT);
  });

  test("a tool that leaves a selection daemon holding stdout does not stall the copy", async () => {
    // Real xclip/xsel/wl-copy fork a daemon that inherits stdout. With captured output the
    // copy waited for the timeout and then killed the daemon, losing the text.
    const bin = fakeTools({ xclip: `/bin/cat > "$OUT"; /bin/sleep 5 & echo $! > "$OUT.pid"; exit 0` });
    const started = performance.now();
    const result = await backend({ PATH: bin.path, OUT: bin.out, DISPLAY: ":0" }, "linux").copy(TEXT);
    const elapsed = performance.now() - started;
    const daemon = Number(readFileSync(`${bin.out}.pid`, "utf8").trim());
    try {
      expect(result).toEqual({ ok: true, method: "tool", tool: "xclip" });
      expect(elapsed).toBeLessThan(1500);
    } finally {
      process.kill(daemon, "SIGKILL");
    }
  });

  test("WSL: clip.exe gets UTF-16LE with a byte order mark", async () => {
    const bin = fakeTools({ "clip.exe": RECORD });
    const env = { PATH: bin.path, OUT: bin.out, WSL_DISTRO_NAME: "Ubuntu" };
    expect(await backend(env, "linux").copy(TEXT)).toEqual({ ok: true, method: "tool", tool: "clip.exe" });
    const bytes = readFileSync(bin.out);
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    expect(new TextDecoder("utf-16le").decode(bytes.subarray(2))).toBe(TEXT);
  });

  test("SSH: OSC 52 to the user's terminal, never the remote machine's tool", async () => {
    const bin = fakeTools({ pbcopy: RECORD });
    const writer = osc52();
    const env = { PATH: bin.path, OUT: bin.out, SSH_CONNECTION: "10.0.0.2 50000 10.0.0.3 22" };
    expect(await backend(env, "darwin", writer).copy(TEXT)).toEqual({ ok: true, method: "osc52" });
    expect(writer.sent).toEqual([TEXT]);
    expect(existsSync(bin.out)).toBe(false);
  });

  test("no tool, or a failing tool: OSC 52 is the fallback", async () => {
    const empty = fakeTools({});
    const writer = osc52();
    expect(await backend({ PATH: empty.path, DISPLAY: ":0" }, "linux", writer).copy("a")).toEqual({
      ok: true,
      method: "osc52",
    });
    const failing = fakeTools({ pbcopy: "exit 1" });
    expect(await backend({ PATH: failing.path }, "darwin", writer).copy("b")).toEqual({
      ok: true,
      method: "osc52",
    });
    expect(writer.sent).toEqual(["a", "b"]);
  });

  test("failure is reported with reasons; the test renderer's throwing OSC 52 is contained", async () => {
    const failing = fakeTools({ pbcopy: "exit 3" });
    const result = await backend({ PATH: failing.path }, "darwin", osc52({ throws: true })).copy("x");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("pbcopy exited with code 3");
      expect(result.reason).toContain("OSC 52 failed");
    }
    const unsupported = await backend({ PATH: failing.path }, "linux", osc52({ supported: false })).copy("x");
    expect(unsupported).toEqual({ ok: false, reason: "the terminal does not support OSC 52" });
  });

  test("Linux without a display server does not try X11 or Wayland tools", () => {
    expect(clipboardTools({}, "linux")).toEqual([]);
    expect(clipboardTools({ DISPLAY: ":1" }, "linux").map((tool) => tool.argv[0])).toEqual(["xclip", "xsel"]);
  });
});

describe("ClipboardService", () => {
  test("empty text is not copied; a throwing backend becomes a reported failure", async () => {
    const memory = new MemoryClipboardBackend();
    const service = new ClipboardService(memory);
    expect((await service.copy("")).ok).toBe(false);
    expect(memory.copies).toEqual([]);
    const broken = new ClipboardService({
      copy: async () => {
        throw new Error("boom");
      },
    });
    expect(await broken.copy("x")).toEqual({ ok: false, reason: "boom" });
  });
});
