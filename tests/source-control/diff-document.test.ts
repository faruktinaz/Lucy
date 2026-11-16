import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createGitAdapterFactory,
  type GitAdapter,
  type GitDiffTarget,
  type GitRevision,
  GitService,
} from "@/adapters/git";
import { SyntaxService } from "@/adapters/syntax";
import { detectLanguage } from "@/adapters/syntax/languages";
import { isLucyError } from "@/core/errors";
import {
  DiffDocument,
  type DiffSource,
  loadDiffDocument,
  type UnifiedLineRow,
} from "@/features/source-control/model";
import { createTempDir } from "../helpers/git-fixture";
import { createConflictRepo, deferCleanup, FakeSyntax, registerCleanup, repo } from "./support";

registerCleanup();

/** Records which sides the document read. */
function spy(git: GitAdapter): DiffSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    diff: (target, options) => git.diff(target, options),
    fileAtRevision: (path: string, revision: GitRevision, options) => {
      reads.push(`${revision}:${path}`);
      return git.fileAtRevision(path, revision, options);
    },
  };
}

function lineRows(doc: DiffDocument): UnifiedLineRow[] {
  return doc.unified.filter((row): row is UnifiedLineRow => row.kind === "line");
}

/** The highlighted word of a row, according to the document's tokens. */
function coloredWord(doc: DiffDocument, row: UnifiedLineRow): string | null {
  const token = doc.tokensForUnifiedRow(row)[0];
  return token ? row.text.slice(token.start, token.end) : null;
}

describe("loadDiffDocument", () => {
  test("unstaged: INDEX vs WORKTREE, tokens per side", async () => {
    const { fx, git } = await repo({
      files: { "app.ts": "alpha one\nbeta two\ngamma three\n" },
      commit: "init",
    });
    await fx.write("app.ts", "alpha one\ndelta two\ngamma three\n");
    const source = spy(git);
    const syntax = new FakeSyntax();
    const doc = await loadDiffDocument({ path: "app.ts" }, { git: source, syntax });
    expect(doc.mode).toBe("unstaged");
    expect(source.reads.sort()).toEqual(["INDEX:app.ts", "WORKTREE:app.ts"]);
    expect(doc.language.id).toBe("typescript");
    expect(doc.old).toMatchObject({ revision: "INDEX", exists: true, highlighted: true });
    expect(doc.new).toMatchObject({ revision: "WORKTREE", exists: true, highlighted: true });
    expect(lineRows(doc).map((row) => [row.sign, coloredWord(doc, row)])).toEqual([
      [" ", "alpha"],
      ["-", "beta"],
      ["+", "delta"],
      [" ", "gamma"],
    ]);
    expect(doc.split.length).toBeGreaterThan(0);
    const pair = doc.split.find((row) => row.kind === "pair" && row.left?.type === "removed");
    if (pair?.kind !== "pair" || !pair.left || !pair.right) throw new Error("expected a change pair");
    expect(doc.tokensForCell("old", pair.left)[0]).toEqual({ start: 0, end: 4, group: "keyword" });
    expect(doc.tokensForCell("new", pair.right)[0]).toEqual({ start: 0, end: 5, group: "keyword" });
    expect(doc.model.wordRanges({ hunk: 0, line: 1 })).toEqual([{ start: 0, end: 4 }]);
  });

  test("staged: HEAD vs INDEX, even when the working tree changed again", async () => {
    const { fx, git } = await repo({ files: { "s.ts": "first\nsecond\n" }, commit: "init" });
    await fx.write("s.ts", "first\nstaged\n");
    await fx.git("add", "s.ts");
    await fx.write("s.ts", "first\nworktree\n");
    const source = spy(git);
    const doc = await loadDiffDocument(
      { path: "s.ts", staged: true },
      { git: source, syntax: new FakeSyntax() },
    );
    expect(doc.mode).toBe("staged");
    expect(source.reads.sort()).toEqual(["HEAD:s.ts", "INDEX:s.ts"]);
    const added = lineRows(doc).find((row) => row.type === "added");
    expect(added?.text).toBe("staged");
    expect(added ? coloredWord(doc, added) : null).toBe("staged");
  });

  test("untracked: nothing vs WORKTREE", async () => {
    const { fx, git } = await repo({ files: { "seed.txt": "s\n" }, commit: "init" });
    await fx.write("new.py", "def main():\n    return 1\n");
    const source = spy(git);
    const doc = await loadDiffDocument({ path: "new.py" }, { git: source, syntax: new FakeSyntax() });
    expect(doc.mode).toBe("untracked");
    expect(source.reads).toEqual(["WORKTREE:new.py"]);
    expect(doc.language.id).toBe("python");
    expect(doc.old).toMatchObject({ revision: null, exists: false, highlighted: false });
    expect(lineRows(doc).map((row) => [row.sign, coloredWord(doc, row)])).toEqual([
      ["+", "def"],
      ["+", "return"],
    ]);
  });

  test("conflict: OURS vs WORKTREE with markers", async () => {
    const { git } = await createConflictRepo();
    const source = spy(git);
    const doc = await loadDiffDocument({ path: "f.txt" }, { git: source, syntax: new FakeSyntax() });
    expect(doc.mode).toBe("conflict");
    expect(source.reads.sort()).toEqual(["OURS:f.txt", "WORKTREE:f.txt"]);
    expect(lineRows(doc).map((row) => `${row.sign}${row.text}`)).toEqual([
      "+<<<<<<< HEAD",
      " ours",
      "+=======",
      "+theirs",
      "+>>>>>>> other",
    ]);
  });

  test("staged rename with edits reads the old side from the original path", async () => {
    const body = Array.from({ length: 12 }, (_, i) => `row${i} text`).join("\n");
    const { fx, git } = await repo({ files: { "before.ts": `${body}\n` }, commit: "init" });
    await fx.git("mv", "before.ts", "after.ts");
    await fx.write("after.ts", `${body.replace("row3 text", "renamed3 text")}\n`);
    await fx.git("add", "after.ts");
    const source = spy(git);
    const doc = await loadDiffDocument(
      { path: "after.ts", origPath: "before.ts", staged: true },
      { git: source, syntax: new FakeSyntax() },
    );
    expect(source.reads.sort()).toEqual(["HEAD:before.ts", "INDEX:after.ts"]);
    expect(doc.diff.status).toBe("renamed");
    const removed = lineRows(doc).find((row) => row.type === "removed");
    expect(removed ? coloredWord(doc, removed) : null).toBe("row3");
  });

  test("deleted file has no new side", async () => {
    const { fx, git } = await repo({ files: { "gone.ts": "bye\n" }, commit: "init" });
    await fx.remove("gone.ts");
    const source = spy(git);
    const doc = await loadDiffDocument({ path: "gone.ts" }, { git: source, syntax: new FakeSyntax() });
    expect(source.reads).toEqual(["INDEX:gone.ts"]);
    expect(doc.new).toMatchObject({ revision: null, exists: false });
    expect(coloredWord(doc, lineRows(doc)[0] as UnifiedLineRow)).toBe("bye");
  });

  test("binary, too large, empty and mode-only diffs", async () => {
    const { fx, git } = await repo({
      files: { "b.bin": new Uint8Array([0, 1]), "big.txt": "x\n", "same.txt": "s\n", "run.sh": "echo\n" },
      commit: "init",
    });
    await fx.write("b.bin", new Uint8Array([0, 1, 2]));
    const source = spy(git);
    const binary = await loadDiffDocument({ path: "b.bin" }, { git: source, syntax: new FakeSyntax() });
    expect(binary).toMatchObject({ isBinary: true, isTooLarge: false, isEmpty: false });
    expect(binary.unified).toEqual([]);
    expect(source.reads).toEqual([]);

    await fx.write("big.txt", "line\n".repeat(10_000));
    const large = await git.diff({ path: "big.txt" }, { maxBytes: 1_000 });
    expect(large.isTooLarge).toBe(true);
    const tooLarge = await loadDiffDocument(
      { path: "big.txt" },
      {
        git: {
          diff: (t, o) => git.diff(t, { ...o, maxBytes: 1_000 }),
          fileAtRevision: source.fileAtRevision,
        },
      },
    );
    expect(tooLarge).toMatchObject({ isTooLarge: true, isEmpty: false });
    expect(tooLarge.unified).toEqual([]);

    expect((await loadDiffDocument({ path: "same.txt" }, { git })).isEmpty).toBe(true);

    await fx.git("update-index", "--chmod=+x", "run.sh");
    const mode = await loadDiffDocument({ path: "run.sh", staged: true }, { git });
    expect(mode.modeChange).toEqual({ oldMode: "100644", newMode: "100755" });
    expect(mode.isEmpty).toBe(true);
  });

  test("a side over the file size limit simply has no tokens", async () => {
    const { fx, git } = await repo({ files: { "f.ts": "keep\nold\n" }, commit: "init" });
    await fx.write("f.ts", `keep\nnew\n${"padding\n".repeat(200)}`);
    const doc = await loadDiffDocument(
      { path: "f.ts" },
      { git, syntax: new FakeSyntax() },
      { maxFileBytes: 100 },
    );
    expect(doc.old).toMatchObject({ highlighted: true, isTooLarge: false });
    expect(doc.new).toMatchObject({ highlighted: false, isTooLarge: true });
    const added = lineRows(doc).find((row) => row.type === "added");
    expect(added ? doc.tokensForUnifiedRow(added) : null).toEqual([]);
    expect(lineRows(doc).length).toBeGreaterThan(0);
  });

  test("works without a syntax provider and through GitService", async () => {
    const { fx } = await repo({ files: { "x.go": "package main\n" }, commit: "init" });
    await fx.write("x.go", "package other\n");
    const service = new GitService(createGitAdapterFactory(fx.root, { env: fx.env }));
    deferCleanup(() => service.dispose());
    const doc = await loadDiffDocument({ path: "x.go" }, { git: service });
    expect(doc.language.id).toBe("go");
    expect(doc.old.highlighted).toBe(false);
    expect(doc.tokensForUnifiedRow(lineRows(doc)[0] as UnifiedLineRow)).toEqual([]);
  });

  test("cancellation before start and while highlighting", async () => {
    const { fx, git } = await repo({ files: { "c.ts": "a\n" }, commit: "init" });
    await fx.write("c.ts", "b\n");
    const before = new AbortController();
    before.abort();
    const early = await loadDiffDocument({ path: "c.ts" }, { git }, { signal: before.signal }).catch(
      (e: unknown) => e,
    );
    expect(isLucyError(early, "CANCELLED")).toBe(true);

    const syntax = new FakeSyntax();
    let release = (): void => {};
    syntax.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    const pending = loadDiffDocument({ path: "c.ts" }, { git, syntax }, { signal: controller.signal }).catch(
      (e: unknown) => e,
    );
    while (syntax.highlighted.length === 0) await Bun.sleep(5);
    controller.abort();
    expect(isLucyError(await pending, "CANCELLED")).toBe(true);
    release();
  });
});

describe("DiffDocument token safety", () => {
  const target: GitDiffTarget = { path: "a.ts" };
  const patch = "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n";
  const tokens = [[{ start: 0, end: 4, group: "keyword" }], [{ start: 0, end: 3, group: "keyword" }]];

  test("tokens are returned only when the file line equals the patch line", () => {
    const doc = new DiffDocument({
      target,
      mode: "unstaged",
      patch,
      isBinary: false,
      isTooLarge: false,
      language: detectLanguage("a.ts"),
      old: {
        revision: "INDEX",
        path: "a.ts",
        content: { exists: true, content: "keep\nold\n", isBinary: false, isTooLarge: false, size: 9 },
        tokens,
      },
      // The working tree changed after the patch was taken: line 2 is now "NEW".
      new: {
        revision: "WORKTREE",
        path: "a.ts",
        content: { exists: true, content: "keep\nNEW\n", isBinary: false, isTooLarge: false, size: 9 },
        tokens,
      },
    });
    const rows = lineRows(doc);
    expect(doc.tokensForUnifiedRow(rows[1] as UnifiedLineRow)).toEqual([
      { start: 0, end: 3, group: "keyword" },
    ]);
    expect(doc.tokensForUnifiedRow(rows[2] as UnifiedLineRow)).toEqual([]);
    expect(doc.tokensForUnifiedRow(rows[0] as UnifiedLineRow)).toHaveLength(1);
    expect(doc.tokensFor("new", 99)).toEqual([]);
  });

  test("CRLF files: the comparison ignores the carriage return", () => {
    const doc = new DiffDocument({
      target,
      mode: "unstaged",
      patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\r\n+new\r\n",
      isBinary: false,
      isTooLarge: false,
      language: detectLanguage("a.ts"),
      new: {
        revision: "WORKTREE",
        path: "a.ts",
        content: { exists: true, content: "new\r\n", isBinary: false, isTooLarge: false, size: 5 },
        tokens: [[{ start: 0, end: 3, group: "keyword" }]],
      },
    });
    const added = lineRows(doc).find((row) => row.type === "added") as UnifiedLineRow;
    expect(doc.tokensForUnifiedRow(added)).toHaveLength(1);
  });
});

describe("with the real SyntaxService", () => {
  const dir = createTempDir("lucy-scm-syntax-");
  const syntax = new SyntaxService({ dataPath: join(dir.path, "cache") });
  afterAll(async () => {
    await syntax.disposeAsync();
    dir.dispose();
  });

  test("TypeScript sides are highlighted and mapped to rows", async () => {
    const { fx, git } = await repo({
      files: { "m.ts": "const a = 1;\nexport function f() {}\n" },
      commit: "init",
    });
    await fx.write("m.ts", "let a = 1;\nexport function f() {}\n");
    const doc = await loadDiffDocument({ path: "m.ts" }, { git, syntax });
    expect(doc.old.highlighted).toBe(true);
    expect(doc.new.highlighted).toBe(true);
    const removed = lineRows(doc).find((row) => row.type === "removed") as UnifiedLineRow;
    const added = lineRows(doc).find((row) => row.type === "added") as UnifiedLineRow;
    expect(coloredWord(doc, removed)).toBe("const");
    expect(coloredWord(doc, added)).toBe("let");
    expect(doc.tokensForUnifiedRow(removed)[0]?.group).toStartWith("keyword");
  });
});
