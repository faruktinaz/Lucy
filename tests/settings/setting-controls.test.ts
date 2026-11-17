import { describe, expect, test } from "bun:test";
import { getDescriptor, type SettingDescriptor, settingsSchema } from "@/core/config/schema";
import { formatCommandLine, parseCommandLine } from "@/features/settings/model/command-line";
import {
  controlFor,
  formatSettingValue,
  initialDraft,
  parseDraft,
} from "@/features/settings/model/setting-controls";
import { foldText, matchesTerms, queryTerms } from "@/features/settings/model/text-match";

const d = (path: string) => getDescriptor(path) as unknown as SettingDescriptor<string, unknown>;

describe("controlFor", () => {
  test("every setting gets a control", () => {
    for (const descriptor of settingsSchema as readonly SettingDescriptor<string, unknown>[]) {
      expect(controlFor(descriptor).kind).toBeDefined();
    }
  });

  test.each([
    ["editor.wrap", "toggle"],
    ["ui.theme", "select"],
    ["ui.accent", "select-or-color"],
    ["editor.external", "select-or-command"],
    ["layout.sidebarWidth", "number"],
    ["ai.executable", "text"],
    ["explorer.exclude", "list"],
    ["keybindings.bindings", "keybindings"],
  ])("%s is a %s", (path, kind) => {
    expect<string>(controlFor(d(path)).kind).toBe(kind);
  });

  test("number controls carry min, max and unit; selects carry options", () => {
    expect(controlFor(d("layout.sidebarWidth"))).toEqual({
      kind: "number",
      min: 16,
      max: 80,
      unit: "columns",
    });
    const control = controlFor(d("ui.theme"));
    expect(control.kind === "select" && control.options.map((o) => o.label)).toEqual([
      "Catppuccin Mocha",
      "Tokyo Night",
      "Gruvbox Dark",
      "Dracula",
      "Nord",
      "One Dark",
      "Rosé Pine",
      "Kanagawa Wave",
      "Everforest Dark",
      "GitHub Dark",
      "Solarized Dark",
      "High Contrast",
    ]);
  });
});

describe("formatSettingValue", () => {
  test.each([
    ["editor.wrap", true, "On"],
    ["editor.wrap", false, "Off"],
    ["ui.theme", "tokyo-night", "Tokyo Night"],
    ["ui.accent", "#abcdef", "#abcdef"],
    ["ui.accent", "purple", "Purple"],
    ["layout.sidebarWidth", 30, "30 columns"],
    ["ai.executable", "", "Found on PATH"],
    ["terminal.shell", "", "$SHELL"],
    ["ai.executable", "/opt/claude", "/opt/claude"],
    ["explorer.exclude", [".git", "dist"], ".git, dist"],
    ["ai.args", [], "None"],
    ["editor.external", ["code", "--wait", "My Dir"], 'code --wait "My Dir"'],
    ["editor.external", "auto", "Automatic"],
    ["keybindings.bindings", {}, "No custom shortcuts"],
    ["keybindings.bindings", { "a.b": "ctrl+x" }, "1 custom shortcut"],
  ])("%s %j -> %s", (path, value, label) => {
    expect(formatSettingValue(d(path), value)).toBe(label);
  });
});

describe("parseDraft (live validation)", () => {
  test("numbers", () => {
    expect(parseDraft(d("layout.sidebarWidth"), "number", " 40 ")).toEqual({ ok: true, value: 40 });
    expect(parseDraft(d("layout.sidebarWidth"), "number", "4.5")).toEqual({
      ok: false,
      error: "Enter a whole number",
    });
    expect(parseDraft(d("layout.sidebarWidth"), "number", "")).toEqual({
      ok: false,
      error: "Enter a whole number",
    });
    expect(parseDraft(d("layout.sidebarWidth"), "number", "5")).toEqual({
      ok: false,
      error: "Expected a whole number from 16 to 80 columns",
    });
  });

  test("text, colors and commands", () => {
    expect(parseDraft(d("ai.executable"), "text", "a\0b")).toEqual({
      ok: false,
      error: "Must not contain NUL characters",
    });
    expect(parseDraft(d("ai.executable"), "text", "x".repeat(5000))).toEqual({
      ok: false,
      error: "This value is too long",
    });
    expect(parseDraft(d("ui.accent"), "color", "#ABCDEF")).toEqual({ ok: true, value: "#abcdef" });
    expect(parseDraft(d("ui.accent"), "color", "#abc")).toEqual({
      ok: false,
      error: "Enter a color as #rrggbb",
    });
    expect(parseDraft(d("editor.external"), "command", "code --wait")).toEqual({
      ok: true,
      value: ["code", "--wait"],
    });
    expect(parseDraft(d("editor.external"), "command", "  ").ok).toBe(false);
  });

  test("list entries validate the whole list", () => {
    const list = { items: [".git"], index: null };
    expect(parseDraft(d("explorer.exclude"), "list-entry", "dist", list)).toEqual({
      ok: true,
      value: [".git", "dist"],
    });
    expect(parseDraft(d("explorer.exclude"), "list-entry", "", list)).toEqual({
      ok: false,
      error: "An entry cannot be empty",
    });
    expect(parseDraft(d("explorer.exclude"), "list-entry", "lib", { items: [".git"], index: 0 })).toEqual({
      ok: true,
      value: ["lib"],
    });
    // ai.args allows empty arguments.
    expect(parseDraft(d("ai.args"), "list-entry", "", { items: [], index: null })).toEqual({
      ok: true,
      value: [""],
    });
  });

  test("initial drafts", () => {
    expect(initialDraft("number", 30)).toBe("30");
    expect(initialDraft("color", "purple")).toBe("#");
    expect(initialDraft("color", "#123456")).toBe("#123456");
    expect(initialDraft("command", "auto")).toBe("");
    expect(initialDraft("command", ["code", "-w"])).toBe("code -w");
  });
});

describe("command lines", () => {
  test.each([
    ["code --wait", ["code", "--wait"]],
    ['  "My Editor" -n  ', ["My Editor", "-n"]],
    ["emacs -nw 'a b' c\\ d", ["emacs", "-nw", "a b", "c d"]],
    ['x "say \\"hi\\"" ""', ["x", 'say "hi"', ""]],
    ["nvim $HOME *.ts", ["nvim", "$HOME", "*.ts"]],
  ])("%j parses", (text, argv) => {
    expect(parseCommandLine(text)).toEqual({ ok: true, argv });
  });

  test("errors and round trips", () => {
    expect(parseCommandLine('code "unclosed')).toEqual({ ok: false, error: "Missing closing double quote" });
    expect(parseCommandLine("").ok).toBe(false);
    for (const argv of [["a"], ["My Editor", "--flag=x y"], ['q"uote', "back\\slash", ""]]) {
      const parsed = parseCommandLine(formatCommandLine(argv));
      expect(parsed).toEqual({ ok: true, argv });
    }
  });
});

describe("text matching", () => {
  test("case-, accent- and dotless-i-insensitive, all terms required", () => {
    expect(foldText("Çalışma İ")).toBe("calisma i");
    expect(matchesTerms(queryTerms("side WIDTH"), ["Sidebar width", "layout.sidebar_width"])).toBe(true);
    expect(matchesTerms(queryTerms("sidebar color"), ["Sidebar width"])).toBe(false);
    expect(matchesTerms(queryTerms(""), [])).toBe(true);
  });
});
