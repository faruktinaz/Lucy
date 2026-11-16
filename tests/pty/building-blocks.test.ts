import { describe, expect, test } from "bun:test";
import {
  ByteRingBuffer,
  buildPtyEnv,
  clampTerminalSize,
  OutputCoalescer,
  parsePsTable,
  selectSessionTree,
} from "@/adapters/pty";
import { waitFor } from "./helpers";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

describe("ByteRingBuffer", () => {
  test("keeps the most recent bytes and reports evictions in stream order", () => {
    const ring = new ByteRingBuffer(8);
    const evicted: string[] = [];
    ring.push(bytes("abcde"));
    ring.push(bytes("fgh"));
    expect(text(ring.toBytes())).toBe("abcdefgh");
    ring.push(bytes("ijk"), (chunk) => evicted.push(text(chunk)));
    expect(text(ring.toBytes())).toBe("defghijk");
    expect(evicted.join("")).toBe("abc");
    ring.push(bytes("lmnop"), (chunk) => evicted.push(text(chunk)));
    expect(text(ring.toBytes())).toBe("ijklmnop");
    expect(evicted.join("")).toBe("abcdefgh");
    expect(ring.droppedBytes).toBe(8);
  });

  test("a chunk larger than the capacity keeps only its tail", () => {
    const ring = new ByteRingBuffer(4);
    const evicted: string[] = [];
    ring.push(bytes("xy"));
    ring.push(bytes("0123456789"), (chunk) => evicted.push(text(chunk)));
    expect(text(ring.toBytes())).toBe("6789");
    expect(evicted.join("")).toBe("xy012345");
    ring.clear();
    expect(ring.size).toBe(0);
    expect(ring.droppedBytes).toBe(0);
  });
});

describe("OutputCoalescer", () => {
  test("batches chunks until the next timer tick and flushes early at maxBytes", async () => {
    const out: string[] = [];
    const coalescer = new OutputCoalescer((data) => out.push(text(data)), { maxBytes: 6 });
    coalescer.push(bytes("ab"));
    coalescer.push(bytes("cd"));
    expect(out).toEqual([]);
    expect(await waitFor(() => out.length === 1)).toBe(true);
    expect(out).toEqual(["abcd"]);
    coalescer.push(bytes("1234"));
    coalescer.push(bytes("56"));
    expect(out).toEqual(["abcd", "123456"]);
    coalescer.push(bytes("z"));
    coalescer.dispose();
    await Bun.sleep(5);
    expect(out).toEqual(["abcd", "123456"]);
  });
});

describe("clampTerminalSize", () => {
  test("never below 1x1, never above the winsize range, fallback for non-finite", () => {
    expect(clampTerminalSize(0, -3)).toEqual({ cols: 1, rows: 1 });
    expect(clampTerminalSize(80.7, 24.2)).toEqual({ cols: 80, rows: 24 });
    expect(clampTerminalSize(1e9, 70_000)).toEqual({ cols: 65_535, rows: 65_535 });
    expect(clampTerminalSize(Number.NaN, undefined, { cols: 5, rows: 6 })).toEqual({ cols: 5, rows: 6 });
  });
});

describe("buildPtyEnv", () => {
  test("keeps the user's environment, removes outer-terminal identity, sets capabilities", () => {
    const env = buildPtyEnv({
      base: {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "kept",
        CMUX_SURFACE_ID: "kept",
        TERM: "xterm-ghostty",
        TERM_PROGRAM: "ghostty",
        TERM_PROGRAM_VERSION: "1.3",
        GHOSTTY_RESOURCES_DIR: "/x",
        ITERM_SESSION_ID: "w0",
        KITTY_WINDOW_ID: "1",
        TMUX: "/tmp/tmux",
        COLUMNS: "80",
        LINES: "24",
        UNSET: undefined,
      },
      termProgram: { name: "lucy", version: "0.1.0" },
      overrides: { EXTRA: "1", PATH: undefined },
    });
    expect(env).toEqual({
      ANTHROPIC_API_KEY: "kept",
      CMUX_SURFACE_ID: "kept",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "lucy",
      TERM_PROGRAM_VERSION: "0.1.0",
      EXTRA: "1",
    });
  });

  test("termProgram null leaves TERM_PROGRAM unset", () => {
    expect(buildPtyEnv({ base: { TERM_PROGRAM: "vscode" }, termProgram: null }).TERM_PROGRAM).toBeUndefined();
  });
});

describe("process tree selection", () => {
  test("parses macOS and Linux ps output", () => {
    expect(parsePsTable("  10     1    10 Ss   ttys006\n  11    10    11 S+   ??\nbogus\n", false)).toEqual([
      { pid: 10, ppid: 1, pgid: 10, sid: null, state: "Ss", tty: "ttys006" },
      { pid: 11, ppid: 10, pgid: 11, sid: null, state: "S+", tty: null },
    ]);
    expect(parsePsTable("20 1 20 20 Ss pts/3\n21 20 21 20 Z ?\n", true)).toEqual([
      { pid: 20, ppid: 1, pgid: 20, sid: 20, state: "Ss", tty: "pts/3" },
      { pid: 21, ppid: 20, pgid: 21, sid: 20, state: "Z", tty: null },
    ]);
  });

  test("selects tty members, the session and all descendants, never Lucy itself", () => {
    const table = parsePsTable(
      [
        "1 0 1 Ss ??", // launchd/init: never selected
        "500 1 500 Ss ttys001", // Lucy
        "600 500 600 Ss ttys009", // PTY root (zsh)
        "601 600 601 S+ ttys009", // foreground job
        "602 600 602 SN ttys009", // background job
        "603 602 603 Ss ??", // descendant that called setsid
        "700 1 700 Ss ttys009", // orphaned job still on the tty
        "800 1 800 Ss ttys010", // another terminal
      ].join("\n"),
      false,
    );
    const tree = selectSessionTree(table, 600, null, 500);
    expect(tree.pids).toEqual([600, 601, 602, 603, 700]);
    expect(tree.pgids.sort()).toEqual([600, 601, 602, 603, 700]);
    expect(tree.tty).toBe("ttys009");
  });

  test("on Linux, the session id finds members after the root died", () => {
    // Root 900 is gone; 901 still belongs to its session (sid 900) but lost the tty.
    const table = parsePsTable("901 1 901 900 S ?\n500 1 500 500 S pts/1\n", true);
    const tree = selectSessionTree(table, 900, null, 500);
    expect(tree.pids).toEqual([901]);
    expect(tree.pgids).toEqual([901]);
  });
});
