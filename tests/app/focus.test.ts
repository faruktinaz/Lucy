import { describe, expect, test } from "bun:test";
import { FocusService, type FocusZone } from "@/app/workbench/focus";
import { ContextKeys } from "@/core/keybindings";
import { keyStroke } from "@/core/keybindings/key-stroke";

function createFocus(available: readonly FocusZone[] = ["sidebar", "editor", "bottom", "auxiliary"]) {
  const contextKeys = new ContextKeys();
  const focus = new FocusService(contextKeys);
  const visible = new Set<FocusZone>(available);
  focus.setLayout({
    isAvailable: (zone) => visible.has(zone),
    order: () => ["sidebar", "editor", "bottom", "auxiliary"],
    columns: () => [["sidebar"], ["editor", "bottom"], ["auxiliary"]],
  });
  let released = 0;
  focus.setRenderableFocusReleaser(() => {
    released++;
  });
  return { focus, contextKeys, visible, released: () => released };
}

const typing = { inputFocused: false, typing: false };

describe("FocusService", () => {
  test("starts on the editor and focuses available zones only", () => {
    const { focus, visible } = createFocus(["sidebar", "editor"]);
    expect(focus.current).toBe("editor");
    expect(focus.focus("sidebar")).toBe(true);
    expect(focus.current).toBe("sidebar");
    expect(focus.focus("bottom")).toBe(false);
    expect(focus.current).toBe("sidebar");
    // The editor is always available, whatever the layout says.
    visible.delete("editor");
    expect(focus.focus("editor")).toBe(true);
  });

  test("next and previous cycle through available zones in reading order", () => {
    const { focus } = createFocus(["sidebar", "editor", "auxiliary"]);
    const order: FocusZone[] = [];
    for (let i = 0; i < 4; i++) order.push(focus.next());
    expect(order).toEqual(["auxiliary", "sidebar", "editor", "auxiliary"]);
    expect(focus.previous()).toBe("editor");
    expect(focus.previous()).toBe("sidebar");
  });

  test("move() goes to the neighbouring column or row", () => {
    const { focus } = createFocus();
    expect(focus.move("left")).toBe(true);
    expect(focus.current).toBe("sidebar");
    expect(focus.move("left")).toBe(false);
    expect(focus.move("right")).toBe(true);
    expect(focus.current).toBe("editor");
    expect(focus.move("down")).toBe(true);
    expect(focus.current).toBe("bottom");
    expect(focus.move("down")).toBe(false);
    expect(focus.move("right")).toBe(true);
    expect(focus.current).toBe("auxiliary");
    expect(focus.move("left")).toBe(true);
    expect(focus.current).toBe("editor");
    focus.focus("bottom");
    expect(focus.move("up")).toBe(true);
    expect(focus.current).toBe("editor");
  });

  test("move() skips hidden zones", () => {
    const { focus } = createFocus(["editor", "auxiliary"]);
    expect(focus.move("left")).toBe(false);
    expect(focus.move("down")).toBe(false);
    expect(focus.move("right")).toBe(true);
    expect(focus.current).toBe("auxiliary");
  });

  test("sets the focus context keys", () => {
    const { focus, contextKeys } = createFocus();
    expect(contextKeys.get("editorFocus")).toBe(true);
    expect(contextKeys.get("focusedZone")).toBe("editor");
    focus.focus("bottom");
    expect(contextKeys.snapshot()).toMatchObject({
      focusedZone: "bottom",
      editorFocus: false,
      sidebarFocus: false,
      auxiliaryFocus: false,
      panelFocus: true,
    });
  });

  test("emits changes once per actual change", () => {
    const { focus } = createFocus();
    const events: string[] = [];
    focus.onDidChange(({ zone, previous }) => events.push(`${previous}->${zone}`));
    focus.focus("sidebar");
    focus.focus("sidebar");
    focus.focus("editor");
    expect(events).toEqual(["editor->sidebar", "sidebar->editor"]);
  });

  test("the newest focus target of a zone receives renderable focus", () => {
    const { focus, released } = createFocus();
    const calls: string[] = [];
    const first = focus.registerFocusTarget("sidebar", { focus: () => calls.push("first") });
    focus.registerFocusTarget("sidebar", { focus: () => calls.push("second") });
    focus.focus("sidebar");
    expect(calls).toEqual(["second"]);
    focus.focus("editor");
    // The editor has no target: renderable focus is released.
    expect(released()).toBe(1);
    first.dispose();
    focus.focus("sidebar");
    expect(calls).toEqual(["second", "second"]);
    focus.restore();
    expect(calls).toEqual(["second", "second", "second"]);
  });

  test("a target registered in the focused zone is focused at once", () => {
    const { focus } = createFocus();
    focus.focus("bottom");
    let focused = false;
    focus.registerFocusTarget("bottom", {
      focus: () => {
        focused = true;
      },
    });
    expect(focused).toBe(true);
  });

  test("key handlers: newest first, fall through on false, only for the focused zone", () => {
    const { focus } = createFocus();
    const seen: string[] = [];
    focus.registerKeyHandler("editor", (stroke) => {
      seen.push(`old:${stroke.key}`);
      return stroke.key === "a";
    });
    const newer = focus.registerKeyHandler("editor", (stroke) => {
      seen.push(`new:${stroke.key}`);
      return stroke.key === "b";
    });
    focus.registerKeyHandler("sidebar", () => {
      seen.push("sidebar");
      return true;
    });

    expect(focus.handleKey(keyStroke("b"), typing)).toBe(true);
    expect(seen).toEqual(["new:b"]);
    seen.length = 0;
    expect(focus.handleKey(keyStroke("a"), typing)).toBe(true);
    expect(seen).toEqual(["new:a", "old:a"]);
    seen.length = 0;
    expect(focus.handleKey(keyStroke("c"), typing)).toBe(false);
    newer.dispose();
    seen.length = 0;
    focus.handleKey(keyStroke("b"), typing);
    expect(seen).toEqual(["old:b"]);
  });

  test("with an input focused only opted-in handlers run, and never for typing keys", () => {
    const { focus } = createFocus();
    const seen: string[] = [];
    focus.registerKeyHandler("editor", (stroke) => {
      seen.push(`plain:${stroke.key}`);
      return false;
    });
    focus.registerKeyHandler(
      "editor",
      (stroke) => {
        seen.push(`input:${stroke.key}`);
        return false;
      },
      { whileInputFocused: true },
    );
    focus.handleKey(keyStroke("down"), { inputFocused: true, typing: false });
    expect(seen).toEqual(["input:down"]);
    seen.length = 0;
    focus.handleKey(keyStroke("j"), { inputFocused: true, typing: true });
    expect(seen).toEqual([]);
    focus.handleKey(keyStroke("j"), { inputFocused: false, typing: true });
    expect(seen).toEqual(["input:j", "plain:j"]);
  });

  test("dispose drops handlers and targets", () => {
    const { focus } = createFocus();
    let calls = 0;
    focus.registerKeyHandler("editor", () => {
      calls++;
      return true;
    });
    focus.dispose();
    expect(focus.handleKey(keyStroke("x"), typing)).toBe(false);
    expect(calls).toBe(0);
  });
});
