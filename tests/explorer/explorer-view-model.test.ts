import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileOps, FileTree } from "@/adapters/filesystem";
import { EDIT_ROW_KEY, type ExplorerEntryRow, ExplorerViewModel } from "@/features/explorer/model";
import { allRows, rowLabels, selected, setupExplorer, tempDir } from "./helpers";

function entry(rows: ReturnType<typeof allRows>, path: string): ExplorerEntryRow {
  const row = rows.find((candidate) => candidate.type === "entry" && candidate.path === path);
  if (row?.type !== "entry") throw new Error(`no entry row ${path}`);
  return row;
}

describe("rows", () => {
  test("carry display-safe names, icons, flags and guides", async () => {
    const root = await tempDir();
    const { model } = await setupExplorer(
      { "src/main.ts": "", ".env": "", "bad\nname.txt": "", "ığüşöç İstanbul.md": "", "README.md": "" },
      { root },
    );
    await symlink(join(root, "missing"), join(root, "broken"));
    await model.refresh();
    const rows = allRows(model);
    const labels = rowLabels(model);
    expect(labels[0]).toBe("src"); // Folders first.
    expect([...labels].sort()).toEqual([
      ".env",
      "README.md",
      "bad\nname.txt",
      "broken",
      "src",
      "ığüşöç İstanbul.md",
    ]);
    expect(entry(rows, "bad\nname.txt").name).toBe("bad�name.txt");
    expect(entry(rows, "ığüşöç İstanbul.md").name).toBe("ığüşöç İstanbul.md");
    expect(entry(rows, ".env").hidden).toBe(true);
    expect(entry(rows, "broken").symlink).toBe("broken");
    const src = entry(rows, "src");
    expect(src).toMatchObject({
      kind: "directory",
      expanded: false,
      depth: 0,
      dimmed: false,
      nameColor: "fg.default",
    });
    expect(src.icon.glyph).toBe("+");
    expect(entry(rows, "src").git).toBeNull();
    await model.right(); // Nothing selected: no-op.
    model.select("src");
    await model.right();
    expect(entry(allRows(model), "src").icon.glyph).toBe("-");
    expect(entry(allRows(model), "src/main.ts")).toMatchObject({ depth: 1, guides: [true], isLast: true });
  });

  test("unchanged rows keep their identity between reads", async () => {
    const { model } = await setupExplorer({ "a/x.txt": "", "b.txt": "", "c.txt": "" });
    const first = model.getRows(0, 3);
    const again = model.getRows(0, 3);
    expect(again[1]).toBe(first[1] as NonNullable<(typeof first)[1]>);
    model.select("b.txt");
    const afterSelect = model.getRows(0, 3);
    expect(afterSelect[1]).not.toBe(first[1] as NonNullable<(typeof first)[1]>);
    expect(afterSelect[1]?.selected).toBe(true);
    expect(afterSelect[2]).toBe(first[2] as NonNullable<(typeof first)[2]>);
  });

  test("a capped folder shows a 'more' row that expands on activation", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`big/f${String(i).padStart(2, "0")}.txt`, ""]),
    );
    const { model } = await setupExplorer(files, { tree: { maxChildrenRendered: 5 } });
    model.select("big");
    await model.right();
    const rows = allRows(model);
    const more = rows[rows.length - 1];
    expect(more).toMatchObject({ type: "more", hiddenCount: 7, label: "7 more…", depth: 1 });
    model.end();
    await model.enter();
    expect(model.store.get().rowCount).toBe(1 + 10 + 1);
  });
});

describe("keyboard navigation", () => {
  test("up/down/home/end/page and left/right through folders", async () => {
    const { model } = await setupExplorer({ "a/b/deep.txt": "", "a/one.txt": "", "c.txt": "", "d.txt": "" });
    model.moveDown();
    expect(selected(model)).toBe("a");
    await model.right();
    expect(rowLabels(model)).toEqual(["a", "a/b", "a/one.txt", "c.txt", "d.txt"]);
    expect(selected(model)).toBe("a");
    await model.right();
    expect(selected(model)).toBe("a/b");
    await model.right();
    await model.right();
    expect(selected(model)).toBe("a/b/deep.txt");
    await model.left();
    expect(selected(model)).toBe("a/b");
    await model.left();
    expect(rowLabels(model)).toEqual(["a", "a/b", "a/one.txt", "c.txt", "d.txt"]);
    await model.left();
    expect(selected(model)).toBe("a");
    model.end();
    expect(selected(model)).toBe("d.txt");
    model.moveDown();
    expect(selected(model)).toBe("d.txt");
    model.pageUp(3);
    expect(selected(model)).toBe("a/one.txt");
    model.home();
    expect(selected(model)).toBe("a");
    model.moveUp();
    expect(selected(model)).toBe("a");
    model.pageDown(10);
    expect(selected(model)).toBe("d.txt");
    expect(model.store.get().selectedIndex).toBe(4);
  });

  test("enter opens and keeps a file, space previews, folders toggle", async () => {
    const { model, opened } = await setupExplorer({ "dir/x.ts": "", "file.ts": "" });
    model.select("file.ts");
    await model.enter();
    await model.space();
    expect(opened).toEqual([
      { path: "file.ts", preview: false },
      { path: "file.ts", preview: true },
    ]);
    model.select("dir");
    await model.enter();
    expect(rowLabels(model)).toContain("dir/x.ts");
    await model.space();
    expect(rowLabels(model)).not.toContain("dir/x.ts");
  });

  test("type-ahead by first letters, cycling and refining", async () => {
    const { model, advance } = await setupExplorer({
      "alpha.ts": "",
      "beta.ts": "",
      "build.ts": "",
      "bundle.ts": "",
      "İstanbul.md": "",
    });
    model.typeAhead("b");
    expect(selected(model)).toBe("beta.ts");
    advance(100);
    model.typeAhead("b"); // Same letter again cycles.
    expect(selected(model)).toBe("build.ts");
    advance(100);
    model.typeAhead("b");
    expect(selected(model)).toBe("bundle.ts");
    advance(2000);
    model.typeAhead("b");
    advance(100);
    model.typeAhead("u");
    advance(100);
    model.typeAhead("i");
    expect(selected(model)).toBe("build.ts");
    advance(2000);
    model.typeAhead("i"); // Accent- and Turkish-insensitive.
    expect(selected(model)).toBe("İstanbul.md");
  });

  test("reveal expands ancestors, selects and returns the row to scroll to", async () => {
    const { model } = await setupExplorer({ "src/a/b/target.ts": "", "src/other.ts": "", "z.txt": "" });
    const index = await model.reveal("src/a/b/target.ts");
    expect(index).toBe(3);
    expect(model.store.get()).toMatchObject({ selectedKey: "src/a/b/target.ts", selectedIndex: 3 });
    expect(await model.reveal("src/missing.ts")).toBe(-1);
    model.setActiveFile("src/a/b/target.ts");
    expect(entry(allRows(model), "src/a/b/target.ts").active).toBe(true);
    expect(entry(allRows(model), "src/other.ts").active).toBe(false);
  });
});

describe("inline create and rename", () => {
  test("create a nested file: live validation, commit, reveal, open, undo", async () => {
    const { model, root, opened } = await setupExplorer({
      "src/existing.ts": "",
      "src/file.ts": "",
      "top.txt": "",
    });
    model.select("src");
    await model.beginCreate("file");
    expect(rowLabels(model)).toEqual(["src", "[edit ]", "src/existing.ts", "src/file.ts", "top.txt"]);
    expect(selected(model)).toBe(EDIT_ROW_KEY);
    const editRow = allRows(model)[1];
    expect(editRow).toMatchObject({ type: "edit", depth: 1, guides: [true], mode: "create-file" });

    const message = (value: string) => {
      model.setEditValue(value);
      return model.store.get().edit?.message ?? null;
    };
    expect(message("")).toMatchObject({ severity: "error", text: "Enter a name." });
    expect(message("../../escape.ts")?.text).toBe("The name must stay inside the workspace.");
    expect(message("../sibling.ts")?.text).toBe("Remove the empty, “.” or “..” parts.");
    expect(message("a//b.ts")?.severity).toBe("error");
    expect(message("bad\nname")?.text).toContain("cannot be used");
    expect(message("x".repeat(300))?.text).toBe("The name is too long.");
    expect(message("existing.ts")?.text).toContain("already exists");
    expect(message("file.ts/inner.ts")?.text).toBe("“file.ts” is a file, not a folder.");
    expect(message(" spaced.ts")).toMatchObject({ severity: "warning" });
    model.setEditValue("existing.ts");
    expect(await model.commitEdit()).toBeNull();
    expect(model.store.get().edit?.message?.severity).toBe("error");

    model.setEditValue("new/deep/ığüş.ts");
    expect(await model.commitEdit()).toBe("src/new/deep/ığüş.ts");
    expect(await readFile(join(root, "src/new/deep/ığüş.ts"), "utf8")).toBe("");
    expect(model.store.get().edit).toBeNull();
    expect(selected(model)).toBe("src/new/deep/ığüş.ts");
    expect(rowLabels(model)).toContain("src/new/deep/ığüş.ts");
    expect(opened).toEqual([{ path: "src/new/deep/ığüş.ts", preview: false }]);
    expect(model.store.get().undoDescription).toContain("src/new/deep/ığüş.ts");

    expect(await model.undo()).toContain("Remove the file");
    expect(rowLabels(model)).not.toContain("src/new");
    expect(model.store.get().notice?.kind).toBe("info");
  });

  test("the commit of a whitespace-warned name goes through", async () => {
    const { model, root } = await setupExplorer({});
    await model.beginCreate("folder");
    model.setEditValue("spaced ");
    expect(model.store.get().edit?.message?.severity).toBe("warning");
    expect(await model.commitEdit()).toBe("spaced ");
    expect((await stat(join(root, "spaced "))).isDirectory()).toBe(true);
  });

  test("create next to a selected file, and at the root with nothing selected", async () => {
    const { model } = await setupExplorer({ "dir/a.txt": "" });
    await model.beginCreate("folder");
    expect(rowLabels(model)).toEqual(["[edit ]", "dir"]);
    model.cancelEdit();
    expect(rowLabels(model)).toEqual(["dir"]);
    await model.reveal("dir/a.txt");
    await model.beginCreate("file");
    expect(rowLabels(model)).toEqual(["dir", "[edit ]", "dir/a.txt"]);
    model.setEditValue("b.txt");
    expect(await model.commitEdit()).toBe("dir/b.txt");
  });

  test("a failure reported by FileOps keeps the input open with the reason", async () => {
    const { model } = await setupExplorer({ "sub/taken.txt": "" });
    // "sub" is not loaded, so the live check cannot know "taken.txt" exists.
    await model.beginCreate("file");
    model.setEditValue("sub/taken.txt");
    expect(model.store.get().edit?.message).toBeNull();
    expect(await model.commitEdit()).toBeNull();
    expect(model.store.get().edit).toMatchObject({
      busy: false,
      message: { severity: "error", text: expect.stringContaining("already exists") },
    });
  });

  test("rename in place, unchanged, case-only, and refused when taken", async () => {
    const { model, root } = await setupExplorer({ "readme.md": "hi", "other.md": "" });
    model.select("readme.md");
    expect(model.beginRename()).toBe(true);
    const rowCount = model.store.get().rowCount;
    const editRow = allRows(model).find((row) => row.type === "edit");
    expect(editRow).toMatchObject({ key: "readme.md", value: "readme.md", mode: "rename" });
    expect(model.store.get().rowCount).toBe(rowCount);

    model.setEditValue("other.md");
    expect(model.store.get().edit?.message?.text).toContain("already exists");
    model.setEditValue("readme.md");
    expect(await model.commitEdit()).toBe("readme.md"); // Unchanged: nothing to do.

    model.beginRename();
    model.setEditValue("README.md");
    expect(model.store.get().edit?.message).toBeNull();
    expect(await model.commitEdit()).toBe("README.md");
    expect(rowLabels(model)).toEqual(["other.md", "README.md"]);
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("hi");

    model.beginRename();
    model.setEditValue("docs/moved.md");
    expect(await model.commitEdit()).toBe("docs/moved.md");
    expect(selected(model)).toBe("docs/moved.md");
    expect(await model.undo()).toContain("back to");
    expect(rowLabels(model)).toContain("README.md");

    model.select("README.md");
    model.beginRename();
    model.cancelEdit();
    expect(model.store.get().edit).toBeNull();
    expect(rowLabels(model)).toEqual(["other.md", "README.md"]);
  });

  test("long names are validated against the 255-byte limit", async () => {
    const { model } = await setupExplorer({});
    await model.beginCreate("file");
    model.setEditValue("ş".repeat(127));
    expect(model.store.get().edit?.message).toBeNull();
    model.setEditValue("ş".repeat(128));
    expect(model.store.get().edit?.message?.text).toBe("The name is too long.");
  });
});

describe("delete and undo", () => {
  test("confirmation data, cancel, confirm, neighbor selection and undo", async () => {
    const { model, root } = await setupExplorer({
      "dir/a.txt": "",
      "dir/sub/b.txt": "",
      "next.txt": "",
      "z.txt": "",
    });
    model.select("dir");
    const confirmation = await model.requestDelete();
    expect(confirmation).toMatchObject({
      path: "dir",
      kind: "directory",
      itemCount: 3,
      itemCountCapped: false,
      title: "Delete the folder “dir” and the 3 items inside it?",
      detail: "It will be moved to Lucy's undo trash. You can undo this.",
      confirmLabel: "Move to Trash",
    });
    expect(model.store.get().pendingDelete?.path).toBe("dir");
    model.cancelDelete();
    expect(model.store.get().pendingDelete).toBeNull();

    await model.requestDelete();
    expect(await model.confirmDelete()).toBe(true);
    expect(rowLabels(model)).toEqual(["next.txt", "z.txt"]);
    expect(selected(model)).toBe("next.txt");
    expect(model.store.get().undoDescription).toBe("Restore the deleted folder “dir”");

    expect(await model.undo()).toBe("Restore the deleted folder “dir”");
    expect(rowLabels(model)).toEqual(["dir", "next.txt", "z.txt"]);
    expect(await readFile(join(root, "dir/sub/b.txt"), "utf8")).toBe("");
    expect(model.store.get().notice).toEqual({
      kind: "info",
      message: "Restore the deleted folder “dir”",
    });
    model.dismissNotice();
    expect(model.store.get().notice).toBeNull();
    expect(await model.undo()).toBeNull();
  });

  test("files, links and failures", async () => {
    const { model, root } = await setupExplorer({ "a.txt": "", "b.txt": "", "target.txt": "keep" });
    await symlink("target.txt", join(root, "link"));
    await model.refresh();
    expect((await model.requestDelete("a.txt"))?.title).toBe("Delete “a.txt”?");
    expect((await model.requestDelete("link"))?.title).toContain("Its target is not affected");
    expect(await model.confirmDelete()).toBe(true);
    expect(await readFile(join(root, "target.txt"), "utf8")).toBe("keep");

    await model.requestDelete("b.txt");
    await rm(join(root, "b.txt"));
    expect(await model.confirmDelete()).toBe(false);
    expect(model.store.get().notice).toMatchObject({ kind: "error" });
    expect(await model.confirmDelete()).toBe(false); // Nothing pending.
  });

  test("an empty folder and a large folder", async () => {
    const files = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`many/f${i}.txt`, ""]));
    const { model, root, tree, fileOps } = await setupExplorer(files);
    await mkdir(join(root, "empty"));
    await model.refresh();
    expect((await model.requestDelete("empty"))?.title).toBe("Delete the empty folder “empty”?");
    const limited = new ExplorerViewModel({ tree, fileOps, iconTier: "ascii", deleteCountLimit: 10 });
    expect(await limited.requestDelete("many")).toMatchObject({ itemCount: 10, itemCountCapped: true });
    expect((await limited.requestDelete("many"))?.title).toContain("more than 10 items");
    limited.dispose();
  });
});

describe("filter, options, watch batches, snapshots", () => {
  test("filter summary and clearing", async () => {
    const files = ["src/components/Button.tsx", "src/components/Card.tsx", "docs/guide.md"];
    const { model } = await setupExplorer(Object.fromEntries(files.map((file) => [file, ""])), {
      tree: { listAllFiles: async () => files },
    });
    await model.setFilter("button");
    expect(model.store.get().filter).toMatchObject({ active: true, matchCount: 1, summary: "1 match" });
    expect(rowLabels(model)).toEqual(["src", "src/components", "src/components/Button.tsx"]);
    await model.setFilter(".");
    expect(model.store.get().filter.summary).toBe("3 matches");
    await model.setFilter("zzz");
    expect(model.store.get().filter.summary).toBe("No matches");
    await model.clearFilter();
    expect(model.store.get().filter).toMatchObject({ active: false, summary: "" });
    expect(rowLabels(model)).toEqual(["docs", "src"]);
  });

  test("show hidden / ignored options", async () => {
    const { model } = await setupExplorer({ ".env": "", "a.txt": "" });
    model.setShowHidden(false);
    expect(rowLabels(model)).toEqual(["a.txt"]);
    expect(model.store.get().showHidden).toBe(false);
    model.setShowHidden(true);
    model.setShowIgnored(false);
    expect(model.store.get()).toMatchObject({ showHidden: true, showIgnored: false });
    expect(rowLabels(model)).toEqual([".env", "a.txt"]);
  });

  test("watch batches and refresh pick up disk changes; the selection follows a deleted row", async () => {
    const { model, root } = await setupExplorer({ "a.txt": "", "b.txt": "" });
    await writeFile(join(root, "c.txt"), "");
    await model.handleWatchBatch({ paths: ["c.txt"], gitMetaChanged: false, overflow: false });
    expect(rowLabels(model)).toEqual(["a.txt", "b.txt", "c.txt"]);
    model.select("b.txt");
    await rm(join(root, "b.txt"));
    await model.refresh();
    expect(model.store.get()).toMatchObject({ selectedKey: "b.txt", selectedIndex: -1 });
    model.moveDown(); // Continues from where the selection was.
    expect(selected(model)).toBe("c.txt");
  });

  test("export and restore expansion and selection", async () => {
    const files = { "a/b/c.txt": "", "a/d.txt": "", "e/f.txt": "" };
    const first = await setupExplorer(files);
    await first.model.reveal("a/b/c.txt");
    const snapshot = first.model.exportSnapshot();
    expect(snapshot).toEqual({ expanded: ["a", "a/b"], selected: "a/b/c.txt" });
    first.model.dispose();

    const second = await setupExplorer({}, { root: first.root });
    await second.model.restoreSnapshot(snapshot);
    expect(rowLabels(second.model)).toEqual(["a", "a/b", "a/b/c.txt", "a/d.txt", "e"]);
    expect(selected(second.model)).toBe("a/b/c.txt");
  });

  test("root errors are reported", async () => {
    const root = await tempDir();
    await rm(root, { recursive: true });
    const tree = new FileTree({ root, detectIgnored: false });
    const fileOps = new FileOps({ root, trashDir: join(await tempDir(), "trash") });
    const model = new ExplorerViewModel({ tree, fileOps, iconTier: "ascii" });
    await model.initialize();
    expect(model.store.get().rootError).toBe("The folder no longer exists.");
    expect(model.store.get().loading).toBe(false);
  });
});

describe("large folders", () => {
  test("a 20k-entry folder: producing rows stays cheap", async () => {
    const root = await tempDir();
    await mkdir(join(root, "big"));
    await Promise.all(
      Array.from({ length: 20_000 }, (_, i) => writeFile(join(root, "big", `file-${i}.ts`), "")),
    );
    const { model } = await setupExplorer({}, { root, tree: { maxChildrenRendered: 20_000 } });
    let started = performance.now();
    model.select("big");
    await model.right();
    const expandMs = performance.now() - started;
    const count = model.store.get().rowCount;
    expect(count).toBe(20_001);
    started = performance.now();
    const windowRows = model.getRows(5000, 5060);
    const windowMs = performance.now() - started;
    started = performance.now();
    const all = model.getRows(0, count);
    const allMs = performance.now() - started;
    started = performance.now();
    for (let i = 0; i < 100; i++) model.moveDown();
    model.getRows(0, 60);
    const keysMs = performance.now() - started;
    console.log(
      `[explorer] 20k entries: expand ${expandMs.toFixed(1)} ms, 60-row window ${windowMs.toFixed(2)} ms, ` +
        `all 20,001 rows ${allMs.toFixed(1)} ms, 100 key presses + window ${keysMs.toFixed(1)} ms`,
    );
    expect(windowRows.length).toBe(60);
    expect(all.length).toBe(20_001);
    expect(windowMs).toBeLessThan(50);
    expect(selected(model)).toBe("big/file-99.ts");
  }, 60_000);
});
