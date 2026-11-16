import { describe, expect, test } from "bun:test";
import {
  ChordParseError,
  formatChord,
  normalizeKeySequence,
  parseChord,
  parseKeySequence,
  tryParseKeySequence,
} from "@/core/keybindings/chord";

const canon = normalizeKeySequence;

describe("parse and normalize", () => {
  test.each([
    ["ctrl+p", "ctrl+p"],
    ["Ctrl+Shift+P", "ctrl+shift+p"],
    ["shift+ctrl+p", "ctrl+shift+p"],
    ["super+alt+shift+ctrl+x", "ctrl+alt+shift+super+x"],
    ["cmd+k", "super+k"],
    ["command+k", "super+k"],
    ["win+e", "super+e"],
    ["option+left", "alt+left"],
    ["opt+q", "alt+q"],
    ["meta+b", "alt+b"],
    ["control+a", "ctrl+a"],
    ["ctrl+return", "ctrl+enter"],
    ["Esc", "escape"],
    ["ctrl+PageDown", "ctrl+pagedown"],
    ["pgup", "pageup"],
    ["F12", "f12"],
    ["shift+f6", "shift+f6"],
    ["ctrl+plus", "ctrl+plus"],
    ["ctrl++", "ctrl+plus"],
    ["+", "plus"],
    ["ctrl+-", "ctrl+-"],
    ["ctrl+`", "ctrl+`"],
    ["?", "?"],
    ["shift+/", "shift+/"],
    ["ctrl+space", "ctrl+space"],
    ["ctrl+k ctrl+s", "ctrl+k ctrl+s"],
    ["  Ctrl+K   S  ", "ctrl+k s"],
  ])("%s -> %s", (input, expected) => {
    expect(canon(input)).toBe(expected);
  });

  test("letters are case-insensitive; shift is always explicit", () => {
    expect(canon("Ctrl+P")).toBe("ctrl+p");
    expect(canon("A")).toBe("a");
    expect(canon("shift+A")).toBe("shift+a");
  });

  test("Turkish letters normalize without locale surprises", () => {
    expect(canon("Ş")).toBe("ş");
    expect(canon("ctrl+Ğ")).toBe("ctrl+ğ");
    expect(canon("İ")).toBe("i");
    expect(canon("I")).toBe("i");
    expect(canon("ı")).toBe("ı");
    expect(canon("shift+ç")).toBe("shift+ç");
    expect(parseChord("İ").key).toHaveLength(1);
  });

  test.each([
    ["", "empty"],
    ["   ", "empty"],
    ["ctrl+", "missing-key"],
    ["hyper+x", "unknown-modifier"],
    ["ctrl+ctrl+x", "duplicate-modifier"],
    ["ctrl+cmd+command+x", "duplicate-modifier"],
    ["ctrl+foo", "invalid-key"],
    ["ctrl+ab", "invalid-key"],
    ["a b c", "too-many-chords"],
  ] as const)("%j fails with %s", (input, reason) => {
    try {
      parseKeySequence(input);
      throw new Error("expected a parse error");
    } catch (error) {
      expect(error).toBeInstanceOf(ChordParseError);
      expect((error as ChordParseError).reason).toBe(reason);
      expect((error as ChordParseError).code).toBe("INVALID_ARGUMENT");
    }
  });

  test("tryParseKeySequence never throws for bad input", () => {
    expect(tryParseKeySequence("ctrl+k").ok).toBe(true);
    const bad = tryParseKeySequence("nope+x");
    expect(bad.ok).toBe(false);
  });
});

describe("formatChord", () => {
  test("mac style uses symbols in the conventional order", () => {
    expect(formatChord("ctrl+shift+p", "mac")).toBe("⌃⇧P");
    expect(formatChord("shift+super+alt+ctrl+z", "mac")).toBe("⌃⌥⇧⌘Z");
    expect(formatChord("ctrl+k ctrl+s", "mac")).toBe("⌃K ⌃S");
    expect(formatChord("ctrl+enter", "mac")).toBe("⌃↩");
    expect(formatChord("f6", "mac")).toBe("F6");
  });

  test("text style uses words, platform-aware for Alt and Super", () => {
    expect(formatChord("ctrl+shift+p", "text", { platform: "linux" })).toBe("Ctrl+Shift+P");
    expect(formatChord("alt+super+x", "text", { platform: "linux" })).toBe("Alt+Super+X");
    expect(formatChord("alt+super+x", "text", { platform: "darwin" })).toBe("Option+Cmd+X");
    expect(formatChord("ctrl+k ctrl+s", "text", { platform: "linux" })).toBe("Ctrl+K Ctrl+S");
    expect(formatChord("ctrl+pagedown", "text", { platform: "linux" })).toBe("Ctrl+PageDown");
    expect(formatChord("ctrl+plus", "text", { platform: "linux" })).toBe("Ctrl+Plus");
  });

  test("keycaps capitalize letters, keep dotless ı distinct", () => {
    expect(formatChord("ctrl+ş", "text", { platform: "linux" })).toBe("Ctrl+Ş");
    expect(formatChord("ctrl+ı", "text", { platform: "linux" })).toBe("Ctrl+ı");
    expect(formatChord("ctrl+i", "text", { platform: "linux" })).toBe("Ctrl+I");
  });

  test("accepts a parsed chord or sequence", () => {
    const sequence = parseKeySequence("ctrl+k z");
    expect(formatChord(sequence, "mac")).toBe("⌃K Z");
    expect(formatChord(parseChord("alt+q"), "mac")).toBe("⌥Q");
  });
});
