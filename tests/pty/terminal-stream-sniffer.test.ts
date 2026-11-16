import { describe, expect, test } from "bun:test";
import { type TerminalStreamEvent, TerminalStreamSniffer } from "@/adapters/pty";

const enc = new TextEncoder();

function sniff(chunks: Array<string | Uint8Array>): {
  events: TerminalStreamEvent[];
  sniffer: TerminalStreamSniffer;
} {
  const events: TerminalStreamEvent[] = [];
  const sniffer = new TerminalStreamSniffer((event) => events.push(event));
  for (const chunk of chunks) sniffer.feed(typeof chunk === "string" ? enc.encode(chunk) : chunk);
  return { events, sniffer };
}

/** Feeds the whole string one byte per chunk: the worst possible split. */
function byteByByte(text: string): Uint8Array[] {
  return [...enc.encode(text)].map((byte) => new Uint8Array([byte]));
}

const types = (events: TerminalStreamEvent[]) => events.map((event) => event.type);

describe("TerminalStreamSniffer", () => {
  test("a bare BEL is a bell; a BEL terminating an OSC is not", () => {
    expect(types(sniff(["text\x07more"]).events)).toEqual(["bell"]);
    expect(types(sniff(["\x1b]0;title\x07"]).events)).toEqual(["title"]);
  });

  test("title via OSC 0 and OSC 2, BEL or ST terminated, split byte by byte", () => {
    const { events, sniffer } = sniff(byteByByte("\x1b]0;first\x07 then \x1b]2;İstanbul ✳ Claude\x1b\\"));
    expect(events).toEqual([
      { type: "title", title: "first" },
      { type: "title", title: "İstanbul ✳ Claude" },
    ]);
    expect(sniffer.title).toBe("İstanbul ✳ Claude");
  });

  test("titles are sanitized and bounded", () => {
    const { sniffer } = sniff([`\x1b]2;a‮b\x01c\n${"x".repeat(1000)}\x07`]);
    expect(sniffer.title).not.toContain("‮");
    expect(sniffer.title.length).toBeLessThanOrEqual(256);
    expect(sniffer.title.startsWith("a�b")).toBe(true);
  });

  test("notifications: OSC 9, OSC 777 notify, chunked kitty OSC 99", () => {
    const { events } = sniff([
      "\x1b]9;Build finished\x07",
      "\x1b]777;notify;Claude Code;Waiting for approval\x1b\\",
      "\x1b]99;i=1:d=0;Need input\x1b\\",
      "\x1b]99;i=1:p=body;Approve the edit?\x1b\\",
      `\x1b]99;e=1;${Buffer.from("base64 title").toString("base64")}\x07`,
    ]);
    expect(events).toEqual([
      { type: "notification", title: null, body: "Build finished", source: "osc9" },
      { type: "notification", title: "Claude Code", body: "Waiting for approval", source: "osc777" },
      { type: "notification", title: "Need input", body: "Approve the edit?", source: "osc99" },
      { type: "notification", title: "base64 title", body: "", source: "osc99" },
    ]);
  });

  test("OSC 9;4 is progress, not a notification; other ConEmu OSC 9 commands are ignored", () => {
    const { events } = sniff(["\x1b]9;4;1;42\x07", "\x1b]9;4;3\x07", "\x1b]9;4;0\x07", "\x1b]9;9;/tmp\x07"]);
    expect(events).toEqual([
      { type: "progress", progress: { state: "normal", value: 42 } },
      { type: "progress", progress: { state: "indeterminate", value: null } },
      { type: "progress", progress: { state: "none", value: null } },
    ]);
  });

  test("OSC 7 reports the working directory", () => {
    const { events } = sniff(["\x1b]7;file://host/Users/dev/My%20Project\x07"]);
    expect(events).toEqual([{ type: "cwd", path: "/Users/dev/My Project" }]);
  });

  test("DEC modes split across chunks, with several parameters per sequence", () => {
    const { events, sniffer } = sniff(["\x1b[?20", "04h\x1b[?1000;1006", "h\x1b[?1049h\x1b[?1h\x1b="]);
    expect(events.filter((event) => event.type === "mode")).toEqual([
      { type: "mode", mode: 2004, enabled: true },
      { type: "mode", mode: 1000, enabled: true },
      { type: "mode", mode: 1006, enabled: true },
      { type: "mode", mode: 1049, enabled: true },
      { type: "mode", mode: 1, enabled: true },
    ]);
    expect(sniffer.modes).toMatchObject({
      bracketedPaste: true,
      mouseTracking: true,
      altScreen: true,
      applicationCursorKeys: true,
      applicationKeypad: true,
    });
    sniffer.feed(enc.encode("\x1b[?2004l\x1b[?1049l"));
    expect(sniffer.modes.bracketedPaste).toBe(false);
    expect(sniffer.modes.altScreen).toBe(false);
  });

  test("kitty keyboard push / pop / set and modifyOtherKeys", () => {
    const { sniffer } = sniff(["\x1b[>1u", "\x1b[>5u", "\x1b[>4;2m"]);
    expect(sniffer.modes.kittyKeyboardFlags).toBe(5);
    expect(sniffer.modes.modifyOtherKeys).toBe(2);
    sniffer.feed(enc.encode("\x1b[<u"));
    expect(sniffer.modes.kittyKeyboardFlags).toBe(1);
    sniffer.feed(enc.encode("\x1b[=8;2u"));
    expect(sniffer.modes.kittyKeyboardFlags).toBe(9);
    sniffer.feed(enc.encode("\x1b[<5u\x1b[?u"));
    expect(sniffer.modes.kittyKeyboardFlags).toBe(0);
  });

  test("RIS resets modes and reports a reset", () => {
    const { events, sniffer } = sniff(["\x1b[?2004h\x1b[>1u", "\x1bc"]);
    expect(types(events).at(-1)).toBe("reset");
    expect(sniffer.modes.bracketedPaste).toBe(false);
    expect(sniffer.modes.kittyKeyboardFlags).toBe(0);
  });

  test("UTF-8 continuation bytes in the C1 range are text, not controls", () => {
    // "ğ" is C4 9F, "Ü" is C3 9C, "ĝ" is C4 9D, and U+009B would be C2 9B: none may open a sequence.
    const { events, sniffer } = sniff(["ğÜĝ\u009b", "\x07"]);
    expect(types(events)).toEqual(["bell"]);
    expect(sniffer.atSequenceBoundary).toBe(true);
  });

  test("BEL inside DCS/APC strings is ignored; CAN aborts a sequence", () => {
    expect(types(sniff(["\x1bPtmux;payload\x07more\x1b\\"]).events)).toEqual([]);
    expect(types(sniff(["\x1b_Gf=100;AAAA\x07\x1b\\"]).events)).toEqual([]);
    expect(types(sniff(["\x1b]0;never\x18\x07"]).events)).toEqual(["bell"]);
  });

  test("ESC inside an OSC aborts it and starts the next sequence", () => {
    const { events } = sniff(["\x1b]0;broken\x1b[?2004h"]);
    expect(events).toEqual([{ type: "mode", mode: 2004, enabled: true }]);
  });

  test("an oversized OSC payload is dropped without growing memory unbounded", () => {
    const { events, sniffer } = sniff([`\x1b]2;${"y".repeat(100_000)}\x07`, "\x07"]);
    expect(types(events)).toEqual(["bell"]);
    expect(sniffer.title).toBe("");
  });

  test("atSequenceBoundary reflects an open sequence", () => {
    const { sniffer } = sniff(["\x1b]2;half"]);
    expect(sniffer.atSequenceBoundary).toBe(false);
    sniffer.feed(enc.encode("\x07"));
    expect(sniffer.atSequenceBoundary).toBe(true);
  });

  test("modePrelude re-creates the tracked modes", () => {
    const { sniffer } = sniff(["\x1b[?1049h\x1b[?2004h\x1b[?1h\x1b[?25l\x1b[>1u\x1b[>4;2m\x1b="]);
    const prelude = sniffer.modePrelude();
    expect(prelude.startsWith("\x1b[?1049h")).toBe(true);
    for (const part of ["\x1b[?2004h", "\x1b[?1h", "\x1b[?25l", "\x1b[>1u", "\x1b[>4;2m", "\x1b="]) {
      expect(prelude).toContain(part);
    }
    expect(new TerminalStreamSniffer().modePrelude()).toBe("");
  });
});
