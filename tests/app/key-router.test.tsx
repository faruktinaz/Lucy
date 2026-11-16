/**
 * The key router's layers and the two focus policies, through the real input pipeline:
 * mock terminal bytes -> OpenTUI's parser -> KeyRouter (prepended listener) -> focused widget.
 *
 * A fake terminal-like widget records every key that reaches it, which is how these tests
 * prove what the router lets through and what it keeps.
 */
import { describe, expect, test } from "bun:test";
import type { InputRenderable, KeyEvent } from "@opentui/core";
import { Renderable } from "@opentui/core";
import { extend } from "@opentui/react";
import { useRef } from "react";
import { KeyRouter, LEADER_PASSTHROUGH_COMMAND, registerTerminalRenderable } from "@/app/input/key-router";
import { FocusService } from "@/app/workbench/focus";
import { HintService } from "@/app/workbench/hints";
import { OverlayService } from "@/app/workbench/overlays";
import { CommandRegistry } from "@/core/commands";
import { ContextKeys, DEFAULT_KEYBINDINGS, KeybindingRegistry } from "@/core/keybindings";
import type { KeyStroke } from "@/core/keybindings/key-stroke";
import { log } from "@/core/log";
import { mountTui, type Tui } from "../helpers/tui";
import { createFakeClock } from "./fake-clock";

/** A focusable widget that records the keys it receives, like an embedded terminal would. */
class FakeTerminalRenderable extends Renderable {
  protected static override readonly defaultFocusable = true;
  readonly received: string[] = [];

  override handleKeyPress(key: KeyEvent): boolean {
    const mods = `${key.ctrl ? "ctrl+" : ""}${key.meta ? "alt+" : ""}${key.shift ? "shift+" : ""}`;
    this.received.push(`${mods}${key.name}`);
    return true;
  }
}

declare module "@opentui/react" {
  interface OpenTUIComponents {
    "fake-terminal": typeof FakeTerminalRenderable;
  }
}

let registered = false;
function registerFakeTerminal(): void {
  if (registered) return;
  registered = true;
  extend({ "fake-terminal": FakeTerminalRenderable });
}

interface Refs {
  terminal: { current: FakeTerminalRenderable | null };
  input: { current: InputRenderable | null };
}

function Scene({ refs }: { refs: (r: Refs) => void }) {
  const terminal = useRef<FakeTerminalRenderable>(null);
  const input = useRef<InputRenderable>(null);
  refs({ terminal, input });
  return (
    <box flexDirection="column" width="100%" height="100%">
      <fake-terminal ref={terminal} width={20} height={3} />
      <input ref={input} width={20} />
    </box>
  );
}

interface Harness {
  tui: Tui;
  terminal: FakeTerminalRenderable;
  input: InputRenderable;
  ran: string[];
  suspended: number;
  focus: FocusService;
  overlays: OverlayService;
  hints: HintService;
  router: KeyRouter;
  focusTerminal(): Promise<void>;
  focusInput(): Promise<void>;
  blurAll(): Promise<void>;
}

const SPIED_COMMANDS = [
  "palette.show",
  "file.quickOpen",
  "view.focusLeft",
  "view.toggleZenMode",
  "app.quit",
  "view.showExplorer",
  "test.jump",
];

async function setup(kittyKeyboard = true): Promise<Harness> {
  registerFakeTerminal();
  let refs: Refs | null = null;
  const tui = await mountTui(
    <Scene
      refs={(r) => {
        refs = r;
      }}
    />,
    // As in the app: OpenTUI must not destroy the renderer on Ctrl+C (it belongs to terminals).
    { width: 40, height: 8, kittyKeyboard, renderer: { exitOnCtrlC: false } },
  );
  const captured = refs as Refs | null;
  const terminal = captured?.terminal.current;
  const input = captured?.input.current;
  if (!terminal || !input) throw new Error("scene did not mount");
  registerTerminalRenderable(terminal);

  const contextKeys = new ContextKeys();
  const commands = new CommandRegistry({ context: contextKeys });
  const keybindings = new KeybindingRegistry({
    // A plain-letter binding proves that typing into an input never triggers bindings.
    defaults: [...DEFAULT_KEYBINDINGS, { command: "test.jump", keys: ["j"] }],
  });
  const ran: string[] = [];
  for (const id of SPIED_COMMANDS)
    commands.register({ id, title: id, category: "Test", run: () => void ran.push(id) });
  const focus = new FocusService(contextKeys);
  const overlays = new OverlayService(contextKeys);
  const hints = new HintService(createFakeClock());
  const harness = {
    tui,
    terminal,
    input,
    ran,
    suspended: 0,
    focus,
    overlays,
    hints,
  } as Omit<Harness, "router" | "focusTerminal" | "focusInput" | "blurAll"> & Partial<Harness>;
  const router = new KeyRouter({
    renderer: tui.renderer,
    keybindings,
    contextKeys,
    commands,
    focus,
    overlays,
    hints,
    log,
    onSuspend: () => {
      harness.suspended = (harness.suspended ?? 0) + 1;
    },
    quitLabel: () => "Ctrl+Q",
  }).install();
  return {
    ...(harness as Omit<Harness, "router" | "focusTerminal" | "focusInput" | "blurAll">),
    get suspended() {
      return harness.suspended ?? 0;
    },
    router,
    focusTerminal: () => tui.act(() => terminal.focus()),
    focusInput: () => tui.act(() => input.focus()),
    blurAll: () =>
      tui.act(() => {
        terminal.blur();
        input.blur();
      }),
  };
}

/** Lets pending command promises settle. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("terminal-focus policy", () => {
  test("only global bindings run; everything else reaches the terminal untouched", async () => {
    const h = await setup();
    await h.focusTerminal();
    expect(h.router.focusedWidget()).toEqual({ terminal: true, input: false });

    for (const key of [
      "ctrl+r",
      "ctrl+p",
      "ctrl+c",
      "ctrl+z",
      "ctrl+l",
      "ctrl+b",
      "escape",
      "tab",
      "a",
      "j",
      "ş",
    ]) {
      await h.tui.press(key);
    }
    await flush();
    expect(h.ran).toEqual([]);
    expect(h.suspended).toBe(0);
    expect(h.terminal.received).toEqual([
      "ctrl+r",
      "ctrl+p",
      "ctrl+c",
      "ctrl+z",
      "ctrl+l",
      "ctrl+b",
      "escape",
      "tab",
      "a",
      "j",
      "ş",
    ]);
  });

  test("F1 and kitty-only Ctrl+Shift+P open the palette and never reach the terminal", async () => {
    const h = await setup();
    await h.focusTerminal();
    await h.tui.press("f1");
    await h.tui.press("ctrl+shift+p");
    await h.tui.press("ctrl+shift+e");
    await flush();
    expect(h.ran).toEqual(["palette.show", "palette.show", "view.showExplorer"]);
    expect(h.terminal.received).toEqual([]);
  });

  test("the Ctrl+\\ leader: a command, a literal Ctrl+\\, and a swallowed unknown key", async () => {
    const h = await setup();
    await h.focusTerminal();

    await h.tui.press("ctrl+\\");
    // The armed leader is visible in the hint area.
    expect(h.hints.current?.text).toContain("Ctrl+\\");
    await h.tui.press("p");
    await flush();
    expect(h.ran).toEqual(["palette.show"]);
    expect(h.terminal.received).toEqual([]);
    expect(h.hints.current).toBeNull();

    await h.tui.press("ctrl+\\");
    await h.tui.press("h");
    await flush();
    expect(h.ran).toEqual(["palette.show", "view.focusLeft"]);
    expect(h.terminal.received).toEqual([]);

    // Pressing the leader twice sends exactly one Ctrl+\ through to the terminal.
    await h.tui.press("ctrl+\\");
    await h.tui.press("ctrl+\\");
    expect(h.terminal.received).toEqual(["ctrl+\\"]);
    expect(LEADER_PASSTHROUGH_COMMAND).toBe("leader.sendKey");

    // Any other follow-up is swallowed.
    await h.tui.press("ctrl+\\");
    await h.tui.press("x");
    await flush();
    expect(h.terminal.received).toEqual(["ctrl+\\"]);
    expect(h.ran).toEqual(["palette.show", "view.focusLeft"]);
  });

  test("the leader works in a legacy terminal too", async () => {
    const h = await setup(false);
    await h.focusTerminal();
    await h.tui.press("ctrl+\\");
    await h.tui.press("q");
    await h.tui.press("ctrl+r");
    await flush();
    expect(h.ran).toEqual(["app.quit"]);
    expect(h.terminal.received).toEqual(["ctrl+r"]);
  });

  test("zone handlers never see keys while a terminal has focus", async () => {
    const h = await setup();
    const seen: string[] = [];
    h.focus.registerKeyHandler("editor", (stroke) => {
      seen.push(stroke.key);
      return true;
    });
    await h.focusTerminal();
    await h.tui.press("q");
    expect(seen).toEqual([]);
    expect(h.terminal.received).toEqual(["q"]);
  });
});

describe("text-input focus policy", () => {
  test("typing goes into the input and never triggers bindings", async () => {
    const h = await setup();
    await h.focusInput();
    expect(h.router.focusedWidget()).toEqual({ terminal: false, input: true });
    await h.tui.type("jpş");
    await flush();
    expect(h.input.value).toBe("jpş");
    expect(h.ran).toEqual([]);
  });

  test("chords still work: Ctrl+P and Ctrl+K sequences", async () => {
    const h = await setup();
    await h.focusInput();
    await h.tui.press("ctrl+p");
    await h.tui.press("ctrl+k");
    expect(h.hints.current?.text).toContain("Ctrl+K");
    await h.tui.press("z");
    await flush();
    expect(h.ran).toEqual(["file.quickOpen", "view.toggleZenMode"]);
    // The second key of the sequence was consumed, not typed.
    expect(h.input.value).toBe("");
  });

  test("the same plain letter runs its binding when no input has focus", async () => {
    const h = await setup();
    await h.blurAll();
    await h.tui.press("j");
    await flush();
    expect(h.ran).toEqual(["test.jump"]);
  });

  test("Ctrl+C in an input passes through, with the quit hint", async () => {
    const h = await setup();
    await h.focusInput();
    await h.tui.type("ab");
    await h.tui.press("ctrl+c");
    expect(h.hints.current?.text).toBe("Quit with Ctrl+Q");
    expect(h.input.value).toBe("ab");
  });
});

describe("overlay layer", () => {
  test("a modal overlay sees keys first and captures what it does not use", async () => {
    const h = await setup();
    await h.focusTerminal();
    const seen: string[] = [];
    h.overlays.push({
      id: "test",
      modal: true,
      handleKey: (stroke: KeyStroke) => {
        seen.push(stroke.key);
        return stroke.key === "down";
      },
      dismiss: () => {},
    });
    await h.tui.press("down");
    await h.tui.press("x");
    await h.tui.press("f1");
    await h.tui.press("ctrl+r");
    await flush();
    expect(seen).toEqual(["down", "x", "f1", "r"]);
    // Nothing leaked: no command, and the terminal underneath received nothing.
    expect(h.ran).toEqual([]);
    expect(h.terminal.received).toEqual([]);
  });

  test("an overlay that accepts text lets keys reach its focused input", async () => {
    const h = await setup();
    await h.focusInput();
    h.overlays.push({
      id: "picker",
      modal: true,
      acceptsText: true,
      handleKey: () => false,
      dismiss: () => {},
    });
    await h.tui.type("ab");
    await h.tui.press("ctrl+p");
    await flush();
    expect(h.input.value).toBe("ab");
    // Bindings are not consulted while a modal is open.
    expect(h.ran).toEqual([]);
  });

  test("without an input focused, an overlay that accepts text still captures", async () => {
    const h = await setup();
    await h.blurAll();
    h.overlays.push({ id: "picker", modal: true, acceptsText: true, dismiss: () => {} });
    await h.tui.press("j");
    await flush();
    expect(h.ran).toEqual([]);
  });

  test("a non-modal overlay lets unhandled keys continue to the bindings", async () => {
    const h = await setup();
    await h.blurAll();
    h.overlays.push({ id: "toast", modal: false, handleKey: () => false, dismiss: () => {} });
    await h.tui.press("ctrl+p");
    await flush();
    expect(h.ran).toEqual(["file.quickOpen"]);
  });
});

describe("zone layer and reserved keys", () => {
  test("the focused zone's handler receives unbound keys", async () => {
    const h = await setup();
    await h.blurAll();
    const seen: string[] = [];
    h.focus.registerKeyHandler("editor", (stroke) => {
      seen.push(stroke.key);
      return stroke.key === "down";
    });
    h.focus.registerKeyHandler("sidebar", () => {
      seen.push("sidebar");
      return true;
    });
    await h.tui.press("down");
    await h.tui.press("q");
    // Bound keys are taken by the bindings before the zone sees them.
    await h.tui.press("ctrl+p");
    await flush();
    expect(seen).toEqual(["down", "q"]);
    expect(h.ran).toEqual(["file.quickOpen"]);
  });

  test("Ctrl+Z outside a terminal suspends; Ctrl+C shows the quit hint and is consumed", async () => {
    const h = await setup();
    await h.blurAll();
    const seen: string[] = [];
    h.focus.registerKeyHandler("editor", (stroke) => {
      seen.push(stroke.key);
      return false;
    });
    await h.tui.press("ctrl+z");
    expect(h.suspended).toBe(1);
    await h.tui.press("ctrl+c");
    expect(h.hints.current?.text).toContain("Quit");
    expect(seen).toEqual([]);
  });

  test("a focus change cancels a pending sequence", async () => {
    const h = await setup();
    await h.blurAll();
    await h.tui.press("ctrl+k");
    expect(h.hints.current?.text).toContain("Ctrl+K");
    h.focus.focus("sidebar");
    expect(h.hints.current).toBeNull();
    await h.tui.press("z");
    await flush();
    expect(h.ran).toEqual([]);
  });

  test("dispose removes the router", async () => {
    const h = await setup();
    await h.blurAll();
    h.router.dispose();
    await h.tui.press("ctrl+p");
    await flush();
    expect(h.ran).toEqual([]);
  });
});
