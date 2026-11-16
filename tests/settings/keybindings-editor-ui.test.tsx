/** The Keyboard Shortcuts editor through the real UI: search, capture, conflicts, refusal, remove, reset. */
import { describe, expect, test } from "bun:test";
import { settingsServices } from "@/features/settings";
import { type MountedApp, mountApp } from "../helpers/app";
import { normalizeFrame } from "./helpers";

async function openShortcuts(app: MountedApp, query?: string): Promise<void> {
  await app.tui.act(() => app.ctx.commands.execute("keybindings.open"));
  if (query) await app.tui.type(query);
}

const sidebarVisible = (app: MountedApp) => app.ctx.layout.state.sidebar.visible;

/** Saving is asynchronous: the capture card closes once the file is written. */
async function untilClosed(app: MountedApp): Promise<void> {
  const deadline = performance.now() + 3000;
  while (app.ctx.overlays.layers.length > 0) {
    if (performance.now() > deadline) throw new Error("The capture card did not close");
    await app.tui.advance(20);
  }
}
const bindings = async (app: MountedApp) => {
  await app.ctx.config.flush();
  return app.ctx.config.get("keybindings.bindings");
};

describe("Keyboard Shortcuts editor", () => {
  test("keybindings.open opens the editor tab (replacing the simple list)", async () => {
    const app = await mountApp({ width: 120, height: 35 });
    await openShortcuts(app);
    expect(app.ctx.editors.active?.kind).toBe("keybindings");
    const frame = app.tui.frame();
    expect(frame).toContain("Shortcuts");
    expect(frame).toContain("commands");
  });

  test("search by title, id or chord", async () => {
    const app = await mountApp({ width: 120, height: 35 });
    await openShortcuts(app, "ctrl+b");
    const vm = settingsServices(app.ctx).keybindings();
    expect(vm.state.rows.some((r) => r.type === "command" && r.id === "view.toggleSidebar")).toBe(true);
    expect(vm.state.rows.some((r) => r.type === "command" && r.id === "file.quickOpen")).toBe(false);
    for (let i = 0; i < 6; i++) await app.tui.press("backspace");
    await app.tui.type("view.toggleSidebar");
    expect(
      vm.state.rows.filter((r) => r.type === "command").map((r) => (r.type === "command" ? r.id : "")),
    ).toEqual(["view.toggleSidebar"]);
  });

  test("a remapped command fires on the new chord and no longer on the old one", async () => {
    const app = await mountApp({ width: 120, height: 35 });
    await openShortcuts(app, "toggle sidebar");
    await app.tui.press("down");
    const before = sidebarVisible(app);
    await app.tui.press("ctrl+b");
    expect(sidebarVisible(app)).toBe(!before);
    await app.tui.press("ctrl+b");
    expect(sidebarVisible(app)).toBe(before);

    // Enter on the Ctrl+B chip changes it.
    await app.tui.press("enter");
    await app.tui.waitForText("Press the desired key combination");
    await app.tui.press("f9");
    await app.tui.press("enter");
    await app.tui.waitForText("Review the shortcut");
    await app.tui.press("enter");
    await untilClosed(app);
    expect(await bindings(app)).toEqual({ "view.toggleSidebar": "f9" });

    await app.tui.press("f9");
    expect(sidebarVisible(app)).toBe(!before);
    await app.tui.press("ctrl+b");
    expect(sidebarVisible(app)).toBe(!before);
    await app.tui.press("f9");
    expect(sidebarVisible(app)).toBe(before);
  });

  test("capture records a two-step sequence; Escape cancels", async () => {
    const app = await mountApp({ width: 120, height: 35 });
    await openShortcuts(app, "toggle sidebar");
    await app.tui.press("down");
    await app.tui.press("+");
    await app.tui.press("ctrl+k");
    await app.tui.waitForText("Enter to use Ctrl+K");
    await app.tui.press("x");
    const frame = await app.tui.waitForText("Review the shortcut");
    expect(frame).toContain("Ctrl+K X");
    await app.tui.press("escape");
    expect(app.ctx.overlays.layers.map((l) => l.id)).toEqual([]);
    expect(await bindings(app)).toEqual({});
  });

  test("a conflict is shown before saving; Replace moves the chord", async () => {
    const app = await mountApp({ width: 120, height: 35 });
    await openShortcuts(app, "toggle sidebar");
    await app.tui.press("down");
    await app.tui.press("+");
    await app.tui.press("ctrl+p");
    await app.tui.press("enter");
    const frame = await app.tui.waitForText("already runs");
    expect(frame).toContain("Go to File");
    expect(frame).toContain("Replace");
    await app.tui.press("enter");
    await untilClosed(app);
    expect(await bindings(app)).toEqual({
      "view.toggleSidebar": ["ctrl+b", "ctrl+p"],
      "file.quickOpen": false,
    });
    const before = sidebarVisible(app);
    await app.tui.press("ctrl+p");
    expect(sidebarVisible(app)).toBe(!before);
    expect(app.ctx.quickPick.state.open).toBe(false);
  });

  test("reserved chords are refused with the reason", async () => {
    const app = await mountApp({ width: 120, height: 35 });
    await openShortcuts(app, "toggle sidebar");
    await app.tui.press("down");
    await app.tui.press("+");
    await app.tui.press("ctrl+c");
    await app.tui.press("enter");
    const frame = await app.tui.waitForText("cannot be used");
    expect(frame).toContain("interrupt");
    expect(frame).not.toContain(" Save ");
    await app.tui.press("escape");
    expect(await bindings(app)).toEqual({});
  });

  test("remove a shortcut with Delete, then reset the command", async () => {
    const app = await mountApp({ width: 120, height: 35 });
    await openShortcuts(app, "toggle sidebar");
    await app.tui.press("down");
    await app.tui.press("delete");
    expect(await bindings(app)).toEqual({ "view.toggleSidebar": false });
    const before = sidebarVisible(app);
    await app.tui.press("ctrl+b");
    expect(sidebarVisible(app)).toBe(before);
    // Slots are now: Add, Reset.
    await app.tui.press("right");
    await app.tui.press("enter");
    expect(await bindings(app)).toEqual({});
    await app.tui.press("ctrl+b");
    expect(sidebarVisible(app)).toBe(!before);
  });

  test("text snapshots at 120x35 and 90x28", async () => {
    for (const [width, height] of [
      [120, 35],
      [90, 28],
    ] as const) {
      const app = await mountApp({ width, height });
      await openShortcuts(app, "view");
      await app.tui.press("down");
      expect(normalizeFrame(app.tui.frame())).toMatchSnapshot(`keybindings-${width}x${height}`);
      await app.dispose();
    }
  });
});
