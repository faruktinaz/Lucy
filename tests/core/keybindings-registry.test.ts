import { describe, expect, test } from "bun:test";
import { chordToString, sequenceToString } from "@/core/keybindings/chord";
import { ContextKeys } from "@/core/keybindings/context-keys";
import { DEFAULT_KEYBINDINGS, type KeybindingDefinition } from "@/core/keybindings/defaults";
import { keyStroke } from "@/core/keybindings/key-stroke";
import { KeybindingRegistry, type ResolveResult, type Scheduler } from "@/core/keybindings/registry";

function fakeScheduler() {
  const timers = new Map<number, () => void>();
  let next = 1;
  const scheduler: Scheduler = {
    setTimeout: (callback) => {
      const id = next++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  return {
    scheduler,
    fireAll: () => {
      for (const [id, callback] of [...timers]) {
        timers.delete(id);
        callback();
      }
    },
    pending: () => timers.size,
  };
}

const commandOf = (result: ResolveResult) => (result.kind === "command" ? result.command : result.kind);

const ctrl = (key: string, extra: Partial<Parameters<typeof keyStroke>[1]> = {}) =>
  keyStroke(key, { ctrl: true, ...extra });

describe("resolve", () => {
  const defaults: KeybindingDefinition[] = [
    { command: "palette.show", keys: ["ctrl+shift+p", "f1"], global: true },
    { command: "file.quickOpen", keys: ["ctrl+p"] },
    { command: "editor.find", keys: ["ctrl+f"], when: "editorFocus" },
    { command: "search.find", keys: ["ctrl+f"], when: "sidebarView == 'search'" },
    { command: "help.show", keys: ["?"] },
    { command: "keybindings.open", keys: ["ctrl+k ctrl+s"] },
    { command: "view.toggleZenMode", keys: ["ctrl+k z"] },
  ];

  test("plain chords, when clauses and no match", () => {
    const registry = new KeybindingRegistry({ defaults });
    expect(commandOf(registry.resolve(ctrl("p")))).toBe("file.quickOpen");
    expect(commandOf(registry.resolve(ctrl("f"), { editorFocus: true }))).toBe("editor.find");
    expect(commandOf(registry.resolve(ctrl("f"), { sidebarView: "search" }))).toBe("search.find");
    expect(commandOf(registry.resolve(ctrl("f")))).toBe("none");
    expect(commandOf(registry.resolve(ctrl("x")))).toBe("none");
  });

  test("accepts a ContextKeys service", () => {
    const context = new ContextKeys();
    context.set("editorFocus", true);
    expect(commandOf(new KeybindingRegistry({ defaults }).resolve(ctrl("f"), context))).toBe("editor.find");
  });

  test("shifted characters: ? matches legacy and kitty input", () => {
    const registry = new KeybindingRegistry({ defaults });
    expect(commandOf(registry.resolve(keyStroke("?")))).toBe("help.show");
    expect(commandOf(registry.resolve(keyStroke("?", { shift: true, text: "?", baseKey: "/" })))).toBe(
      "help.show",
    );
  });

  test("shift+/ matches only when the base key is reported", () => {
    const registry = new KeybindingRegistry({ defaults: [{ command: "help.show", keys: ["shift+/"] }] });
    expect(commandOf(registry.resolve(keyStroke("?", { shift: true, text: "?", baseKey: "/" })))).toBe(
      "help.show",
    );
    expect(commandOf(registry.resolve(keyStroke("?")))).toBe("none");
  });

  test("Turkish letters resolve in character and physical mode", () => {
    const registry = new KeybindingRegistry({
      defaults: [
        { command: "a.turkishS", keys: ["ctrl+ş"] },
        { command: "a.upperS", keys: ["shift+ş"] },
        { command: "a.dotlessI", keys: ["shift+ı"] },
        { command: "a.copyLike", keys: ["ctrl+c"] },
      ],
    });
    expect(commandOf(registry.resolve(ctrl("ş")))).toBe("a.turkishS");
    expect(commandOf(registry.resolve(keyStroke("Ş")))).toBe("a.upperS");
    expect(commandOf(registry.resolve(keyStroke("I")))).toBe("a.dotlessI");
    // Physical mode: on a Russian layout the C key types "с" but still matches ctrl+c.
    expect(commandOf(registry.resolve(ctrl("с", { baseKey: "c" })))).toBe("none");
    registry.setMode("physical");
    expect(commandOf(registry.resolve(ctrl("с", { baseKey: "c" })))).toBe("a.copyLike");
  });
});

describe("terminal-focus and input-focus policies", () => {
  const registry = new KeybindingRegistry({ defaults: DEFAULT_KEYBINDINGS });
  const terminal = { terminalFocus: true };

  test("ctrl+r, ctrl+p and other shell keys fall through to the terminal", () => {
    for (const key of ["r", "p", "b", "w", "f", "k", "l", "a", "e"]) {
      expect(commandOf(registry.resolve(ctrl(key), terminal))).toBe("none");
    }
    expect(registry.pending).toBeUndefined();
  });

  test("only global escape hatches resolve while the terminal has focus", () => {
    expect(commandOf(registry.resolve(keyStroke("f1"), terminal))).toBe("palette.show");
    expect(commandOf(registry.resolve(ctrl("p", { shift: true }), terminal))).toBe("palette.show");
    expect(commandOf(registry.resolve(keyStroke("f6"), terminal))).toBe("view.focusNextPart");
    expect(commandOf(registry.resolve(keyStroke("f6", { shift: true }), terminal))).toBe(
      "view.focusPreviousPart",
    );
    expect(commandOf(registry.resolve(ctrl("`"), terminal))).toBe("terminal.toggle");
  });

  test("every global default is an F-key, a kitty-only chord or the Ctrl+\\ leader", () => {
    const globals = registry.all().filter((r) => r.global);
    for (const rule of globals) {
      const first = rule.sequence[0];
      const isFunctionKey = first !== undefined && /^f\d+$/.test(first.key);
      const isKittyOnly = first?.ctrl && (first.shift || first.key === "`");
      const isLeader = rule.sequence.length === 2 && rule.key.startsWith("ctrl+\\ ");
      expect({ key: rule.key, ok: isFunctionKey || isKittyOnly || isLeader }).toEqual({
        key: rule.key,
        ok: true,
      });
    }
    expect(new Set(globals.map((r) => r.command))).toEqual(
      new Set([
        "palette.show",
        "terminal.toggle",
        "view.focusNextPart",
        "view.focusPreviousPart",
        "view.showExplorer",
        "view.showSearch",
        "view.showSourceControl",
        "view.toggleAiPanel",
        "view.focusAiPanel",
        "view.focusLeft",
        "view.focusRight",
        "view.focusUp",
        "view.focusDown",
        "app.quit",
        "leader.sendKey",
      ]),
    );
  });

  test("the leader works from the terminal and swallows unknown follow-ups", () => {
    const leader = keyStroke("\\", { ctrl: true });
    expect(commandOf(registry.resolve(leader, terminal))).toBe("pending");
    expect(commandOf(registry.resolve(keyStroke("p"), terminal))).toBe("palette.show");
    expect(commandOf(registry.resolve(leader, terminal))).toBe("pending");
    expect(commandOf(registry.resolve(keyStroke("h"), terminal))).toBe("view.focusLeft");
    expect(commandOf(registry.resolve(leader, terminal))).toBe("pending");
    expect(commandOf(registry.resolve(leader, terminal))).toBe("leader.sendKey");
    expect(commandOf(registry.resolve(leader, terminal))).toBe("pending");
    expect(commandOf(registry.resolve(keyStroke("x"), terminal))).toBe("cancelled");
  });

  test("ctrl+l focuses the AI panel, but not from inside a terminal", () => {
    expect(commandOf(registry.resolve(ctrl("l")))).toBe("view.focusAiPanel");
    expect(commandOf(registry.resolve(ctrl("l"), terminal))).toBe("none");
  });

  test("printable keys without ctrl/alt never trigger bindings in an input", () => {
    const withLetter = new KeybindingRegistry({
      defaults: [
        { command: "help.show", keys: ["?"], global: true },
        { command: "scm.stage", keys: ["s"] },
        { command: "scm.stageAll", keys: ["shift+s"] },
        { command: "list.select", keys: ["enter"] },
        { command: "file.quickOpen", keys: ["ctrl+p"] },
      ],
    });
    const input = { inputFocus: true };
    expect(commandOf(withLetter.resolve(keyStroke("s"), input))).toBe("none");
    expect(commandOf(withLetter.resolve(keyStroke("S"), input))).toBe("none");
    expect(commandOf(withLetter.resolve(keyStroke("?"), input))).toBe("none");
    expect(commandOf(withLetter.resolve(keyStroke("enter"), input))).toBe("list.select");
    expect(commandOf(withLetter.resolve(ctrl("p"), input))).toBe("file.quickOpen");
    expect(commandOf(withLetter.resolve(keyStroke("s")))).toBe("scm.stage");
  });

  test("ctrl+w closes a tab, also from the editor's edit surface, but not in other inputs", () => {
    expect(commandOf(registry.resolve(ctrl("w")))).toBe("editor.closeTab");
    expect(commandOf(registry.resolve(ctrl("w"), { inputFocus: true, editorFocus: true }))).toBe(
      "editor.closeTab",
    );
    expect(commandOf(registry.resolve(ctrl("w"), { inputFocus: true, sidebarFocus: true }))).toBe("none");
  });
});

describe("sequences", () => {
  const defaults: KeybindingDefinition[] = [
    { command: "keybindings.open", keys: ["ctrl+k ctrl+s"] },
    { command: "view.toggleZenMode", keys: ["ctrl+k z"] },
    { command: "git.commit", keys: ["ctrl+k c"], when: "sidebarView == 'scm'" },
  ];

  test("prefix, completion and the pending state", () => {
    const timers = fakeScheduler();
    const registry = new KeybindingRegistry({ defaults, scheduler: timers.scheduler });
    const changes: (string | undefined)[] = [];
    registry.onDidChangePending((chord) => changes.push(chord && chordToString(chord)));
    const first = registry.resolve(ctrl("k"));
    expect(first.kind).toBe("pending");
    expect(registry.pending && chordToString(registry.pending)).toBe("ctrl+k");
    expect(timers.pending()).toBe(1);
    expect(commandOf(registry.resolve(ctrl("s")))).toBe("keybindings.open");
    expect(registry.pending).toBeUndefined();
    expect(timers.pending()).toBe(0);
    expect(changes).toEqual(["ctrl+k", undefined]);
  });

  test("a second key without a binding cancels and is consumed", () => {
    const registry = new KeybindingRegistry({ defaults, scheduler: fakeScheduler().scheduler });
    registry.resolve(ctrl("k"));
    expect(registry.resolve(keyStroke("x")).kind).toBe("cancelled");
    expect(registry.pending).toBeUndefined();
    // The next key resolves normally again.
    expect(registry.resolve(ctrl("k")).kind).toBe("pending");
  });

  test("escape cancels a pending sequence", () => {
    const registry = new KeybindingRegistry({ defaults, scheduler: fakeScheduler().scheduler });
    registry.resolve(ctrl("k"));
    expect(registry.resolve(keyStroke("escape")).kind).toBe("cancelled");
  });

  test("the timeout clears the pending state", () => {
    const timers = fakeScheduler();
    const registry = new KeybindingRegistry({
      defaults,
      scheduler: timers.scheduler,
      sequenceTimeoutMs: 1500,
    });
    const changes: (string | undefined)[] = [];
    registry.onDidChangePending((chord) => changes.push(chord && chordToString(chord)));
    registry.resolve(ctrl("k"));
    timers.fireAll();
    expect(registry.pending).toBeUndefined();
    expect(changes).toEqual(["ctrl+k", undefined]);
    expect(commandOf(registry.resolve(keyStroke("z")))).toBe("none");
  });

  test("the timeout works with real timers", async () => {
    const registry = new KeybindingRegistry({ defaults, sequenceTimeoutMs: 20 });
    registry.resolve(ctrl("k"));
    await Bun.sleep(60);
    expect(registry.pending).toBeUndefined();
    registry.dispose();
  });

  test("when clauses apply to the second step", () => {
    const registry = new KeybindingRegistry({ defaults, scheduler: fakeScheduler().scheduler });
    registry.resolve(ctrl("k"));
    expect(registry.resolve(keyStroke("c")).kind).toBe("cancelled");
    registry.resolve(ctrl("k"), { sidebarView: "scm" });
    expect(commandOf(registry.resolve(keyStroke("c"), { sidebarView: "scm" }))).toBe("git.commit");
  });

  test("sequence prefixes are not consumed while the terminal has focus", () => {
    const registry = new KeybindingRegistry({ defaults, scheduler: fakeScheduler().scheduler });
    expect(registry.resolve(ctrl("k"), { terminalFocus: true }).kind).toBe("none");
  });
});

describe("user overrides", () => {
  const defaults: KeybindingDefinition[] = [
    { command: "palette.show", keys: ["ctrl+shift+p", "f1"], global: true },
    { command: "view.toggleSidebar", keys: ["ctrl+b"] },
    { command: "editor.find", keys: ["ctrl+f"], when: "editorFocus" },
    { command: "file.quickOpen", keys: ["ctrl+p"] },
  ];
  const known = new Set([
    "palette.show",
    "view.toggleSidebar",
    "editor.find",
    "file.quickOpen",
    "custom.thing",
  ]);

  test("a string or array replaces the command's chords and inherits when/global", () => {
    const registry = new KeybindingRegistry({ defaults, isKnownCommand: (id) => known.has(id) });
    const problems = registry.setUserBindings({
      "palette.show": "f2",
      "editor.find": ["ctrl+g", "ctrl+k f"],
    });
    expect(problems).toEqual([]);
    expect(registry.bindingsFor("palette.show").map(sequenceToString)).toEqual(["f2"]);
    expect(commandOf(registry.resolve(keyStroke("f1")))).toBe("none");
    expect(commandOf(registry.resolve(keyStroke("f2"), { terminalFocus: true }))).toBe("palette.show");
    expect(commandOf(registry.resolve(ctrl("g")))).toBe("none");
    expect(commandOf(registry.resolve(ctrl("g"), { editorFocus: true }))).toBe("editor.find");
  });

  test("false unbinds; user bindings win over defaults on the same chord", () => {
    const registry = new KeybindingRegistry({ defaults, isKnownCommand: (id) => known.has(id) });
    registry.setUserBindings({ "view.toggleSidebar": false, "custom.thing": "ctrl+p" });
    expect(registry.bindingsFor("view.toggleSidebar")).toEqual([]);
    expect(commandOf(registry.resolve(ctrl("b")))).toBe("none");
    expect(commandOf(registry.resolve(ctrl("p")))).toBe("custom.thing");
    const shadow = registry.conflicts().find((c) => c.kind === "shadow");
    expect(shadow?.severity).toBe("info");
    expect(shadow?.rules[1].command).toBe("custom.thing");
  });

  test("unknown commands and unparseable chords become warnings", () => {
    const registry = new KeybindingRegistry({ defaults, isKnownCommand: (id) => known.has(id) });
    const problems = registry.setUserBindings({
      "no.such": "ctrl+y",
      "file.quickOpen": ["hyper+o", "ctrl+o"],
      "view.toggleSidebar": ["nonsense+x"],
    });
    expect(problems.map((p) => [p.command, p.severity])).toEqual([
      ["no.such", "warning"],
      ["file.quickOpen", "warning"],
      ["view.toggleSidebar", "warning"],
      ["view.toggleSidebar", "warning"],
    ]);
    expect(registry.bindingsFor("file.quickOpen").map(sequenceToString)).toEqual(["ctrl+o"]);
    // All chords invalid: the defaults stay.
    expect(registry.bindingsFor("view.toggleSidebar").map(sequenceToString)).toEqual(["ctrl+b"]);
  });

  test("setUserBindings replaces earlier overrides", () => {
    const registry = new KeybindingRegistry({ defaults });
    registry.setUserBindings({ "view.toggleSidebar": false });
    registry.setUserBindings({});
    expect(registry.bindingsFor("view.toggleSidebar").map(sequenceToString)).toEqual(["ctrl+b"]);
  });

  test("invalid default definitions are programmer errors", () => {
    expect(() => new KeybindingRegistry({ defaults: [{ command: "x.y", keys: ["bogus+x"] }] })).toThrow();
    expect(
      () => new KeybindingRegistry({ defaults: [{ command: "x.y", keys: ["f1"], when: "a &&" }] }),
    ).toThrow();
  });
});

describe("reports", () => {
  test("defaults have no conflicts", () => {
    expect(new KeybindingRegistry({ defaults: DEFAULT_KEYBINDINGS }).conflicts()).toEqual([]);
  });

  test("conflicts, disjoint contexts and prefix shadowing", () => {
    const registry = new KeybindingRegistry({
      defaults: [
        { command: "a.one", keys: ["ctrl+e"] },
        { command: "a.two", keys: ["ctrl+e"] },
        { command: "b.one", keys: ["ctrl+d"], when: "editorFocus" },
        { command: "b.two", keys: ["ctrl+d"], when: "!editorFocus" },
        { command: "c.single", keys: ["ctrl+k"] },
        { command: "c.sequence", keys: ["ctrl+k x"] },
      ],
    });
    const conflicts = registry.conflicts();
    expect(conflicts.map((c) => [c.kind, c.key])).toEqual([
      ["conflict", "ctrl+e"],
      ["prefix", "ctrl+k"],
    ]);
  });

  test("bindingsFor puts chords that work in the current terminal first", () => {
    const registry = new KeybindingRegistry({ defaults: DEFAULT_KEYBINDINGS });
    const legacy = registry.bindingsFor("view.showExplorer", { kittyKeyboard: false, platform: "linux" });
    // Ctrl+\\ is "conditional" (it means SIGQUIT in a shell), so it sorts after the chords that just work.
    expect(legacy.map(sequenceToString)).toEqual(["ctrl+k e", "ctrl+shift+e", "ctrl+\\ e"]);
    const kitty = registry.bindingsFor("view.showExplorer", { kittyKeyboard: true, platform: "linux" });
    expect(kitty.map(sequenceToString)).toEqual(["ctrl+k e", "ctrl+shift+e", "ctrl+\\ e"]);
  });

  test("all() lists every active rule with its source", () => {
    const registry = new KeybindingRegistry({ defaults: DEFAULT_KEYBINDINGS });
    registry.setUserBindings({ "app.quit": "ctrl+k ctrl+q" });
    const rules = registry.all();
    expect(rules.filter((r) => r.command === "app.quit").map((r) => [r.key, r.source])).toEqual([
      ["ctrl+k ctrl+q", "user"],
    ]);
    expect(rules.every((r) => !("whenExpr" in r))).toBe(true);
  });
});
