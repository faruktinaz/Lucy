/**
 * TUI test driver over OpenTUI's `testRender`, with the `act()` discipline built in.
 *
 *   const tui = await mountTui(<App />);
 *   await tui.press("ctrl+p");
 *   await tui.type("readme");
 *   await tui.waitForText("README.md");
 *   await tui.clickText("README.md");
 *   expect(tui.frame()).toContain("# Lucy");
 *
 * Every input method sends its input inside `act()` and then `settle()`s: React work is
 * committed and frames are rendered until the screen is visually idle, so `frame()` is current
 * as soon as the call returns. Mounted TUIs are disposed automatically after each test by the
 * preload (`tests/setup.ts`), even when the test fails; `dispose()` is still fine to call.
 *
 * Remaining gotchas:
 * - Focus moves through React state are only committed when an `act()` ends. Change focus in
 *   its own call (e.g. one `press`), then send the keys meant for the new focus in the next.
 * - Without the kitty keyboard protocol (`kittyKeyboard: false`) a lone Escape is held about
 *   20 ms by the parser; `press("escape")` waits for that, raw `setup.mockInput` use does not.
 * - Syntax highlighting (`<code>`, `<diff>`, `<markdown>`) is asynchronous: use `waitForText`
 *   or await the renderable's `highlightingDone` before asserting on colors.
 * - Timers only run while the test awaits. A component that updates on a timer needs
 *   `advance(ms)` or `waitForText(...)` before its result is on screen.
 * - While a TUI is mounted, React's "An update to X inside a test was not wrapped in act(...)"
 *   warning is suppressed (all other console.error output passes through). Timers inevitably
 *   fire outside an act scope (React ends every async `act()` with a macrotask after its scope
 *   has closed, and a test can end while a debounce is pending); the update is still processed,
 *   and the driver settles before every read, so the warning carries no information here.
 * - Frames are only rendered by the driver. After changing state from outside React input
 *   (a store, an event emitter), call `settle()` before reading the frame.
 */
import type { CapturedFrame } from "@opentui/core";
import type { KeyInput, TestRendererOptions, TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { type ReactNode, act as reactAct } from "react";
import { findTextInFrame, graphemes } from "../../scripts/screenshot/cells";

export interface MountOptions {
  /** Columns. Default 120. */
  width?: number;
  /** Rows. Default 35. */
  height?: number;
  /** Encode keys with the kitty protocol, so every modifier survives (ctrl+shift+p, super+s). Default true. */
  kittyKeyboard?: boolean;
  /** Any other `createTestRenderer` options. */
  renderer?: Omit<TestRendererOptions, "width" | "height" | "kittyKeyboard">;
}

export interface KeyModifiers {
  ctrl?: boolean;
  shift?: boolean;
  /** Alt/Option; OpenTUI reports it as `meta`. */
  alt?: boolean;
  meta?: boolean;
  /** Cmd on macOS (kitty protocol only). */
  super?: boolean;
  hyper?: boolean;
}

export type MouseButtonName = "left" | "middle" | "right";
export type ScrollDirection = "up" | "down" | "left" | "right";

export interface MouseOptions {
  button?: MouseButtonName;
  modifiers?: { shift?: boolean; alt?: boolean; ctrl?: boolean };
}

export interface WaitForTextOptions {
  /** Real time to wait. Default 2000 ms. */
  timeoutMs?: number;
  /** Real time between checks. Default 10 ms. */
  intervalMs?: number;
}

export interface CellPosition {
  x: number;
  y: number;
}

export interface Tui {
  renderer: TestRendererSetup["renderer"];
  /** The raw test setup, for anything the driver does not cover. Wrap direct input in `act()`. */
  setup: TestRendererSetup;
  /** The screen as text, rows joined with "\n". */
  frame(): string;
  /** The screen with colors and attributes (input for the screenshot library). */
  spans(): CapturedFrame;
  /**
   * Presses one key: a character ("a", "İ"), a name ("enter", "escape", "tab", "backspace", "delete",
   * "up", "pageup", "home", "f5", "space", ...) or a chord ("ctrl+p", "ctrl+shift+p", "alt+x").
   */
  press(key: string, modifiers?: KeyModifiers): Promise<void>;
  /** Types text as individual key presses (grapheme by grapheme, so emoji and Turkish letters survive). */
  type(text: string): Promise<void>;
  /** Sends text as one bracketed paste. */
  paste(text: string): Promise<void>;
  click(x: number, y: number, options?: MouseOptions): Promise<void>;
  doubleClick(x: number, y: number, options?: MouseOptions): Promise<void>;
  drag(x1: number, y1: number, x2: number, y2: number, options?: MouseOptions): Promise<void>;
  /** Moves the pointer (hover). */
  hover(x: number, y: number): Promise<void>;
  scroll(x: number, y: number, direction: ScrollDirection, times?: number): Promise<void>;
  /** Clicks the first cell of the first occurrence of `text`; throws when it is not on screen. */
  clickText(text: string, options?: MouseOptions): Promise<void>;
  resize(width: number, height: number): Promise<void>;
  /** Commits pending React work and renders until the screen is visually idle. */
  settle(): Promise<void>;
  /** Lets real timers run for `ms` inside `act()`, then settles. */
  advance(ms: number): Promise<void>;
  /** Polls in real time (unlike OpenTUI's `waitFor`, which only advances frames). Returns the frame. */
  waitForText(target: string | RegExp, options?: WaitForTextOptions): Promise<string>;
  /** Cell position of the first occurrence of `text` (wide glyphs accounted for), or null. */
  findText(text: string): CellPosition | null;
  /** Runs `fn` inside `act()` (for direct state changes), then settles. */
  act<T>(fn: () => T | Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}

/** Shared with `tests/setup.ts`, which disposes every live TUI after each test. */
const LIVE_KEY = Symbol.for("lucy.tests.liveTuis");
type LiveSet = Set<() => Promise<void>>;

function liveTuis(): LiveSet {
  const holder = globalThis as unknown as Record<symbol, LiveSet | undefined>;
  let set = holder[LIVE_KEY];
  if (!set) {
    set = new Set();
    holder[LIVE_KEY] = set;
  }
  return set;
}

function setActEnvironment(enabled: boolean): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = enabled;
}

/** Disposes every TUI still mounted. The preload calls this after each test. */
export async function disposeAllTuis(): Promise<void> {
  for (const dispose of [...liveTuis()]) await dispose();
}

const NAMED_KEYS: Record<string, KeyInput> = {
  enter: "RETURN",
  return: "RETURN",
  escape: "ESCAPE",
  esc: "ESCAPE",
  tab: "TAB",
  backspace: "BACKSPACE",
  delete: "DELETE",
  home: "HOME",
  end: "END",
  up: "ARROW_UP",
  down: "ARROW_DOWN",
  left: "ARROW_LEFT",
  right: "ARROW_RIGHT",
  space: " ",
  // Not in OpenTUI's KeyCodes; legacy sequences work in both modes because CSI ~ keys are always parsed.
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  insert: "\x1b[2~",
};
for (let n = 1; n <= 12; n++) NAMED_KEYS[`f${n}`] = `F${n}` as KeyInput;

const MODIFIER_NAMES: Record<string, keyof KeyModifiers> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  opt: "alt",
  meta: "meta",
  super: "super",
  cmd: "super",
  hyper: "hyper",
};

/** Splits "ctrl+shift+p" into a key and modifiers. A literal "+" is written "+" or "ctrl++". */
export function parseKeyChord(chord: string): { key: string; modifiers: KeyModifiers } {
  if (chord.length <= 1 || !chord.includes("+")) return { key: chord, modifiers: {} };
  const parts = chord.split("+");
  let key = parts.pop() ?? "";
  if (key === "" && parts[parts.length - 1] === "") {
    parts.pop();
    key = "+";
  }
  const modifiers: KeyModifiers = {};
  for (const part of parts) {
    const name = MODIFIER_NAMES[part.toLowerCase()];
    if (!name) throw new Error(`Unknown modifier "${part}" in key chord "${chord}"`);
    modifiers[name] = true;
  }
  return { key, modifiers };
}

function resolveKey(key: string): KeyInput {
  if ([...key].length === 1) return key;
  const named = NAMED_KEYS[key.toLowerCase()];
  if (named === undefined) throw new Error(`Unknown key "${key}"`);
  return named;
}

/**
 * Drops React's "not wrapped in act(...)" warning while TUIs are mounted (see the header comment).
 * The filter checks the live set itself, so if a test's console spy restores it after the last
 * TUI is gone it simply passes everything through.
 */
let consoleErrorBeforeFilter: typeof console.error | null = null;
const actWarningFilter: typeof console.error = (...args: unknown[]) => {
  const first = args[0];
  if (liveTuis().size > 0 && typeof first === "string" && first.includes("not wrapped in act(")) return;
  (consoleErrorBeforeFilter ?? console.log)(...args);
};

function track(dispose: () => Promise<void>): void {
  liveTuis().add(dispose);
  if (console.error !== actWarningFilter) {
    consoleErrorBeforeFilter = console.error;
    console.error = actWarningFilter;
  }
}

function untrack(dispose: () => Promise<void>): void {
  liveTuis().delete(dispose);
  if (liveTuis().size === 0 && console.error === actWarningFilter && consoleErrorBeforeFilter) {
    console.error = consoleErrorBeforeFilter;
  }
}

const BUTTONS = { left: 0, middle: 1, right: 2 } as const;
const LEGACY_ESCAPE_DELAY_MS = 30;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function mountTui(node: ReactNode, options: MountOptions = {}): Promise<Tui> {
  const kittyKeyboard = options.kittyKeyboard ?? true;
  const setup = await testRender(node, {
    ...options.renderer,
    width: options.width ?? 120,
    height: options.height ?? 35,
    kittyKeyboard,
  });
  const { renderer, mockInput, mockMouse } = setup;
  let disposed = false;

  const settle = async (): Promise<void> => {
    for (let pass = 0; pass < 10 && !renderer.isDestroyed; pass++) {
      try {
        await reactAct(async () => {
          await setup.flush();
        });
      } catch (error) {
        // A screen that animates forever never becomes idle; its latest frame is still valid.
        if (error instanceof Error && error.message.startsWith("Timed out waiting for visual idle")) return;
        throw error;
      }
      const scheduler = renderer.getSchedulerState();
      if (!scheduler.isRendering && !scheduler.hasScheduledRender) return;
    }
  };

  const input = async (send: () => void | Promise<void>): Promise<void> => {
    if (disposed) throw new Error("This TUI has been disposed");
    await reactAct(async () => {
      await send();
    });
    await settle();
  };

  const mouseOptions = (options?: MouseOptions) => ({
    button: BUTTONS[options?.button ?? "left"],
    modifiers: options?.modifiers,
  });

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    try {
      await reactAct(async () => {
        await setup.dispose();
      });
    } finally {
      untrack(dispose);
      // testRender clears the act flag on destroy; other TUIs mounted in this test still need it.
      if (liveTuis().size > 0) setActEnvironment(true);
    }
  };
  track(dispose);

  const tui: Tui = {
    renderer,
    setup,
    frame: () => setup.captureCharFrame(),
    spans: () => setup.captureSpans(),
    press: (key, modifiers) =>
      input(async () => {
        const chord = parseKeyChord(key);
        const merged = { ...chord.modifiers, ...modifiers };
        const keyInput = resolveKey(chord.key);
        const { alt, ...rest } = merged;
        const mods = { ...rest, meta: rest.meta || alt };
        const hasModifier = Object.values(mods).some(Boolean);
        mockInput.pressKey(keyInput, hasModifier ? mods : undefined);
        if (!kittyKeyboard && keyInput === "ESCAPE") await sleep(LEGACY_ESCAPE_DELAY_MS);
      }),
    type: (text) =>
      input(() => {
        for (const grapheme of graphemes(text)) renderer.stdin.emit("data", Buffer.from(grapheme));
      }),
    paste: (text) => input(() => mockInput.pasteBracketedText(text)),
    click: (x, y, options) =>
      input(() => {
        const { button, modifiers } = mouseOptions(options);
        return mockMouse.click(x, y, button, { modifiers });
      }),
    doubleClick: (x, y, options) =>
      input(() => {
        const { button, modifiers } = mouseOptions(options);
        return mockMouse.doubleClick(x, y, button, { modifiers });
      }),
    drag: (x1, y1, x2, y2, options) =>
      input(() => {
        const { button, modifiers } = mouseOptions(options);
        return mockMouse.drag(x1, y1, x2, y2, button, { modifiers });
      }),
    hover: (x, y) => input(() => mockMouse.moveTo(x, y)),
    scroll: (x, y, direction, times = 1) =>
      input(async () => {
        for (let i = 0; i < times; i++) await mockMouse.scroll(x, y, direction);
      }),
    clickText: async (text, options) => {
      const position = findTextInFrame(setup.captureSpans(), text);
      if (!position) throw new Error(`"${text}" is not on screen:\n${setup.captureCharFrame()}`);
      await tui.click(position.x, position.y, options);
    },
    resize: (width, height) => input(() => setup.resize(width, height)),
    settle,
    advance: (ms) => input(() => sleep(ms)),
    waitForText: async (target, waitOptions = {}) => {
      const timeoutMs = waitOptions.timeoutMs ?? 2000;
      const intervalMs = waitOptions.intervalMs ?? 10;
      const matches = (frame: string) =>
        typeof target === "string" ? frame.includes(target) : target.test(frame);
      const deadline = performance.now() + timeoutMs;
      while (true) {
        await settle();
        const frame = setup.captureCharFrame();
        if (matches(frame)) return frame;
        if (performance.now() >= deadline) {
          throw new Error(
            `Timed out after ${timeoutMs} ms waiting for ${String(target)}. Last frame:\n${frame}`,
          );
        }
        await reactAct(() => sleep(intervalMs));
      }
    },
    findText: (text) => findTextInFrame(setup.captureSpans(), text),
    act: async <T,>(fn: () => T | Promise<T>): Promise<T> => {
      let result: T | undefined;
      await reactAct(async () => {
        result = await fn();
      });
      await settle();
      return result as T;
    },
    dispose,
  };

  await input(() => setup.renderOnce());
  return tui;
}
