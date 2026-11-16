/**
 * The code viewer inside the real app (`mountApp`), with only the editor feature so other
 * features' state cannot change these frames.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RGBA } from "@opentui/core";
import { editorFeature } from "@/features/editor";
import { createTestDirs, type MountAppOptions, type MountedApp, mountApp } from "../helpers/app";

function workspaceRoot(): string {
  // A fixed folder name: the command bar shows it, and snapshots must not depend on mkdtemp.
  const root = join(mkdtempSync(join(process.env.LUCY_TEST_ROOT ?? tmpdir(), "viewer-")), "orbit");
  mkdirSync(root);
  return root;
}

function writeAll(root: string, files: Record<string, string | Uint8Array>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

async function mount(
  files: Record<string, string | Uint8Array>,
  options: Partial<MountAppOptions> & { root?: string } = {},
): Promise<MountedApp> {
  const root = options.root ?? workspaceRoot();
  writeAll(root, files);
  return mountApp({ features: [editorFeature], workspace: { root }, ...options });
}

async function open(app: MountedApp, path: string, line?: number): Promise<void> {
  await app.tui.act(() => {
    const tab = app.ctx.editors.open({ kind: "file", resource: path });
    app.ctx.focus.focus("editor");
    if (line !== undefined) app.ctx.editors.reveal({ tabId: tab.id, line });
  });
}

function numbered(count: number): string {
  return `${Array.from({ length: count }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n")}\n`;
}

const sameColor = (a: RGBA, b: RGBA) => a.toInts().join() === b.toInts().join();

/** The span that starts with `text` on the first code row containing it (not the find bar). */
function spanOf(app: MountedApp, text: string) {
  for (const line of app.tui.spans().lines) {
    if (line.spans.some((span) => span.text.includes("Aa"))) continue;
    for (const span of line.spans) if (span.text.startsWith(text)) return span;
  }
  return undefined;
}

async function until(app: MountedApp, predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("condition not met in time");
    await app.tui.advance(25);
  }
}

const TS =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: file content with a template literal.
  "export const answer = 42;\n// a comment\nfunction greet(name: string) {\n  return `hi ${name}`;\n}\n";

describe("file view", () => {
  test("renders with line numbers, syntax colors, status items and the read-only hint", async () => {
    const app = await mount({ "src/main.ts": TS });
    await open(app, "src/main.ts");
    await app.tui.waitForText("export const answer");
    const keyword = app.ctx.themes.current.colors.syntax.keyword;
    // Highlighting runs in a worker: the first paint is plain text in the theme foreground.
    await until(app, () => {
      const span = spanOf(app, "export");
      return span !== undefined && sameColor(span.fg, keyword);
    });
    const frame = app.tui.frame();
    expect(frame).toMatch(/1 +export const answer = 42;/);
    expect(frame).toMatch(/5 +\}/);
    expect(frame).toContain("Ln 1, Col 1");
    expect(frame).toContain("TypeScript");
    expect(frame).toContain("UTF-8");
    expect(frame).toContain("Read-only · E to edit");
    expect(frame).toContain("Edit"); // breadcrumb action
  });

  test("text frames at 120x35 and 90x28", async () => {
    for (const [width, height] of [
      [120, 35],
      [90, 28],
    ] as const) {
      const app = await mount({ "src/main.ts": TS }, { width, height });
      await open(app, "src/main.ts");
      await app.tui.waitForText("export const answer");
      expect(app.tui.frame()).toMatchSnapshot(`file view ${width}x${height}`);
      await app.dispose();
    }
  });

  test("navigation: keys, reveal at a line, click", async () => {
    const app = await mount({ "a.ts": numbered(200) });
    await open(app, "a.ts", 120);
    await app.tui.waitForText("Ln 120, Col 1");
    expect(app.tui.frame()).toContain("const line120 = 120;");
    await app.tui.press("down");
    await app.tui.waitForText("Ln 121");
    await app.tui.press("pagedown");
    expect(app.tui.frame()).not.toContain("Ln 121,");
    await app.tui.press("home");
    await app.tui.waitForText("Ln 1, Col 1");
    expect(app.tui.frame()).toContain("const line1 = 1;");
    await app.tui.press("end");
    await app.tui.waitForText("Ln 200");
    await app.tui.press("ctrl+home");
    await app.tui.waitForText("Ln 1,");
    // A click on a row makes it the active line (and sets the column).
    const target = app.tui.findText("line5 = 5");
    if (!target) throw new Error("line 5 is not on screen");
    await app.tui.click(target.x, target.y);
    await app.tui.waitForText("Ln 5, Col 7");
  });

  test("a reveal request opens at the line; the `:` provider moves within the file", async () => {
    const app = await mount({ "src/long.ts": numbered(300) });
    // Quick Open `file:250`, search results and the diff view all reveal like this.
    await open(app, "src/long.ts", 250);
    await app.tui.waitForText("Ln 250, Col 1");
    expect(app.tui.frame()).toContain("const line250 = 250;");
    await app.tui.press("ctrl+g");
    await app.tui.type("12:7");
    await app.tui.advance(50);
    await app.tui.press("enter");
    await app.tui.waitForText("Ln 12, Col 7");
    expect(app.tui.frame()).toContain("const line12 = 12;");
  });

  test("find: matches, current match, next/previous, close", async () => {
    const app = await mount({ "f.ts": "alpha beta\nbeta gamma\nalpha\nbeta beta\n" });
    await open(app, "f.ts");
    await app.tui.waitForText("alpha beta");
    await app.tui.press("ctrl+f");
    await app.tui.type("beta");
    await app.tui.waitForText("1 of 4");
    const colors = app.ctx.themes.current.colors.editor;
    const current = spanOf(app, "beta");
    expect(current && sameColor(current.bg, colors.findMatchActiveBg)).toBe(true);
    await app.tui.press("enter");
    await app.tui.waitForText("2 of 4");
    await app.tui.waitForText("Ln 2, Col 1");
    await app.tui.press("enter", { shift: true });
    await app.tui.waitForText("1 of 4");
    await app.tui.press("f3");
    await app.tui.waitForText("2 of 4");
    await app.tui.type("x");
    await app.tui.waitForText("No results");
    await app.tui.press("escape");
    await app.tui.advance(50);
    expect(app.tui.frame()).not.toContain("No results");
    // Keys go back to the viewer.
    await app.tui.press("down");
    await app.tui.waitForText("Ln 3");
  });

  test("find: an invalid regular expression says so", async () => {
    const app = await mount({ "f.ts": "abc\n" });
    await open(app, "f.ts");
    await app.tui.waitForText("abc");
    await app.tui.press("ctrl+f");
    await app.tui.act(() => app.ctx.commands.execute("editor.find"));
    const session = app.ctx.editors.active;
    expect(session?.kind).toBe("file");
    // Toggle regex with the mouse, like a user.
    const toggle = app.tui.findText(".*");
    if (!toggle) throw new Error("regex toggle not visible");
    await app.tui.click(toggle.x, toggle.y);
    await app.tui.press("ctrl+f");
    await app.tui.type("a(");
    await app.tui.waitForText("Invalid regular expression");
  });

  test("Markdown: toggle between source and preview", async () => {
    const app = await mount({ "README.md": "# Orbit\n\nSome **bold** text.\n" });
    await open(app, "README.md");
    await app.tui.waitForText("# Orbit");
    expect(app.tui.frame()).toContain("Preview");
    await app.tui.act(() => app.ctx.commands.execute("editor.toggleMarkdownPreview"));
    await until(app, () => !app.tui.frame().includes("# Orbit") && app.tui.frame().includes("Orbit"));
    expect(app.tui.frame()).toContain("Source");
    expect(app.tui.frame()).not.toContain("**bold**");
    await app.tui.act(() => app.ctx.commands.execute("editor.toggleMarkdownPreview"));
    await app.tui.waitForText("# Orbit");
  });

  test("information cards: binary, too large, not found", async () => {
    const png = Uint8Array.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0,
      0,
      0,
      13,
      0x49,
      0x48,
      0x44,
      0x52,
      0,
      0,
      2,
      0x80,
      0,
      0,
      1,
      0xe0,
      8,
      6,
      0,
      0,
      0,
      ...new Uint8Array(32),
    ]);
    const app = await mount(
      { "logo.png": png, "big.log": "x".repeat(1024 * 1024 + 10) },
      { settings: { "editor.maxFileSizeMb": 1 } },
    );
    await open(app, "logo.png");
    await app.tui.waitForText("PNG image");
    expect(app.tui.frame()).toContain("640 × 480");
    expect(app.tui.frame()).toContain("Open with Default App");
    await open(app, "big.log");
    await app.tui.waitForText("larger than 1 MB");
    expect(app.tui.frame()).toMatch(/Edit in \S+|Open in External Editor/);
    await open(app, "missing.ts");
    await app.tui.waitForText("File not found");
    expect(app.tui.frame()).toContain("Try Again");
    expect(app.tui.frame()).toContain("Close Tab");
  });

  test("reload on watcher batches: changed files keep the line, deleted files turn calm", async () => {
    const root = workspaceRoot();
    const app = await mount({ "w.ts": numbered(50) }, { root, startBackground: true });
    await open(app, "w.ts", 30);
    await app.tui.waitForText("Ln 30");
    await app.tui.advance(300); // let the watcher start
    writeFileSync(
      join(root, "w.ts"),
      numbered(50).replace("const line31 = 31;", "const line31 = 'changed';"),
    );
    await app.tui.waitForText("'changed'", { timeoutMs: 5000 });
    expect(app.tui.frame()).toContain("Ln 30");
    rmSync(join(root, "w.ts"));
    await app.tui.waitForText("File was deleted", { timeoutMs: 5000 });
  });

  test("external editor: suspends, edits, resumes and reloads", async () => {
    const root = workspaceRoot();
    const scripts = mkdtempSync(join(process.env.LUCY_TEST_ROOT ?? tmpdir(), "fake-editor-"));
    const log = join(scripts, "args.log");
    const script = join(scripts, "fake-editor");
    writeFileSync(
      script,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nfor a in "$@"; do f="$a"; done\nprintf 'edited outside\\n' >> "$f"\n`,
    );
    chmodSync(script, 0o755);
    const app = await mount(
      { "e.ts": numbered(20) },
      { root, settings: { "editor.external": [script, "--line={line}"] } },
    );
    const events: string[] = [];
    Object.assign(app.ctx.lifecycle, {
      suspendTerminal: async () => void events.push("suspend"),
      resumeTerminal: async () => void events.push("resume"),
    });
    await open(app, "e.ts", 7);
    await app.tui.waitForText("Ln 7");
    await app.tui.press("e");
    await app.tui.waitForText("edited outside", { timeoutMs: 5000 });
    expect(events).toEqual(["suspend", "resume"]);
    expect(readFileSync(log, "utf8")).toBe(`--line=7\n${join(realpathSync(root), "e.ts")}\n`);
    expect(app.tui.frame()).toContain("Ln 7");
  });

  test("external editor that cannot start: a toast with a hint to the setting, the screen never suspends", async () => {
    const app = await mount({ "e.ts": "x\n" }, { settings: { "editor.external": ["/nonexistent/editor"] } });
    const events: string[] = [];
    Object.assign(app.ctx.lifecycle, {
      suspendTerminal: async () => void events.push("suspend"),
      resumeTerminal: async () => void events.push("resume"),
    });
    await open(app, "e.ts");
    await app.tui.waitForText("Ln 1");
    await app.tui.act(() => app.ctx.commands.execute("editor.openInExternalEditor"));
    await app.tui.waitForText("No terminal editor to open");
    expect(app.tui.frame()).toContain("editor.external");
    expect(events).toEqual([]);
  });

  test("view state survives tab switches and a restart", async () => {
    const root = workspaceRoot();
    const dirs = createTestDirs();
    const first = await mount({ "a.ts": numbered(100), "b.ts": "b\n" }, { root, dirs });
    await open(first, "a.ts", 40);
    await first.tui.waitForText("Ln 40");
    await first.tui.act(() => first.ctx.commands.execute("editor.toggleWrap"));
    await open(first, "b.ts");
    await first.tui.waitForText("Ln 1");
    await open(first, "a.ts");
    await first.tui.waitForText("Ln 40");
    expect(first.ctx.editors.active?.viewState.wrap).toBe(true);
    await first.tui.advance(300);
    await first.dispose();

    const second = await mountApp({ features: [editorFeature], workspace: { root }, dirs });
    await second.tui.waitForText("Ln 40");
    expect(second.tui.frame()).toContain("const line40 = 40;");
  });
});

describe("find highlight cost", () => {
  test("timing: painting visible matches on a 50k-line file", async () => {
    const lines = Array.from(
      { length: 50_000 },
      (_, i) => `const needle${i} = "needle needle needle"; // needle ${i}`,
    );
    const app = await mount({ "big.ts": `${lines.join("\n")}\n` });
    await open(app, "big.ts", 25_000);
    await app.tui.waitForText("Ln 25000", { timeoutMs: 5000 });
    const frameTime = async () => {
      const runs = 20;
      const started = performance.now();
      for (let i = 0; i < runs; i++) {
        app.tui.renderer.requestRender();
        await app.tui.setup.renderOnce();
      }
      return (performance.now() - started) / runs;
    };
    const plain = await frameTime();
    await app.tui.press("ctrl+f");
    const typed = performance.now();
    await app.tui.type("needle");
    await app.tui.waitForText("10000+", { timeoutMs: 5000 });
    const searchMs = performance.now() - typed;
    const painted = await frameTime();
    console.log(
      `[timing] 50k lines: frame ${plain.toFixed(2)} ms without find, ${painted.toFixed(2)} ms with ~150 visible matches painted; ` +
        `typing "needle" to label (6 keys, 60 ms debounce) ${searchMs.toFixed(0)} ms`,
    );
    expect(painted).toBeLessThan(plain + 20);
  });
});
