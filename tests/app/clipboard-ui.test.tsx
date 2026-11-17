/**
 * Copying through the whole app with real mouse drags (the test driver's mouse) and the
 * memory clipboard backend `mountApp` installs by default: copy on select, Ctrl+C, Ctrl+Shift+C,
 * the "Copy Selection" command, terminals, and the cases that used to lose the copy.
 */
import { describe, expect, test } from "bun:test";
import { scriptedSpawn, shellScript } from "../ai-ui/support/scripted-pty";
import { type MountAppOptions, type MountedApp, mountApp } from "../helpers/app";

const FILE = "const first = 1;\nconst ğüş = 'İstanbul 日本語';\nconst third = 3;\n";

async function withFile(options: Partial<MountAppOptions> = {}): Promise<MountedApp> {
  const app = await mountApp({ width: 100, height: 30, files: { "a.ts": FILE }, ...options });
  await app.tui.act(() => app.ctx.editors.open({ kind: "file", resource: "a.ts" }));
  await app.tui.waitForText("const third");
  return app;
}

function at(app: MountedApp, text: string): { x: number; y: number } {
  const position = app.tui.findText(text);
  if (!position) throw new Error(`"${text}" is not on screen:\n${app.tui.frame()}`);
  return position;
}

const copies = (app: MountedApp) => app.clipboard?.copies ?? [];

/**
 * Ctrl+C with focus outside the editor: in an editable file view Ctrl+C is the editor's own
 * Copy (its selection, or the current line), a keybinding that comes before the router's.
 */
async function ctrlCOutsideEditor(app: MountedApp): Promise<void> {
  await app.tui.act(() => app.ctx.focus.focus("sidebar"));
  await app.tui.press("c", { ctrl: true });
}
const hint = (app: MountedApp) => app.ctx.hints.current?.text;

describe("copy on select", () => {
  test("a drag in the code view copies exactly the selected text, Turkish and wide characters included", async () => {
    const app = await withFile();
    const start = at(app, "const first");
    // From "first" on line 1 to the end of line 2 (past its last character).
    await app.tui.drag(start.x + 6, start.y, start.x + 40, start.y + 1);
    expect(copies(app)).toEqual(["first = 1;\nconst ğüş = 'İstanbul 日本語';"]);
    expect(hint(app)).toBe("Copied");
  });

  test("a click without a drag copies nothing and says nothing", async () => {
    const app = await withFile();
    const start = at(app, "const first");
    await app.tui.click(start.x + 2, start.y);
    expect(copies(app)).toEqual([]);
    expect(hint(app)).toBeUndefined();
  });

  test("with ui.copyOnSelect off a drag copies nothing; Ctrl+C then copies the selection", async () => {
    const app = await withFile({ settings: { "ui.copyOnSelect": false } });
    const start = at(app, "const third");
    await app.tui.drag(start.x, start.y, start.x + 10, start.y);
    expect(copies(app)).toEqual([]);
    await ctrlCOutsideEditor(app);
    expect(copies(app)).toEqual(["const third"]);
    expect(hint(app)).toBe("Copied");
  });

  test("a failing clipboard is reported, not hidden behind 'Copied'", async () => {
    const app = await withFile();
    if (app.clipboard) app.clipboard.failWith = "no clipboard tool was found";
    const start = at(app, "const third");
    await app.tui.drag(start.x, start.y, start.x + 10, start.y);
    await app.tui.waitForText("Could not copy");
    expect(hint(app)).not.toBe("Copied");
  });
});

describe("Ctrl+C and the Copy Selection command", () => {
  test("without a selection Ctrl+C keeps showing how to quit", async () => {
    const app = await withFile();
    await ctrlCOutsideEditor(app);
    expect(copies(app)).toEqual([]);
    expect(hint(app)).toContain("Quit with");
  });

  test("a selection re-rendered away (a theme change) is still copied by Ctrl+C", async () => {
    // A re-render replaces the renderables the selection points at; the live selection then
    // returns "" although the user's selection still stands. This used to copy nothing.
    const app = await withFile({ settings: { "ui.copyOnSelect": false } });
    const start = at(app, "const first");
    await app.tui.drag(start.x, start.y, start.x + 15, start.y);
    await app.tui.act(() => app.ctx.config.set("ui.theme", "high-contrast", { persist: false }));
    await app.tui.settle();
    await ctrlCOutsideEditor(app);
    expect(copies(app)).toEqual(["const first = 1;"]);
  });

  test("a new click ends the old selection: Ctrl+C no longer copies stale text", async () => {
    const app = await withFile({ settings: { "ui.copyOnSelect": false } });
    const start = at(app, "const first");
    await app.tui.drag(start.x, start.y, start.x + 15, start.y);
    await app.tui.click(start.x + 3, start.y + 2);
    await ctrlCOutsideEditor(app);
    expect(copies(app)).toEqual([]);
  });

  test("the palette's Copy Selection copies, and explains when nothing is selected", async () => {
    const app = await withFile({ settings: { "ui.copyOnSelect": false } });
    await app.tui.act(() => app.ctx.commands.execute("clipboard.copySelection"));
    expect(hint(app)).toBe("Select text with the mouse first");
    const start = at(app, "const third");
    await app.tui.drag(start.x, start.y, start.x + 4, start.y);
    await app.tui.act(() => app.ctx.commands.execute("clipboard.copySelection"));
    expect(copies(app)).toEqual(["const"]);
    expect(app.ctx.commands.get("clipboard.copySelection")?.title).toBe("Copy Selection");
  });

  test("Ctrl+C in a focused text input is left to the input", async () => {
    const app = await withFile({ settings: { "ui.copyOnSelect": false } });
    const start = at(app, "const third");
    await app.tui.drag(start.x, start.y, start.x + 4, start.y);
    await app.tui.act(() => app.ctx.commands.execute("view.showSearch"));
    await app.tui.type("abc");
    await app.tui.press("c", { ctrl: true });
    expect(copies(app)).toEqual([]);
  });
});

describe("embedded terminals", () => {
  async function withTerminal() {
    const spawn = scriptedSpawn(() => shellScript());
    const app = await mountApp({ width: 100, height: 30, ptySpawn: spawn.spawn, kittyKeyboard: true });
    await app.tui.act(() => app.ctx.commands.execute("terminal.toggle"));
    await app.tui.waitForText("rate limit refills");
    return { app, pty: () => spawn.last() };
  }

  test("a drag over terminal output is copied on select", async () => {
    const { app } = await withTerminal();
    const start = at(app, "rate limit refills");
    await app.tui.drag(start.x, start.y, start.x + 17, start.y);
    expect(copies(app)).toEqual(["rate limit refills"]);
    expect(hint(app)).toBe("Copied");
  });

  test("Ctrl+C still reaches the program; Ctrl+Shift+C copies the terminal selection", async () => {
    const { app, pty } = await withTerminal();
    await app.tui.act(() => app.ctx.config.set("ui.copyOnSelect", false, { persist: false }));
    const start = at(app, "notes are sorted");
    await app.tui.drag(start.x, start.y, start.x + 15, start.y);
    const writes = pty()?.writes.length ?? 0;
    await app.tui.press("c", { ctrl: true });
    expect(pty()?.writes.length).toBe(writes + 1);
    expect(copies(app)).toEqual([]);
    await app.tui.press("c", { ctrl: true, shift: true });
    expect(copies(app)).toEqual(["notes are sorted"]);
    expect(pty()?.writes.length).toBe(writes + 1);
  });
});
