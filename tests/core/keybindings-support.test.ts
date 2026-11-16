import { describe, expect, test } from "bun:test";
import { DEFAULT_KEYBINDINGS } from "@/core/keybindings/defaults";
import {
  type ChordSupportOptions,
  chordSupport,
  commandsWithoutLegacySafeBinding,
  isLegacySafe,
  sequenceSupport,
} from "@/core/keybindings/terminal-support";

const legacyLinux: ChordSupportOptions = { kittyKeyboard: false, platform: "linux" };
const kittyLinux: ChordSupportOptions = { kittyKeyboard: true, platform: "linux" };
const legacyMac: ChordSupportOptions = { kittyKeyboard: false, platform: "darwin" };

function code(chord: string, options: ChordSupportOptions): string {
  const support = chordSupport(chord, options);
  return support.ok ? "ok" : `${support.severity}:${support.code}`;
}

describe("terminal reality table", () => {
  test.each([
    ["ctrl+c", "reserved:interrupt"],
    ["ctrl+z", "reserved:suspend"],
    ["ctrl+s", "conditional:flow-control"],
    ["ctrl+q", "conditional:flow-control"],
    ["ctrl+m", "unsupported:legacy-alias"],
    ["ctrl+i", "unsupported:legacy-alias"],
    ["ctrl+[", "unsupported:legacy-alias"],
    ["ctrl+h", "unsupported:legacy-alias"],
    ["ctrl+shift+p", "unsupported:ctrl-shift-letter"],
    ["ctrl+1", "unsupported:ctrl-digit"],
    ["ctrl+ş", "unsupported:ctrl-non-ascii"],
    ["ctrl+,", "unsupported:ctrl-punctuation"],
    ["ctrl+`", "unsupported:ctrl-punctuation"],
    ["shift+/", "unsupported:shift-punctuation"],
    ["ctrl+enter", "unsupported:modified-special-key"],
    ["shift+enter", "unsupported:modified-special-key"],
    ["super+k", "unsupported:super-legacy"],
    ["ctrl+p", "ok"],
    ["ctrl+k", "ok"],
    ["ctrl+]", "ok"],
    ["ctrl+/", "ok"],
    ["ctrl+space", "ok"],
    ["shift+tab", "ok"],
    ["?", "ok"],
    ["shift+a", "ok"],
    ["f6", "ok"],
    ["shift+f6", "ok"],
    ["ctrl+pagedown", "ok"],
    ["alt+b", "ok"],
  ])("legacy Linux: %s -> %s", (chord, expected) => {
    expect(code(chord, legacyLinux)).toBe(expected);
  });

  test("the kitty protocol lifts the legacy limitations but not the conventions", () => {
    for (const chord of ["ctrl+m", "ctrl+shift+p", "ctrl+1", "ctrl+ş", "ctrl+,", "shift+/", "ctrl+enter"]) {
      expect(code(chord, kittyLinux)).toBe("ok");
    }
    expect(code("ctrl+c", kittyLinux)).toBe("reserved:interrupt");
    expect(code("ctrl+s", kittyLinux)).toBe("conditional:flow-control");
    expect(code("super+k", kittyLinux)).toBe("conditional:super-terminal-shortcut");
  });

  test("on macOS Alt needs Option-as-Alt", () => {
    const support = chordSupport("alt+q", legacyMac);
    expect(support.ok).toBe(false);
    if (!support.ok) expect(support.reason).toContain("@");
    expect(code("alt+q", { ...legacyMac, optionAsAlt: true })).toBe("ok");
    expect(code("alt+q", { ...legacyMac, kittyKeyboard: true })).toBe("conditional:mac-option");
  });

  test("sequences fail on their first unsupported chord", () => {
    expect(sequenceSupport("ctrl+k ctrl+s", legacyLinux)).toMatchObject({ ok: false, code: "flow-control" });
    expect(sequenceSupport("ctrl+k s", legacyLinux).ok).toBe(true);
  });

  test("isLegacySafe uses the strictest setup (legacy, macOS, Option not Alt)", () => {
    expect(isLegacySafe("ctrl+k e")).toBe(true);
    expect(isLegacySafe("f1")).toBe(true);
    expect(isLegacySafe("alt+e")).toBe(false);
    expect(isLegacySafe("ctrl+shift+e")).toBe(false);
  });
});

describe("legacy-safe alternatives", () => {
  test("every default command has at least one legacy-safe chord", () => {
    // The only exception is the leader's own "send Ctrl+\\ through to the terminal" binding:
    // it exists only as the second press of the leader, which is not legacy-safe by definition
    // (Ctrl+\\ means SIGQUIT to a shell), yet is exactly what legacy terminals deliver.
    expect(commandsWithoutLegacySafeBinding(DEFAULT_KEYBINDINGS)).toEqual(["leader.sendKey"]);
  });

  test("the important workbench commands keep a legacy-safe chord", () => {
    const important = [
      "palette.show",
      "file.quickOpen",
      "app.quit",
      "view.toggleSidebar",
      "view.showExplorer",
      "view.showSearch",
      "view.showSourceControl",
      "view.toggleAiPanel",
      "view.focusAiPanel",
      "view.toggleBottomPanel",
      "view.toggleZenMode",
      "view.focusNextPart",
      "view.focusPreviousPart",
      "view.focusLeft",
      "view.focusRight",
      "view.focusUp",
      "view.focusDown",
      "terminal.toggle",
      "theme.select",
      "settings.open",
      "keybindings.open",
    ];
    expect(commandsWithoutLegacySafeBinding(DEFAULT_KEYBINDINGS, important)).toEqual([]);
  });

  test("the helper reports commands that lack one", () => {
    const bindings = [
      { command: "view.good", keys: ["ctrl+shift+e", "ctrl+k e"] },
      { command: "view.bad", keys: ["ctrl+shift+x", "alt+x"] },
    ];
    expect(commandsWithoutLegacySafeBinding(bindings)).toEqual(["view.bad"]);
    expect(commandsWithoutLegacySafeBinding(bindings, ["view.good", "view.missing"])).toEqual([
      "view.missing",
    ]);
  });
});
