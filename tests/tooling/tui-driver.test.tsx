import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/react";
import { useEffect, useState } from "react";
import { mountTui, parseKeyChord, type Tui } from "../helpers/tui";

function Counter({ delayMs = 50 }: { delayMs?: number }) {
  const [count, setCount] = useState(0);
  const [typed, setTyped] = useState("");
  const [pasted, setPasted] = useState("");
  const [lastKey, setLastKey] = useState("none");
  const [scrolls, setScrolls] = useState(0);
  const [ready, setReady] = useState(false);
  const { width, height } = useTerminalDimensions();

  useKeyboard((key) => {
    if (key.name === "+") setCount((n) => n + 1);
    if (key.name === "-") setCount((n) => n - 1);
    if (key.ctrl && key.shift && key.name === "r") setCount(0);
    const mods = `${key.ctrl ? "ctrl+" : ""}${key.shift ? "shift+" : ""}${key.meta ? "meta+" : ""}`;
    setLastKey(`${mods}${key.name}`);
  });
  usePaste((event) => setPasted(new TextDecoder().decode(event.bytes)));
  useEffect(() => {
    const id = setTimeout(() => setReady(true), delayMs);
    return () => clearTimeout(id);
  }, [delayMs]);

  return (
    <box flexDirection="column" width="100%" height="100%" onMouseScroll={() => setScrolls((n) => n + 1)}>
      <text>{`count=${count} last=${lastKey}`}</text>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: an OpenTUI <box>, not a DOM element. */}
      <box height={1} width={9} onMouseDown={() => setCount((n) => n + 10)}>
        <text>[ +10 ]</text>
      </box>
      <input focused width={30} onInput={setTyped} />
      <text>{`typed=${typed}`}</text>
      <text>{`pasted=${pasted}`}</text>
      <text>{`size=${width}x${height} scrolls=${scrolls}`}</text>
      <text>{ready ? "status: ready" : "status: loading"}</text>
      <text>漢字 target</text>
    </box>
  );
}

/** Exposes its state setter, standing in for a store updated from outside React input. */
let setExternal: ((n: number) => void) | null = null;
function ExternalStore() {
  const [n, setN] = useState(0);
  setExternal = setN;
  return <text>{`n=${n}`}</text>;
}

describe("parseKeyChord", () => {
  test("splits modifiers and keys", () => {
    expect(parseKeyChord("a")).toEqual({ key: "a", modifiers: {} });
    expect(parseKeyChord("+")).toEqual({ key: "+", modifiers: {} });
    expect(parseKeyChord("ctrl+shift+p")).toEqual({ key: "p", modifiers: { ctrl: true, shift: true } });
    expect(parseKeyChord("ctrl++")).toEqual({ key: "+", modifiers: { ctrl: true } });
    expect(parseKeyChord("cmd+s")).toEqual({ key: "s", modifiers: { super: true } });
    expect(() => parseKeyChord("hyperdrive+x")).toThrow("Unknown modifier");
  });
});

describe("mountTui", () => {
  let errors: ReturnType<typeof spyOn<Console, "error">>;
  beforeEach(() => {
    errors = spyOn(console, "error");
  });
  afterEach(() => {
    // The whole point of the driver: normal use never produces React act() warnings.
    const actWarnings = errors.mock.calls
      .map((args) => args.map(String).join(" "))
      .filter((m) => m.includes("act("));
    errors.mockRestore();
    expect(actWarnings).toEqual([]);
  });

  test("renders at the default size with the first frame ready", async () => {
    const tui = await mountTui(<Counter />);
    expect(tui.frame()).toContain("count=0");
    expect(tui.frame()).toContain("size=120x35");
    expect(tui.spans().cols).toBe(120);
    expect(tui.spans().rows).toBe(35);
  });

  test("press: characters, chords and named keys, with modifiers preserved by kitty encoding", async () => {
    const tui = await mountTui(<Counter />, { width: 60, height: 12 });
    await tui.press("+");
    await tui.press("+");
    expect(tui.frame()).toContain("count=2 last=+");
    await tui.press("ctrl+shift+r");
    expect(tui.frame()).toContain("count=0 last=ctrl+shift+r");
    await tui.press("pagedown");
    expect(tui.frame()).toContain("last=pagedown");
    await tui.press("f5");
    expect(tui.frame()).toContain("last=f5");
    await tui.press("escape");
    expect(tui.frame()).toContain("last=escape");
    await tui.press("x", { alt: true });
    expect(tui.frame()).toContain("last=meta+x");
  });

  test("press: a lone Escape works in legacy keyboard mode", async () => {
    const tui = await mountTui(<Counter />, { width: 60, height: 12, kittyKeyboard: false });
    await tui.press("escape");
    expect(tui.frame()).toContain("last=escape");
  });

  test("type and paste reach the focused input, Turkish letters and emoji intact", async () => {
    const tui = await mountTui(<Counter />, { width: 60, height: 12 });
    await tui.type("Çalış ğüİ 👍");
    expect(tui.frame()).toContain("typed=Çalış ğüİ 👍");
    await tui.paste("from the clipboard");
    expect(tui.frame()).toContain("pasted=from the clipboard");
  });

  test("click, findText and clickText hit the right cells", async () => {
    const tui = await mountTui(<Counter />, { width: 60, height: 12 });
    expect(tui.findText("[ +10 ]")).toEqual({ x: 0, y: 1 });
    // Two wide glyphs and a space precede "target": its first cell is column 5.
    expect(tui.findText("target")).toEqual({ x: 5, y: 7 });
    expect(tui.findText("not on screen")).toBeNull();
    await tui.click(2, 1);
    expect(tui.frame()).toContain("count=10");
    await tui.clickText("+10");
    expect(tui.frame()).toContain("count=20");
    await expect(tui.clickText("missing label")).rejects.toThrow("is not on screen");
  });

  test("scroll, drag and double click are delivered", async () => {
    const tui = await mountTui(<Counter />, { width: 60, height: 12 });
    await tui.scroll(10, 9, "down", 3);
    expect(tui.frame()).toContain("scrolls=3");
    await tui.doubleClick(2, 1);
    expect(tui.frame()).toContain("count=20");
    await tui.drag(0, 0, 5, 0);
    await tui.hover(1, 1);
  });

  test("resize relayouts and updates useTerminalDimensions", async () => {
    const tui = await mountTui(<Counter />, { width: 60, height: 12 });
    await tui.resize(80, 20);
    expect(tui.frame()).toContain("size=80x20");
    expect(tui.spans().cols).toBe(80);
  });

  test("waitForText waits for real timers; advance lets them run", async () => {
    const tui = await mountTui(<Counter delayMs={120} />, { width: 60, height: 12 });
    expect(tui.frame()).toContain("status: loading");
    const frame = await tui.waitForText("status: ready", { timeoutMs: 2000 });
    expect(frame).toContain("status: ready");

    const second = await mountTui(<Counter delayMs={40} />, { width: 60, height: 12 });
    await second.advance(80);
    expect(second.frame()).toContain("status: ready");
    expect(await second.waitForText(/count=\d+/)).toContain("count=0");
  });

  test("waitForText times out with the last frame in the message", async () => {
    const tui = await mountTui(<Counter delayMs={10_000} />, { width: 40, height: 9 });
    await expect(tui.waitForText("never shown", { timeoutMs: 100 })).rejects.toThrow(
      /Timed out after 100 ms waiting for never shown\. Last frame:\n.*count=0/s,
    );
  });

  test("act() runs state changes from outside React input and settles", async () => {
    const tui = await mountTui(<ExternalStore />, { width: 20, height: 2 });
    await tui.act(() => setExternal?.(7));
    expect(tui.frame()).toContain("n=7");
  });

  test("only the act warning is filtered; other console.error output still reaches the console", async () => {
    await mountTui(<Counter />, { width: 40, height: 9 });
    console.error("a real problem");
    console.error("An update to X inside a test was not wrapped in act(...).");
    const messages = errors.mock.calls.map((args) => String(args[0]));
    expect(messages).toContain("a real problem");
    expect(messages.some((m) => m.includes("not wrapped in act("))).toBe(false);
  });

  test("dispose is idempotent and further input is rejected", async () => {
    const tui = await mountTui(<Counter />, { width: 40, height: 9 });
    await tui.dispose();
    await tui.dispose();
    expect(tui.renderer.isDestroyed).toBe(true);
    await expect(tui.press("+")).rejects.toThrow("disposed");
  });
});

describe("automatic cleanup", () => {
  let leaked: Tui | null = null;

  test("a test may end without disposing its TUI", async () => {
    leaked = await mountTui(<Counter />, { width: 40, height: 9 });
    expect(leaked.renderer.isDestroyed).toBe(false);
  });

  test("the preload disposed it after that test", () => {
    expect(leaked?.renderer.isDestroyed).toBe(true);
    const live = (globalThis as unknown as Record<symbol, Set<unknown> | undefined>)[
      Symbol.for("lucy.tests.liveTuis")
    ];
    expect(live?.size ?? 0).toBe(0);
  });
});

describe("test isolation (preload)", () => {
  test("config, state, cache and data directories point into one temp directory", () => {
    const root = process.env.LUCY_TEST_ROOT;
    expect(root).toBeTruthy();
    for (const name of ["XDG_DATA_HOME", "LUCY_CONFIG_DIR", "LUCY_STATE_DIR", "LUCY_CACHE_DIR"]) {
      expect(process.env[name]?.startsWith(`${root}/`)).toBe(true);
    }
  });
});
