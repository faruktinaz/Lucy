import { describe, expect, test } from "bun:test";
import { EditorService, editorKey, type RevealRequest } from "@/app/workbench/editors";

const file = (resource: string) => ({ kind: "file", resource });

function titles(editors: EditorService): string[] {
  return editors.tabs.map((tab) => `${tab.title}${tab.preview ? "*" : ""}`);
}

describe("EditorService", () => {
  test("dedupes tabs by kind, resource and params", () => {
    const editors = new EditorService();
    const a = editors.open(file("src/a.ts"));
    expect(editors.open(file("src/a.ts")).id).toBe(a.id);
    const staged = editors.open({ kind: "diff", resource: "src/a.ts", params: { staged: true } });
    const unstaged = editors.open({ kind: "diff", resource: "src/a.ts" });
    expect(staged.id).not.toBe(unstaged.id);
    expect(editors.open({ kind: "diff", resource: "src/a.ts", params: { staged: true } }).id).toBe(staged.id);
    expect(editors.tabs).toHaveLength(3);
    expect(editorKey({ kind: "x", params: { b: 1, a: 2 } })).toBe(
      editorKey({ kind: "x", params: { a: 2, b: 1 } }),
    );
  });

  test("titles default to the base name, or come from titleFor or the input", () => {
    const editors = new EditorService({
      titleFor: (input) => (input.kind === "settings" ? "Settings" : undefined),
    });
    expect(editors.open(file("deep/path/main.ts")).title).toBe("main.ts");
    expect(editors.open({ kind: "settings" }).title).toBe("Settings");
    expect(editors.open({ kind: "other", resource: "x", title: "Custom" }).title).toBe("Custom");
  });

  test("new tabs open to the right of the active tab", () => {
    const editors = new EditorService();
    const a = editors.open(file("a"));
    editors.open(file("b"));
    editors.activate(a.id);
    editors.open(file("c"));
    expect(titles(editors)).toEqual(["a", "c", "b"]);
  });

  test("preview tabs are reused, and promoted by a regular open", () => {
    const editors = new EditorService();
    editors.open(file("a"), { preview: true });
    expect(titles(editors)).toEqual(["a*"]);
    editors.open(file("b"), { preview: true });
    expect(titles(editors)).toEqual(["b*"]);
    editors.open(file("b"));
    expect(titles(editors)).toEqual(["b"]);
    editors.open(file("c"), { preview: true });
    expect(titles(editors)).toEqual(["b", "c*"]);
    const c = editors.find(file("c"));
    if (c) editors.keep(c.id);
    expect(titles(editors)).toEqual(["b", "c"]);
  });

  test("dirty and pinned tabs are never replaced by a preview", () => {
    const editors = new EditorService();
    const a = editors.open(file("a"), { preview: true });
    editors.setDirty(a.id, true);
    editors.open(file("b"), { preview: true });
    expect(titles(editors)).toEqual(["a", "b*"]);
    const b = editors.find(file("b"));
    if (b) editors.pin(b.id);
    editors.open(file("c"), { preview: true });
    expect(titles(editors)).toEqual(["a", "b", "c*"]);
    expect(editors.get(b?.id ?? "")?.pinned).toBe(true);
  });

  test("preview tabs can be turned off", () => {
    const editors = new EditorService({ previewEnabled: () => false });
    editors.open(file("a"), { preview: true });
    editors.open(file("b"), { preview: true });
    expect(titles(editors)).toEqual(["a", "b"]);
  });

  test("opening without activating keeps the active tab", () => {
    const editors = new EditorService();
    const a = editors.open(file("a"));
    editors.open(file("b"), { activate: false });
    expect(editors.active?.id).toBe(a.id);
  });

  test("closing the active tab goes back in history, then to a neighbour", () => {
    const editors = new EditorService();
    const a = editors.open(file("a"));
    const b = editors.open(file("b"));
    const c = editors.open(file("c"));
    editors.activate(a.id);
    // History: b, c (c most recent). Closing a returns to c.
    editors.close(a.id);
    expect(editors.active?.id).toBe(c.id);
    editors.close(c.id);
    expect(editors.active?.id).toBe(b.id);
    editors.close(b.id);
    expect(editors.active).toBeUndefined();
    expect(editors.close("missing")).toBe(false);

    const fresh = new EditorService();
    fresh.restore(
      [
        { path: "x", kind: "file", pinned: false },
        { path: "y", kind: "file", pinned: false },
        { path: "z", kind: "file", pinned: false },
      ],
      "y",
    );
    const y = fresh.active;
    expect(y?.resource).toBe("y");
    fresh.close(y?.id ?? "");
    // No history after a restore: the right neighbour takes over.
    expect(fresh.active?.resource).toBe("z");
  });

  test("closeOthers keeps pinned tabs; closeAll empties", () => {
    const editors = new EditorService();
    const a = editors.open(file("a"));
    const b = editors.open(file("b"));
    editors.pin(b.id);
    editors.open(file("c"));
    editors.closeOthers(a.id);
    expect(titles(editors)).toEqual(["a", "b"]);
    const closed: string[] = [];
    editors.onDidClose((tab) => closed.push(tab.title));
    editors.closeAll();
    expect(editors.tabs).toHaveLength(0);
    expect(closed.sort()).toEqual(["a", "b"]);
  });

  test("next and previous wrap around", () => {
    const editors = new EditorService();
    const a = editors.open(file("a"));
    editors.open(file("b"));
    const c = editors.open(file("c"));
    editors.next();
    expect(editors.active?.id).toBe(a.id);
    editors.previous();
    expect(editors.active?.id).toBe(c.id);
  });

  test("back and forward over activations", () => {
    const editors = new EditorService();
    const a = editors.open(file("a"));
    const b = editors.open(file("b"));
    const c = editors.open(file("c"));
    expect(editors.canGoForward).toBe(false);
    editors.goBack();
    expect(editors.active?.id).toBe(b.id);
    editors.goBack();
    expect(editors.active?.id).toBe(a.id);
    expect(editors.canGoForward).toBe(true);
    editors.goForward();
    expect(editors.active?.id).toBe(b.id);
    editors.goForward();
    expect(editors.active?.id).toBe(c.id);
    editors.goBack();
    editors.activate(a.id);
    // A new activation clears the forward stack.
    expect(editors.canGoForward).toBe(false);
  });

  test("view state merges, and reveal requests reach listeners", () => {
    const editors = new EditorService();
    const a = editors.open(file("a"), { viewState: { scrollTop: 3 } });
    editors.setViewState(a.id, { cursorLine: 9 });
    expect(editors.get(a.id)?.viewState).toEqual({ scrollTop: 3, cursorLine: 9 });
    editors.open(file("a"), { viewState: { scrollTop: 7 } });
    expect(editors.get(a.id)?.viewState).toEqual({ scrollTop: 7, cursorLine: 9 });
    const reveals: RevealRequest[] = [];
    editors.onDidRequestReveal((request) => reveals.push(request));
    editors.reveal({ tabId: a.id, line: 42 });
    expect(reveals).toEqual([{ tabId: a.id, line: 42 }]);
  });

  test("setDirty makes a preview tab permanent; setTitle renames", () => {
    const editors = new EditorService();
    const a = editors.open(file("a"), { preview: true });
    editors.setDirty(a.id, true);
    expect(editors.get(a.id)).toMatchObject({ dirty: true, preview: false });
    editors.setTitle(a.id, "renamed.ts", "src");
    expect(editors.get(a.id)).toMatchObject({ title: "renamed.ts", description: "src" });
  });

  test("toPersisted keeps file and diff tabs only, never previews", () => {
    const editors = new EditorService();
    editors.open(file("a"), { viewState: { scrollTop: 12.7 } });
    editors.open({ kind: "diff", resource: "b", params: { staged: true } }, { pinned: true });
    editors.open({ kind: "settings", resource: "settings" });
    editors.open(file("preview"), { preview: true });
    const a = editors.find(file("a"));
    if (a) editors.activate(a.id);
    expect(editors.toPersisted()).toEqual({
      openFiles: [
        { path: "a", kind: "file", pinned: false, staged: undefined, viewState: { scrollTop: 12 } },
        { path: "b", kind: "diff", pinned: true, staged: true, viewState: { scrollTop: 0 } },
      ],
      activeFile: "a",
    });
  });

  test("restore reopens tabs with their params, pins and view state", () => {
    const editors = new EditorService();
    editors.restore(
      [
        { path: "a", kind: "file", pinned: false, viewState: { scrollTop: 4 } },
        { path: "b", kind: "diff", pinned: true, staged: true },
      ],
      "b",
    );
    expect(editors.tabs.map((tab) => [tab.kind, tab.resource, tab.pinned, tab.params.staged])).toEqual([
      ["file", "a", false, undefined],
      ["diff", "b", true, true],
    ]);
    expect(editors.active?.resource).toBe("b");
    expect(editors.tabs[0]?.viewState).toEqual({ scrollTop: 4 });
    expect(editors.canGoBack).toBe(false);
  });
});
