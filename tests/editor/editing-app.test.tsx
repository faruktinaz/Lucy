/**
 * In-place editing through the real UI (`mountApp`, editor feature only): typing, saving,
 * auto save, format preservation, conflicts with the disk, read-only cases and the guards.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editorFeature } from "@/features/editor";
import { type MountAppOptions, type MountedApp, mountApp } from "../helpers/app";

type Settings = NonNullable<MountAppOptions["settings"]>;

function workspaceRoot(): string {
  const root = join(mkdtempSync(join(process.env.LUCY_TEST_ROOT ?? tmpdir(), "edit-")), "orbit");
  mkdirSync(root);
  return root;
}

async function mount(
  files: Record<string, string | Uint8Array>,
  options: Partial<MountAppOptions> & { root?: string; settings?: Settings } = {},
): Promise<MountedApp> {
  const root = options.root ?? workspaceRoot();
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return mountApp({
    features: [editorFeature],
    workspace: { root },
    ...options,
    settings: { "editor.autosave": "off", ...options.settings },
  });
}

async function open(app: MountedApp, path: string): Promise<void> {
  await app.tui.act(() => {
    app.ctx.editors.open({ kind: "file", resource: path });
    app.ctx.focus.focus("editor");
  });
  await app.tui.waitForText(/Saved|Read-only/);
  await app.tui.advance(30);
}

const read = (app: MountedApp, path: string) => readFileSync(join(app.root, path), "utf8");

/** Ctrl+S, then waits for the write to finish (saving is asynchronous). */
async function save(app: MountedApp): Promise<void> {
  await app.tui.press("ctrl+s");
  await app.tui.waitForText(/Saved|Save failed|Changed on disk/);
  await app.tui.advance(20);
}
const dirty = (app: MountedApp) => app.ctx.editors.active?.dirty === true;

describe("typing and saving", () => {
  test("type, dirty marker and status, Ctrl+S saves", async () => {
    const app = await mount({ "a.ts": "const a = 1;\n" });
    await open(app, "a.ts");
    await app.tui.press("end");
    await app.tui.type(" // ok");
    await app.tui.waitForText("Unsaved");
    expect(dirty(app)).toBe(true);
    expect(read(app, "a.ts")).toBe("const a = 1;\n");
    await save(app);
    expect(read(app, "a.ts")).toBe("const a = 1; // ok\n");
    expect(dirty(app)).toBe(false);
  });

  test("auto save after the delay", async () => {
    const app = await mount(
      { "a.ts": "x\n" },
      { settings: { "editor.autosave": "afterDelay", "editor.autosaveDelayMs": 200 } },
    );
    await open(app, "a.ts");
    await app.tui.type("y");
    expect(read(app, "a.ts")).toBe("x\n");
    await app.tui.advance(400);
    await app.tui.waitForText("Saved");
    expect(read(app, "a.ts")).toBe("yx\n");
  });

  test("auto save on focus change (switching tabs)", async () => {
    const app = await mount(
      { "a.ts": "a\n", "b.ts": "b\n" },
      { settings: { "editor.autosave": "onFocusChange" } },
    );
    await open(app, "a.ts");
    await app.tui.type("1");
    await app.tui.advance(1500);
    expect(read(app, "a.ts")).toBe("a\n");
    await open(app, "b.ts");
    await app.tui.advance(100);
    expect(read(app, "a.ts")).toBe("1a\n");
  });

  test("auto save off: nothing is written, the tab stays dirty", async () => {
    const app = await mount({ "a.ts": "a\n" });
    await open(app, "a.ts");
    await app.tui.type("z");
    await app.tui.advance(1500);
    expect(read(app, "a.ts")).toBe("a\n");
    expect(dirty(app)).toBe(true);
  });

  test("undo and redo", async () => {
    const app = await mount({ "a.ts": "base\n" });
    await open(app, "a.ts");
    await app.tui.type("ab");
    await app.tui.press("ctrl+z");
    await app.tui.press("ctrl+z");
    await app.tui.waitForText("Saved");
    expect(dirty(app)).toBe(false);
    await app.tui.press("ctrl+y");
    await app.tui.waitForText("Unsaved");
    await save(app);
    expect(read(app, "a.ts")).toBe("abase\n");
  });

  test("Enter keeps indentation; Tab and Shift+Tab use the file's style", async () => {
    const app = await mount({ "a.ts": "function f() {\n    return 1;\n}\n" });
    await open(app, "a.ts");
    await app.tui.press("down");
    await app.tui.press("end");
    await app.tui.press("enter");
    await app.tui.type("x;");
    await app.tui.press("tab");
    await save(app);
    expect(read(app, "a.ts")).toBe("function f() {\n    return 1;\n    x;    \n}\n");
    await app.tui.press("tab", { shift: true });
    await save(app);
    expect(read(app, "a.ts")).toBe("function f() {\n    return 1;\nx;    \n}\n");
  });

  test("Turkish typing and a bracketed paste", async () => {
    const app = await mount({ "notes.md": "\n" });
    await open(app, "notes.md");
    await app.tui.type("İşçi ığüö ");
    await app.tui.paste("çalışma\nnotları");
    await save(app);
    expect(read(app, "notes.md")).toBe("İşçi ığüö çalışma\nnotları\n");
  });
});

describe("what a save preserves", () => {
  test("CRLF, BOM, no final newline and the file mode", async () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("one\r\ntwo\r\nthree", "utf8"),
    ]);
    const app = await mount({ "win.txt": bytes });
    chmodSync(join(app.root, "win.txt"), 0o640);
    await open(app, "win.txt");
    await app.tui.type("1");
    await save(app);
    const saved = readFileSync(join(app.root, "win.txt"));
    expect([...saved.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(saved.subarray(3).toString("utf8")).toBe("1one\r\ntwo\r\nthree");
    expect(statSync(join(app.root, "win.txt")).mode & 0o777).toBe(0o640);
  });

  test("an unchanged buffer is never written", async () => {
    const app = await mount({ "a.ts": "same\n" });
    const path = join(app.root, "a.ts");
    utimesSync(path, 1_000_000, 1_000_000);
    await open(app, "a.ts");
    await app.tui.press("ctrl+s");
    await app.tui.type("x");
    await app.tui.press("backspace");
    await app.tui.press("ctrl+s");
    await app.tui.advance(50);
    expect(statSync(path).mtimeMs).toBe(1_000_000_000);
  });

  test("a failed write keeps the buffer dirty and says so", async () => {
    const app = await mount({ "locked/a.ts": "a\n" });
    await open(app, "locked/a.ts");
    await app.tui.type("b");
    chmodSync(join(app.root, "locked"), 0o555);
    try {
      await app.tui.press("ctrl+s");
      await app.tui.waitForText("Save failed");
      expect(app.tui.frame()).toContain("Could not save a.ts");
      expect(dirty(app)).toBe(true);
      expect(read(app, "locked/a.ts")).toBe("a\n");
    } finally {
      chmodSync(join(app.root, "locked"), 0o755);
    }
  });
});

describe("the disk changes while editing", () => {
  async function conflict(): Promise<MountedApp> {
    const root = workspaceRoot();
    const app = await mount(
      { "c.ts": "disk 1\n" },
      {
        root,
        startBackground: true,
        settings: { "editor.autosave": "afterDelay", "editor.autosaveDelayMs": 300 },
      },
    );
    await open(app, "c.ts");
    await app.tui.advance(300);
    await app.tui.type("mine ");
    writeFileSync(join(root, "c.ts"), "disk 2 from the agent\n");
    await app.tui.waitForText("Changed on disk", { timeoutMs: 5000 });
    // Auto save must not clobber the newer disk content.
    await app.tui.advance(600);
    expect(read(app, "c.ts")).toBe("disk 2 from the agent\n");
    return app;
  }

  test("reload from disk", async () => {
    const app = await conflict();
    await app.tui.clickText("Reload");
    await app.tui.waitForText("disk 2 from the agent");
    expect(dirty(app)).toBe(false);
    expect(app.tui.frame()).not.toContain("Changed on disk");
  });

  test("keep my changes", async () => {
    const app = await conflict();
    await app.tui.clickText("Keep Mine");
    await app.tui.advance(100);
    await app.tui.waitForText("Saved");
    expect(read(app, "c.ts")).toBe("mine disk 1\n");
  });

  test("a clean buffer follows the disk silently", async () => {
    const root = workspaceRoot();
    const app = await mount({ "c.ts": "one\n" }, { root, startBackground: true });
    await open(app, "c.ts");
    await app.tui.advance(300);
    writeFileSync(join(root, "c.ts"), "two\n");
    await app.tui.waitForText("two", { timeoutMs: 5000 });
    expect(dirty(app)).toBe(false);
  });
});

describe("read-only cases", () => {
  test("UTF-16, outside the workspace and too large stay read-only with a note", async () => {
    const outside = mkdtempSync(join(process.env.LUCY_TEST_ROOT ?? tmpdir(), "outside-"));
    writeFileSync(join(outside, "shared.ts"), "export {};\n");
    const big = `${Array.from({ length: 20_001 }, (_, i) => `line ${i}`).join("\n")}\n`;
    const root = workspaceRoot();
    symlinkSync(join(outside, "shared.ts"), join(root, "link.ts"));
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("merhaba\n", "utf16le")]);
    const app = await mount({ "u16.txt": utf16, "big.txt": big }, { root });

    await open(app, "u16.txt");
    expect(app.tui.frame()).toContain("Read-only: UTF-16 files are not edited in Lucy");
    await app.tui.type("x");
    expect(dirty(app)).toBe(false);

    await open(app, "link.ts");
    expect(app.tui.frame()).toContain("Read-only: the file lies outside the workspace");

    await open(app, "big.txt");
    expect(app.tui.frame()).toContain("Read-only: too large to edit smoothly");
    expect(app.tui.frame()).toContain("Read-only");
  });
});

describe("unsaved changes guards", () => {
  test("quit asks; Cancel keeps the app, Don't Save quits", async () => {
    let quits = 0;
    const app = await mount({ "a.ts": "a\n" }, { onQuit: () => void quits++ });
    await open(app, "a.ts");
    await app.tui.type("q");
    const first = app.ctx.lifecycle.quit();
    await app.tui.waitForText("Save changes to a.ts?");
    await app.tui.press("escape");
    await app.tui.act(() => first);
    expect(quits).toBe(0);
    const second = app.ctx.lifecycle.quit();
    await app.tui.waitForText("Save changes to a.ts?");
    expect(app.tui.frame()).toContain("Don't Save");
    await app.tui.press("down");
    await app.tui.press("enter");
    await app.tui.act(() => second);
    expect(quits).toBe(1);
    expect(read(app, "a.ts")).toBe("a\n");
  });

  test("closing a dirty tab asks; Save writes and closes", async () => {
    const app = await mount({ "a.ts": "a\n" });
    await open(app, "a.ts");
    await app.tui.type("s");
    await app.tui.act(() => app.ctx.commands.execute("editor.closeTab"));
    await app.tui.waitForText("Save changes to a.ts?");
    await app.tui.press("enter");
    await app.tui.advance(200);
    expect(read(app, "a.ts")).toBe("sa\n");
    expect(app.ctx.editors.tabs.length).toBe(0);
  });
});

describe("typing latency", () => {
  for (const count of [5000, 19_500]) {
    test(`timing: keystroke to painted frame on a ${count}-line file`, async () => {
      const lines = Array.from({ length: count }, (_, i) => `export const v${i} = compute(${i}, "t"); // n`);
      const app = await mount({ "big.ts": `${lines.join("\n")}\n` });
      await open(app, "big.ts");
      await app.tui.advance(500);
      const times: number[] = [];
      for (let i = 0; i < 30; i++) {
        const started = performance.now();
        await app.tui.act(() => app.tui.setup.mockInput.pressKey("x"));
        await app.tui.setup.renderOnce();
        times.push(performance.now() - started);
      }
      times.sort((a, b) => a - b);
      const median = times[15] as number;
      console.log(
        `[timing] typing on ${count} lines: median ${median.toFixed(1)} ms, p90 ${(times[27] as number).toFixed(1)} ms (keystroke to painted frame)`,
      );
      expect(median).toBeLessThan(80);
    });
  }
});
