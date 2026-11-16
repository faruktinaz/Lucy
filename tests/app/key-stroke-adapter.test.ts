/**
 * The key-event adapter against REAL parsed events: raw terminal bytes go through OpenTUI's
 * input parser (legacy and kitty modes), and the resulting `KeyEvent` is converted and then
 * resolved by the default keybinding table.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { toKeyStroke } from "@/app/input/key-stroke-adapter";
import { DEFAULT_KEYBINDINGS, KeybindingRegistry, type ResolveResult } from "@/core/keybindings";
import type { KeyStroke } from "@/core/keybindings/key-stroke";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Parser {
  setup: TestRendererSetup;
  presses: KeyEvent[];
  releases: KeyEvent[];
}

async function createParser(kittyKeyboard: boolean): Promise<Parser> {
  const setup = await createTestRenderer({ width: 20, height: 4, kittyKeyboard });
  const parser: Parser = { setup, presses: [], releases: [] };
  setup.renderer.keyInput.on("keypress", (event) => parser.presses.push(event));
  setup.renderer.keyInput.on("keyrelease", (event) => parser.releases.push(event));
  return parser;
}

/** Feeds raw bytes and returns the single key press they produced. */
async function press(parser: Parser, bytes: string): Promise<KeyEvent> {
  parser.presses.length = 0;
  parser.setup.renderer.stdin.emit("data", Buffer.from(bytes));
  // A lone ESC is held about 20 ms by the legacy parser; everything else is immediate.
  await sleep(bytes === "\x1b" ? 40 : 5);
  expect(parser.presses).toHaveLength(1);
  const event = parser.presses[0];
  if (!event) throw new Error(`No key event for ${JSON.stringify(bytes)}`);
  return event;
}

async function stroke(parser: Parser, bytes: string): Promise<KeyStroke | null> {
  return toKeyStroke(await press(parser, bytes));
}

const registry = new KeybindingRegistry({ defaults: DEFAULT_KEYBINDINGS });

function resolve(value: KeyStroke | null, context: Record<string, unknown> = {}): string {
  if (!value) return "null";
  const result: ResolveResult = registry.resolve(value, context);
  registry.cancelPending();
  return result.kind === "command" ? result.command : result.kind;
}

/** The meaningful fields of a stroke, so `undefined` optionals do not clutter expectations. */
function compact(value: KeyStroke | null): Record<string, unknown> | null {
  if (!value) return null;
  const out: Record<string, unknown> = { key: value.key };
  for (const flag of ["ctrl", "alt", "shift", "super"] as const) if (value[flag]) out[flag] = true;
  if (value.text !== undefined) out.text = value.text;
  if (value.baseKey !== undefined) out.baseKey = value.baseKey;
  return out;
}

describe("legacy terminal input", () => {
  let parser: Parser;
  beforeAll(async () => {
    parser = await createParser(false);
  });
  afterAll(() => {
    parser.setup.renderer.destroy();
  });

  test("ctrl+p: a control byte, and ctrl+shift+p cannot be told apart", async () => {
    const value = await stroke(parser, "\x10");
    expect(compact(value)).toEqual({ key: "p", ctrl: true });
    expect(resolve(value)).toBe("file.quickOpen");
  });

  test("alt+x arrives as an ESC prefix", async () => {
    const value = await stroke(parser, "\x1bx");
    expect(compact(value)).toEqual({ key: "x", alt: true });
  });

  test("Shift+letter is the uppercase character", async () => {
    const value = await stroke(parser, "A");
    expect(compact(value)).toEqual({ key: "A", shift: true, text: "A" });
  });

  test("Turkish letters are plain text", async () => {
    expect(compact(await stroke(parser, "ş"))).toEqual({ key: "ş", text: "ş" });
    expect(compact(await stroke(parser, "İ"))).toEqual({ key: "İ", text: "İ" });
    expect(compact(await stroke(parser, "ğ"))).toEqual({ key: "ğ", text: "ğ" });
    // Typing never triggers a binding while an input has focus.
    expect(resolve(await stroke(parser, "ş"), { inputFocus: true })).toBe("none");
  });

  test("Enter and Shift+Enter are the same byte", async () => {
    expect(compact(await stroke(parser, "\r"))).toEqual({ key: "enter" });
  });

  test("function keys", async () => {
    const f1 = await stroke(parser, "\x1bOP");
    expect(compact(f1)).toEqual({ key: "f1" });
    expect(resolve(f1)).toBe("palette.show");
    expect(resolve(f1, { terminalFocus: true })).toBe("palette.show");
    expect(compact(await stroke(parser, "\x1b[15~"))).toEqual({ key: "f5" });
    const shiftF6 = await stroke(parser, "\x1b[17;2~");
    expect(compact(shiftF6)).toEqual({ key: "f6", shift: true });
    expect(resolve(shiftF6, { terminalFocus: true })).toBe("view.focusPreviousPart");
  });

  test("the Ctrl+\\ leader", async () => {
    const leader = await stroke(parser, "\x1c");
    expect(compact(leader)).toEqual({ key: "\\", ctrl: true });
    expect(resolve(leader, { terminalFocus: true })).toBe("pending");
  });

  test("named keys and a lone Escape", async () => {
    expect(compact(await stroke(parser, "\t"))).toEqual({ key: "tab" });
    expect(compact(await stroke(parser, "\x1b[Z"))).toEqual({ key: "tab", shift: true });
    expect(compact(await stroke(parser, "\x7f"))).toEqual({ key: "backspace" });
    expect(compact(await stroke(parser, "\x1b[6;5~"))).toEqual({ key: "pagedown", ctrl: true });
    expect(compact(await stroke(parser, " "))).toEqual({ key: "space" });
    expect(compact(await stroke(parser, "\x1b"))).toEqual({ key: "escape" });
  });

  test("application-keypad digits", async () => {
    expect(compact(await stroke(parser, "\x1bOq"))).toEqual({ key: "1", text: "1" });
  });
});

describe("kitty keyboard protocol input", () => {
  let parser: Parser;
  beforeAll(async () => {
    parser = await createParser(true);
  });
  afterAll(() => {
    parser.setup.renderer.destroy();
  });

  test("ctrl+p and ctrl+shift+p are different chords", async () => {
    const plain = await stroke(parser, "\x1b[112;5u");
    expect(compact(plain)).toEqual({ key: "p", ctrl: true, text: "p" });
    expect(resolve(plain)).toBe("file.quickOpen");
    const shifted = await stroke(parser, "\x1b[112:80;6u");
    expect(compact(shifted)).toEqual({ key: "P", ctrl: true, shift: true, text: "P" });
    expect(resolve(shifted)).toBe("palette.show");
    // A kitty-only chord is a global escape hatch from the terminal.
    expect(resolve(shifted, { terminalFocus: true })).toBe("palette.show");
    expect(resolve(plain, { terminalFocus: true })).toBe("none");
  });

  test("ctrl+1 keeps its modifier", async () => {
    expect(compact(await stroke(parser, "\x1b[49;5u"))).toEqual({ key: "1", ctrl: true, text: "1" });
  });

  test("numpad digits map to digits", async () => {
    expect(compact(await stroke(parser, "\x1b[57400u"))).toEqual({ key: "1", text: "1" });
  });

  test("alt+x reports meta and option, which both mean alt", async () => {
    expect(compact(await stroke(parser, "\x1b[120;3u"))).toEqual({ key: "x", alt: true, text: "x" });
  });

  test("shift+enter is distinguishable", async () => {
    expect(compact(await stroke(parser, "\x1b[13;2u"))).toEqual({ key: "enter", shift: true });
    expect(compact(await stroke(parser, "\x1b[13;5u"))).toEqual({ key: "enter", ctrl: true });
  });

  test("shifted punctuation reports the produced character", async () => {
    const question = await stroke(parser, "\x1b[47:63;2u");
    expect(compact(question)).toEqual({ key: "?", shift: true, text: "?" });
  });

  test("ctrl+ş and Turkish plain text", async () => {
    expect(compact(await stroke(parser, "\x1b[351;5u"))).toEqual({ key: "ş", ctrl: true, text: "ş" });
    expect(compact(await stroke(parser, "ğ"))).toEqual({ key: "ğ", text: "ğ" });
  });

  test("the Ctrl+\\ leader, with its base-layout key", async () => {
    const leader = await stroke(parser, "\x1b[92;5u");
    expect(compact(leader)).toEqual({ key: "\\", ctrl: true, text: "\\" });
    expect(resolve(leader, { terminalFocus: true })).toBe("pending");
    const withBase = await stroke(parser, "\x1b[92::92;5u");
    expect(compact(withBase)).toEqual({ key: "\\", ctrl: true, text: "\\", baseKey: "\\" });
  });

  test("Escape is immediate", async () => {
    expect(compact(await stroke(parser, "\x1b[27u"))).toEqual({ key: "escape" });
  });

  test("key releases are not strokes", async () => {
    parser.releases.length = 0;
    parser.setup.renderer.stdin.emit("data", Buffer.from("\x1b[112;5:3u"));
    await sleep(5);
    const release = parser.releases[0];
    if (release) expect(toKeyStroke(release)).toBeNull();
    // Whether or not the parser reports it, a release-typed event never becomes a stroke.
    expect(
      toKeyStroke({
        name: "p",
        ctrl: true,
        meta: false,
        option: false,
        shift: false,
        super: false,
        sequence: "p",
        eventType: "release",
        baseCode: undefined,
      }),
    ).toBeNull();
  });
});

describe("toKeyStroke edge cases", () => {
  const base = {
    ctrl: false,
    meta: false,
    option: false,
    shift: false,
    super: false,
    eventType: "press" as const,
    baseCode: undefined,
  };

  test("modifier-only and unknown functional keys are not bindable", () => {
    expect(toKeyStroke({ ...base, name: "leftshift", sequence: "" })).toBeNull();
    expect(toKeyStroke({ ...base, name: "mediaplay", sequence: "\x1b[57428u" })).toBeNull();
    expect(toKeyStroke({ ...base, name: "", sequence: "" })).toBeNull();
  });

  test("super is passed through", () => {
    expect(compact(toKeyStroke({ ...base, name: "s", sequence: "s", super: true }))).toEqual({
      key: "s",
      super: true,
      text: "s",
    });
  });

  test("keypad names map to their canonical keys", () => {
    expect(compact(toKeyStroke({ ...base, name: "kpenter", sequence: "\r" }))).toEqual({ key: "enter" });
    expect(compact(toKeyStroke({ ...base, name: "kpup", sequence: "" }))).toEqual({ key: "up" });
  });
});
