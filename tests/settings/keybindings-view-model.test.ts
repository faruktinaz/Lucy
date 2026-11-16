import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";
import { CommandRegistry } from "@/core/commands/registry";
import { configFilePath } from "@/core/config/load";
import { ConfigService } from "@/core/config/service";
import type { KeybindingDefinition } from "@/core/keybindings/defaults";
import { keyStroke } from "@/core/keybindings/key-stroke";
import { KeybindingRegistry, type ResolveResult } from "@/core/keybindings/registry";
import type { ChordSupportOptions } from "@/core/keybindings/terminal-support";
import {
  type CommandRow,
  KeybindingsViewModel,
  syncUserBindings,
} from "@/features/settings/model/keybindings-view-model";
import { makeTempDirs, type TempDirs } from "../core/helpers";

const DEFAULTS: KeybindingDefinition[] = [
  { command: "palette.show", keys: ["ctrl+shift+p", "f1"], global: true },
  { command: "file.quickOpen", keys: ["ctrl+p"] },
  { command: "view.toggleSidebar", keys: ["ctrl+b"] },
  { command: "view.showExplorer", keys: ["ctrl+shift+e", "ctrl+k e"] },
  { command: "editor.find", keys: ["ctrl+f"], when: "editorFocus" },
  { command: "search.find", keys: ["ctrl+f"], when: "!editorFocus" },
  { command: "keybindings.open", keys: ["ctrl+k ctrl+s"] },
  { command: "dup.one", keys: ["ctrl+y"] },
  { command: "dup.two", keys: ["ctrl+y"] },
];

const LEGACY: ChordSupportOptions = { kittyKeyboard: false, platform: "linux" };

let temp: TempDirs;
beforeEach(async () => {
  temp = await makeTempDirs();
});
afterEach(async () => {
  await temp.cleanup();
});

async function setup(support: ChordSupportOptions = LEGACY) {
  const config = await ConfigService.load(temp.dirs);
  const registry = new KeybindingRegistry({ defaults: DEFAULTS });
  const commands = new CommandRegistry();
  const noop = () => {};
  commands.register({ id: "palette.show", title: "Show Command Palette", category: "General", run: noop });
  commands.register({ id: "file.quickOpen", title: "Go to File", category: "File", run: noop });
  commands.register({ id: "view.toggleSidebar", title: "Toggle Sidebar", category: "View", run: noop });
  commands.register({ id: "view.showExplorer", title: "Show Explorer", category: "View", run: noop });
  commands.register({ id: "editor.find", title: "Find", category: "Editor", run: noop });
  commands.register({ id: "view.unbound", title: "Unbound Command", category: "View", run: noop });
  commands.register({ id: "internal.hidden", title: "Hidden", category: "Dev", hidden: true, run: noop });
  const vm = new KeybindingsViewModel({ registry, commands, config, support, style: "text" });
  return { config, registry, commands, vm };
}

const row = (vm: KeybindingsViewModel, id: string) => vm.row(id) as CommandRow;
const commandOf = (r: ResolveResult) => (r.kind === "command" ? r.command : r.kind);
const ctrl = (key: string, extra: Partial<Parameters<typeof keyStroke>[1]> = {}) =>
  keyStroke(key, { ctrl: true, ...extra });
const fileBindings = async () =>
  (parse(await readFile(configFilePath(temp.dirs), "utf8")) as { keybindings?: { bindings?: unknown } })
    .keybindings?.bindings;

describe("rows", () => {
  test("commands grouped by category, sorted, with bindings and metadata", async () => {
    const { vm } = await setup();
    const categories = vm.state.rows.flatMap((r) => (r.type === "category" ? [r.category] : []));
    expect(categories).toEqual(["Editor", "File", "General", "Other", "Preferences", "Search", "View"]);
    const view = vm.state.rows.filter((r): r is CommandRow => r.type === "command" && r.category === "View");
    expect(view.map((r) => r.title)).toEqual(["Show Explorer", "Toggle Sidebar", "Unbound Command"]);
    expect(row(vm, "view.unbound").bindings).toEqual([]);
    expect(vm.row("internal.hidden")).toBeUndefined();
  });

  test("unregistered commands get a readable title and an area category", async () => {
    const { vm } = await setup();
    expect(row(vm, "keybindings.open")).toMatchObject({
      title: "Open",
      category: "Preferences",
      registered: false,
    });
    expect(row(vm, "search.find").category).toBe("Search");
    expect(row(vm, "dup.one").category).toBe("Other");
  });

  test("binding views: label, source, when, global, terminal warning, conflicts", async () => {
    const { vm } = await setup();
    const palette = row(vm, "palette.show").bindings;
    expect(palette.map((b) => [b.key, b.label, b.source, b.global])).toEqual([
      ["ctrl+shift+p", "Ctrl+Shift+P", "default", true],
      ["f1", "F1", "default", true],
    ]);
    expect(palette[0]?.warning).toContain("indistinguishable");
    expect(palette[1]?.warning).toBeNull();
    expect(row(vm, "editor.find").bindings[0]?.when).toBe("editorFocus");
    // Same chord in disjoint contexts is not a conflict; identical contexts are.
    expect(row(vm, "editor.find").bindings[0]?.conflicts).toEqual([]);
    expect(row(vm, "dup.one").bindings[0]?.conflicts[0]).toContain("bound to both");
    expect(row(vm, "keybindings.open").bindings[0]?.label).toBe("Ctrl+K Ctrl+S");
  });

  test("the kitty capability removes legacy warnings", async () => {
    const { vm } = await setup({ kittyKeyboard: true, platform: "linux" });
    expect(row(vm, "palette.show").bindings[0]?.warning).toBeNull();
  });

  test("mac style labels by default on macOS", async () => {
    const config = await ConfigService.load(temp.dirs);
    const vm = new KeybindingsViewModel({
      registry: new KeybindingRegistry({ defaults: DEFAULTS }),
      commands: new CommandRegistry(),
      config,
      support: { kittyKeyboard: false, platform: "darwin" },
    });
    expect(row(vm, "palette.show").bindings[0]?.label).toBe("⌃⇧P");
  });

  test("search by title, id, canonical chord or displayed label", async () => {
    const { vm } = await setup();
    const ids = () => vm.state.rows.flatMap((r) => (r.type === "command" ? [r.id] : []));
    vm.setQuery("sidebar");
    expect(ids()).toEqual(["view.toggleSidebar"]);
    vm.setQuery("quickOpen");
    expect(ids()).toEqual(["file.quickOpen"]);
    vm.setQuery("ctrl+b");
    expect(ids()).toEqual(["view.toggleSidebar"]);
    vm.setQuery("Ctrl+K Ctrl+S");
    expect(ids()).toEqual(["keybindings.open"]);
    expect(vm.state.selectedCommand).toBe("keybindings.open");
    vm.setQuery("");
    expect(ids().length).toBe(10);
  });

  test("selection moves over commands only", async () => {
    const { vm } = await setup();
    expect(vm.state.selectedCommand).toBe("editor.find");
    vm.moveSelection(1);
    expect(vm.state.selectedCommand).toBe("file.quickOpen");
    expect(vm.state.rows[vm.state.selectedIndex]?.type).toBe("command");
    vm.select("view.unbound");
    expect(vm.state.selectedCommand).toBe("view.unbound");
  });
});

describe("remapping", () => {
  test("capture a one-step chord, review, confirm: saved and live", async () => {
    const { registry, vm } = await setup();
    vm.beginCapture("view.toggleSidebar");
    let capture = vm.captureStroke(ctrl("e"));
    expect(capture).toMatchObject({ phase: "capturing", label: "Ctrl+E" });
    if (capture.phase === "capturing") expect(capture.hint).toContain("Enter");
    capture = vm.captureStroke(keyStroke("enter"));
    expect(capture).toMatchObject({
      phase: "review",
      key: "ctrl+e",
      label: "Ctrl+E",
      refusal: null,
      conflicts: [],
    });
    expect(await vm.confirm()).toBe(true);
    expect(vm.state.capture.phase).toBe("idle");
    expect(vm.state.message?.text).toContain("Ctrl+E");
    expect(await fileBindings()).toEqual({ "view.toggleSidebar": ["ctrl+b", "ctrl+e"] });
    expect(commandOf(registry.resolve(ctrl("e")))).toBe("view.toggleSidebar");
    expect(row(vm, "view.toggleSidebar")).toMatchObject({ modified: true });
    expect(row(vm, "view.toggleSidebar").bindings.map((b) => [b.key, b.source])).toEqual([
      ["ctrl+b", "user"],
      ["ctrl+e", "user"],
    ]);
  });

  test("two strokes make a sequence and finish automatically", async () => {
    const { registry, vm } = await setup();
    vm.beginCapture("view.unbound");
    vm.captureStroke(ctrl("k"));
    const capture = vm.captureStroke(keyStroke("u"));
    expect(capture).toMatchObject({ phase: "review", key: "ctrl+k u", label: "Ctrl+K U" });
    await vm.confirm();
    expect(await fileBindings()).toEqual({ "view.unbound": "ctrl+k u" });
    expect(registry.resolve(ctrl("k")).kind).toBe("pending");
    expect(commandOf(registry.resolve(keyStroke("u")))).toBe("view.unbound");
  });

  test("escape cancels; enter alone and lone modifiers are ignored", async () => {
    const { vm } = await setup();
    vm.beginCapture("view.unbound");
    expect(vm.captureStroke(keyStroke("enter")).phase).toBe("capturing");
    expect(vm.captureStroke(keyStroke("shift", { shift: true })).phase).toBe("capturing");
    expect(vm.captureStroke(keyStroke("escape")).phase).toBe("idle");
    expect(await vm.confirm()).toBe(false);
    // finishCapture is the mouse/button equivalent of Enter.
    vm.beginCapture("view.unbound");
    vm.captureStroke(keyStroke("f9"));
    expect(vm.finishCapture()).toMatchObject({ phase: "review", key: "f9" });
    expect(vm.cancel().phase).toBe("idle");
    expect(await Bun.file(configFilePath(temp.dirs)).exists()).toBe(false);
  });

  test("shifted characters and modifiers are captured canonically", async () => {
    const { vm } = await setup();
    vm.beginCapture("view.unbound");
    vm.captureStroke(keyStroke("A", { alt: true }));
    expect(vm.finishCapture()).toMatchObject({ key: "alt+shift+a" });
    vm.beginCapture("view.unbound");
    vm.captureStroke(keyStroke("?", { shift: true, text: "?", baseKey: "/" }));
    expect(vm.finishCapture()).toMatchObject({ key: "?" });
  });

  test("reserved chords are refused with the reason", async () => {
    const { vm } = await setup();
    vm.beginCapture("view.unbound");
    vm.captureStroke(ctrl("c"));
    const review = vm.finishCapture();
    expect(review.phase === "review" && review.refusal).toContain("interrupt");
    expect(await vm.confirm()).toBe(false);
    expect(vm.state.message?.severity).toBe("error");
    expect(await Bun.file(configFilePath(temp.dirs)).exists()).toBe(false);
  });

  test("a chord the command already has is refused", async () => {
    const { vm } = await setup();
    vm.beginCapture("view.toggleSidebar");
    vm.captureStroke(ctrl("b"));
    const review = vm.finishCapture();
    expect(review.phase === "review" && review.refusal).toContain("already a shortcut");
  });

  test("terminal-support warnings are shown before saving", async () => {
    const { vm } = await setup();
    vm.beginCapture("view.unbound");
    vm.captureStroke(ctrl("x", { shift: true }));
    const review = vm.finishCapture();
    expect(review.phase === "review" && review.warning).toContain("indistinguishable");
    expect(review.phase === "review" && review.refusal).toBeNull();
    vm.cancel();
    vm.beginCapture("view.unbound");
    vm.captureStroke(keyStroke("x"));
    const plain = vm.finishCapture();
    expect(plain.phase === "review" && plain.warning).toContain("typing in a text field");
  });

  test("conflicts are shown; replaceConflicts moves the chord", async () => {
    const { registry, vm } = await setup();
    vm.beginCapture("view.toggleSidebar");
    vm.captureStroke(ctrl("p"));
    const review = vm.finishCapture();
    expect(review.phase === "review" && review.conflicts).toEqual([
      { command: "file.quickOpen", title: "Go to File", key: "ctrl+p", label: "Ctrl+P", kind: "same" },
    ]);
    expect(await vm.confirm({ replaceConflicts: true })).toBe(true);
    expect(await fileBindings()).toEqual({
      "view.toggleSidebar": ["ctrl+b", "ctrl+p"],
      "file.quickOpen": false,
    });
    expect(commandOf(registry.resolve(ctrl("p")))).toBe("view.toggleSidebar");
    expect(row(vm, "file.quickOpen")).toMatchObject({
      bindings: [],
      modified: true,
      defaultLabels: ["Ctrl+P"],
    });
  });

  test("without replaceConflicts both keep the chord and the user binding wins", async () => {
    const { registry, vm } = await setup();
    vm.beginCapture("view.toggleSidebar");
    vm.captureStroke(ctrl("p"));
    vm.finishCapture();
    await vm.confirm();
    expect(commandOf(registry.resolve(ctrl("p")))).toBe("view.toggleSidebar");
    expect(row(vm, "file.quickOpen").bindings[0]?.conflicts.length).toBeGreaterThan(0);
  });

  test("prefix conflicts and disjoint contexts", async () => {
    const { vm } = await setup();
    vm.beginCapture("view.unbound");
    vm.captureStroke(ctrl("k"));
    const prefix = vm.finishCapture();
    expect(prefix.phase === "review" && prefix.conflicts.map((c) => [c.command, c.kind])).toEqual([
      ["view.showExplorer", "prefix"],
      ["keybindings.open", "prefix"],
    ]);
    vm.cancel();
    // editor.find (editorFocus) vs search.find (!editorFocus): no conflict for ctrl+f.
    vm.beginCapture("editor.find", { replace: "ctrl+f" });
    vm.captureStroke(ctrl("f"));
    const same = vm.finishCapture();
    expect(same.phase === "review" && same.conflicts).toEqual([]);
  });

  test("replace swaps one chord for another", async () => {
    const { registry, vm } = await setup();
    vm.beginCapture("view.showExplorer", { replace: "ctrl+shift+e" });
    vm.captureStroke(ctrl("e", { alt: true }));
    vm.finishCapture();
    await vm.confirm();
    expect(await fileBindings()).toEqual({ "view.showExplorer": ["ctrl+alt+e", "ctrl+k e"] });
    expect(commandOf(registry.resolve(ctrl("e", { alt: true })))).toBe("view.showExplorer");
  });

  test("removeBinding and resetToDefault", async () => {
    const { registry, vm } = await setup();
    expect(await vm.removeBinding("view.showExplorer", "ctrl+shift+e")).toBe(true);
    expect(await fileBindings()).toEqual({ "view.showExplorer": "ctrl+k e" });
    expect(await vm.removeBinding("view.showExplorer", "ctrl+k e")).toBe(true);
    expect(await fileBindings()).toEqual({ "view.showExplorer": false });
    expect(registry.bindingsFor("view.showExplorer")).toEqual([]);
    expect(await vm.removeBinding("view.showExplorer", "ctrl+k e")).toBe(false);
    expect(vm.state.message?.severity).toBe("error");
    expect(await vm.resetToDefault("view.showExplorer")).toBe(true);
    expect(await fileBindings()).toBeUndefined();
    expect(row(vm, "view.showExplorer").bindings.map((b) => [b.key, b.source])).toEqual([
      ["ctrl+shift+e", "default"],
      ["ctrl+k e", "default"],
    ]);
  });

  test("an override equal to the defaults is removed rather than stored", async () => {
    const { vm } = await setup();
    await vm.removeBinding("view.showExplorer", "ctrl+k e");
    vm.beginCapture("view.showExplorer");
    vm.captureStroke(ctrl("k"));
    vm.captureStroke(keyStroke("e"));
    await vm.confirm();
    expect(await fileBindings()).toBeUndefined();
    expect(row(vm, "view.showExplorer").modified).toBe(false);
  });

  test("removing a binding from a command without defaults drops its override", async () => {
    const { vm } = await setup();
    vm.beginCapture("view.unbound");
    vm.captureStroke(keyStroke("f9"));
    vm.finishCapture();
    await vm.confirm();
    expect(await vm.removeBinding("view.unbound", "f9")).toBe(true);
    expect(await fileBindings()).toBeUndefined();
  });

  test("registry problems from the config are surfaced", async () => {
    const { config, vm } = await setup();
    await config.set("keybindings.bindings", { "view.toggleSidebar": ["hyper+b", "ctrl+t"] });
    vm.beginCapture("file.quickOpen");
    vm.captureStroke(keyStroke("f8"));
    vm.finishCapture();
    await vm.confirm();
    expect(vm.state.problems.map((p) => p.command)).toEqual(["view.toggleSidebar"]);
  });
});

describe("syncUserBindings", () => {
  test("keeps a registry in step with config changes", async () => {
    const { config, registry } = await setup();
    const sub = syncUserBindings(registry, config);
    await config.set("keybindings.bindings", { "file.quickOpen": "ctrl+o" });
    expect(commandOf(registry.resolve(ctrl("o")))).toBe("file.quickOpen");
    expect(commandOf(registry.resolve(ctrl("p")))).toBe("none");
    sub.dispose();
  });
});
