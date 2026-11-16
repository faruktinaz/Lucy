/**
 * The canonical rule for shifted printable characters, from key-stroke.ts:
 * letters match case-insensitively with explicit shift; punctuation bindings written as the
 * character match whatever produced it; `shift+<base>` bindings need the reported base key.
 */
import { describe, expect, test } from "bun:test";
import { chordToString } from "@/core/keybindings/chord";
import { isTypingStroke, type KeyStroke, keyStroke, strokeCandidates } from "@/core/keybindings/key-stroke";

const candidates = (stroke: KeyStroke, mode: "character" | "physical" = "character") =>
  strokeCandidates(stroke, mode).map(chordToString);

describe("letters", () => {
  test("legacy uppercase and kitty base+shift both mean shift+letter", () => {
    expect(candidates(keyStroke("A"))).toEqual(["shift+a"]);
    expect(candidates(keyStroke("A", { shift: true }))).toEqual(["shift+a"]);
    expect(candidates(keyStroke("a", { shift: true }))).toEqual(["shift+a"]);
    expect(candidates(keyStroke("a"))).toEqual(["a"]);
  });

  test("ctrl+letter keeps modifiers in canonical order", () => {
    expect(candidates(keyStroke("p", { ctrl: true, shift: true }))).toEqual(["ctrl+shift+p"]);
    expect(candidates(keyStroke("b", { alt: true, ctrl: true }))).toEqual(["ctrl+alt+b"]);
  });

  test("Turkish letters", () => {
    expect(candidates(keyStroke("ş"))).toEqual(["ş"]);
    expect(candidates(keyStroke("Ş"))).toEqual(["shift+ş"]);
    expect(candidates(keyStroke("ğ", { ctrl: true }))).toEqual(["ctrl+ğ"]);
    expect(candidates(keyStroke("ı"))).toEqual(["ı"]);
    // Shift+i on a Turkish layout types İ.
    expect(candidates(keyStroke("İ"))).toEqual(["shift+i"]);
    // I is Shift+i on US layouts and Shift+ı on Turkish ones: both readings, US first.
    expect(candidates(keyStroke("I"))).toEqual(["shift+i", "shift+ı"]);
  });

  test("text, when reported, is the produced character", () => {
    expect(candidates(keyStroke("s", { shift: true, text: "Ş" }))).toEqual(["shift+ş"]);
  });
});

describe("shifted punctuation", () => {
  test("legacy: only the produced character arrives", () => {
    expect(candidates(keyStroke("?"))).toEqual(["?"]);
  });

  test("legacy parsers that also set shift still match the character", () => {
    expect(candidates(keyStroke("?", { shift: true }))).toEqual(["shift+?", "?"]);
  });

  test("kitty with text and base key: both ? and shift+/ match", () => {
    const stroke = keyStroke("?", { shift: true, text: "?", baseKey: "/" });
    expect(candidates(stroke)).toEqual(["?", "shift+/"]);
  });

  test("Option+Q on a Turkish Q layout without Option-as-Alt types @", () => {
    expect(candidates(keyStroke("@"))).toEqual(["@"]);
  });

  test("the plus key is a character, not a named key", () => {
    expect(candidates(keyStroke("+", { shift: true, text: "+" }))).toEqual(["plus"]);
    expect(candidates(keyStroke("+", { ctrl: true }))).toEqual(["ctrl+plus"]);
  });
});

describe("named keys", () => {
  test("keep shift and accept aliases", () => {
    expect(candidates(keyStroke("tab", { shift: true }))).toEqual(["shift+tab"]);
    expect(candidates(keyStroke("return", { ctrl: true }))).toEqual(["ctrl+enter"]);
    expect(candidates(keyStroke("esc"))).toEqual(["escape"]);
    expect(candidates(keyStroke(" "))).toEqual(["space"]);
    expect(candidates(keyStroke("F6", { shift: true }))).toEqual(["shift+f6"]);
  });
});

describe("physical mode", () => {
  test("prefers the base-layout key and falls back to the character", () => {
    // Russian layout: the physical C key types Cyrillic с.
    const stroke = keyStroke("с", { ctrl: true, baseKey: "c" });
    expect(candidates(stroke, "physical")).toEqual(["ctrl+c", "ctrl+с"]);
    expect(candidates(stroke, "character")).toEqual(["ctrl+с"]);
  });

  test("without a reported base key physical mode matches characters", () => {
    expect(candidates(keyStroke("ş", { ctrl: true }), "physical")).toEqual(["ctrl+ş"]);
  });
});

describe("isTypingStroke", () => {
  test.each([
    [keyStroke("a"), true],
    [keyStroke("A", { shift: true }), true],
    [keyStroke("?"), true],
    [keyStroke("space"), true],
    [keyStroke("+"), true],
    [keyStroke("ş"), true],
    [keyStroke("a", { ctrl: true }), false],
    [keyStroke("a", { alt: true }), false],
    [keyStroke("a", { super: true }), false],
    [keyStroke("enter"), false],
    [keyStroke("escape"), false],
    [keyStroke("f1"), false],
    [keyStroke("down"), false],
  ] as const)("%o -> %s", (stroke, expected) => {
    expect(isTypingStroke(stroke)).toBe(expected);
  });
});
