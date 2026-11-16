import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  decideReload,
  exportViewerState,
  observeFile,
  restoreViewerState,
  ViewerTab,
} from "@/features/editor/model";
import { createSyntax, createTempDirs, writeFiles } from "./helpers";

const tempDir = createTempDirs("tab");
const syntax = createSyntax(tempDir());
afterAll(() => syntax.dispose());

function numbered(count: number): string {
  return `${Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
}

/** Rewrites the file and moves its mtime, so the change is visible even on coarse filesystems. */
function rewrite(path: string, content: string): void {
  const before = statSync(path).mtimeMs;
  writeFileSync(path, content);
  const seconds = (before + 5000) / 1000;
  utimesSync(path, seconds, seconds);
}

describe("decideReload", () => {
  const stamp = { size: 10, mtimeMs: 1000 };
  test("unchanged, changed, deleted, reappeared, unreadable", () => {
    expect(decideReload(stamp, { size: 10, mtimeMs: 1000 })).toBe("unchanged");
    expect(decideReload(stamp, { size: 11, mtimeMs: 1000 })).toBe("reload");
    expect(decideReload(stamp, { size: 10, mtimeMs: 2000 })).toBe("reload");
    expect(decideReload(stamp, null)).toBe("deleted");
    expect(decideReload(null, null)).toBe("unchanged");
    expect(decideReload(null, stamp)).toBe("reload");
    expect(decideReload(stamp, "unreadable")).toBe("reload");
  });

  test("observeFile", async () => {
    const root = tempDir();
    writeFiles(root, { "a.txt": "abc" });
    const seen = await observeFile(root, "a.txt");
    expect(seen).toEqual({ size: 3, mtimeMs: statSync(join(root, "a.txt")).mtimeMs });
    expect(await observeFile(root, "missing.txt")).toBeNull();
    expect(await observeFile(root, "a.txt/inner")).toBeNull();
  });
});

describe("ViewerTab", () => {
  test("loads, then reloads a changed file keeping the active line and scroll", async () => {
    const root = tempDir();
    writeFiles(root, { "a.ts": numbered(100) });
    const tab = new ViewerTab({ root, path: "a.ts", syntax });
    tab.setViewportHeight(20);
    expect(tab.state.get().status).toBe("idle");
    const doc = await tab.load();
    expect(doc.kind).toBe("text");
    expect(tab.state.get()).toMatchObject({ status: "ready", revision: 1, lastChange: "loaded" });

    tab.move({ kind: "line", line: 60 });
    const before = tab.viewer.get();
    expect(before.activeLine).toBe(60);

    expect(await tab.checkForChanges()).toBe("unchanged");
    expect(tab.state.get().revision).toBe(1);

    rewrite(join(root, "a.ts"), numbered(120));
    expect(await tab.checkForChanges()).toBe("reload");
    const state = tab.state.get();
    expect(state.lastChange).toBe("reloaded");
    expect(state.revision).toBe(2);
    expect(state.document?.kind === "text" && state.document.lineCount).toBe(120);
    expect(tab.viewer.get()).toBe(before); // still valid: same reference, no listener churn
    tab.dispose();
  });

  test("a shrinking file clamps the active line and scroll position", async () => {
    const root = tempDir();
    writeFiles(root, { "a.ts": numbered(100) });
    const tab = new ViewerTab({ root, path: "a.ts", syntax });
    tab.setViewportHeight(10);
    await tab.load();
    tab.move({ kind: "end" });
    expect(tab.viewer.get()).toMatchObject({ activeLine: 99, scrollTop: 90 });
    rewrite(join(root, "a.ts"), numbered(15));
    await tab.checkForChanges();
    expect(tab.viewer.get()).toMatchObject({ activeLine: 14, scrollTop: 5 });
    tab.dispose();
  });

  test("file removed between loads: calm deleted state, position kept, back when restored", async () => {
    const root = tempDir();
    writeFiles(root, { "doc.md": numbered(50) });
    const tab = new ViewerTab({ root, path: "doc.md", syntax });
    await tab.load();
    tab.move({ kind: "line", line: 30 }, 10);
    rmSync(join(root, "doc.md"));

    expect(await tab.checkForChanges()).toBe("deleted");
    const deleted = tab.document;
    expect(deleted?.kind).toBe("unavailable");
    expect(deleted?.kind === "unavailable" && deleted.reason).toBe("deleted");
    expect(tab.state.get().lastChange).toBe("deleted");
    expect(tab.viewer.get().activeLine).toBe(30);

    // A second check while still missing does nothing.
    expect(await tab.checkForChanges()).toBe("unchanged");

    writeFiles(root, { "doc.md": numbered(40) });
    expect(await tab.checkForChanges()).toBe("reload");
    expect(tab.document?.kind).toBe("text");
    expect(tab.viewer.get().activeLine).toBe(30);
    tab.dispose();
  });

  test("a load that finds the file gone after it was shown reports deleted", async () => {
    const root = tempDir();
    writeFiles(root, { "x.txt": "a\n" });
    const tab = new ViewerTab({ root, path: "x.txt", syntax });
    await tab.load();
    rmSync(join(root, "x.txt"));
    const doc = await tab.load();
    expect(doc.kind === "unavailable" && doc.reason).toBe("deleted");
    tab.dispose();
  });

  test("restored state is clamped to the document once loaded", async () => {
    const root = tempDir();
    writeFiles(root, { "a.ts": numbered(10) });
    const snapshot = exportViewerState({
      activeLine: 500,
      scrollTop: 480,
      scrollLeft: 4,
      wrap: true,
      markdownPreview: false,
    });
    const tab = new ViewerTab({ root, path: "a.ts", syntax, viewer: restoreViewerState(snapshot) });
    await tab.load();
    expect(tab.viewer.get()).toEqual({
      activeLine: 9,
      scrollTop: 9,
      scrollLeft: 4,
      wrap: true,
      markdownPreview: false,
    });
    tab.setViewportHeight(5);
    expect(tab.viewer.get().scrollTop).toBe(5);
    tab.dispose();
  });

  test("Markdown preview toggles only for Markdown documents", async () => {
    const root = tempDir();
    writeFiles(root, { "README.md": "# Title\n", "a.ts": "x\n" });
    const md = new ViewerTab({ root, path: "README.md", syntax });
    await md.load();
    md.toggleMarkdownPreview();
    expect(md.viewer.get().markdownPreview).toBe(true);
    md.toggleMarkdownPreview();
    expect(md.viewer.get().markdownPreview).toBe(false);
    md.toggleWrap();
    expect(md.viewer.get().wrap).toBe(true);

    const ts = new ViewerTab({ root, path: "a.ts", syntax, wrap: true });
    await ts.load();
    const before = ts.viewer.get();
    ts.toggleMarkdownPreview();
    expect(ts.viewer.get()).toBe(before);
    expect(ts.exportState()).toEqual({ v: 1, ...before });
    md.dispose();
    ts.dispose();
  });

  test("a newer load supersedes an older one; dispose stops updates", async () => {
    const root = tempDir();
    writeFiles(root, { "a.ts": numbered(3) });
    const tab = new ViewerTab({ root, path: "a.ts", syntax });
    const first = tab.load();
    const second = tab.load();
    await Promise.all([first, second]);
    expect(tab.state.get().revision).toBe(1);
    tab.dispose();
    rewrite(join(root, "a.ts"), numbered(5));
    expect(await tab.checkForChanges()).toBe("unchanged");
    expect(tab.state.get().revision).toBe(1);
  });
});
