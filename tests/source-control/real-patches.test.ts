/**
 * Patches produced by real Git through the adapter, parsed and turned into rows. The parser must
 * report no problems and agree with Git's own numstat counts.
 */
import { describe, expect, test } from "bun:test";
import type { GitCliAdapter, GitDiffTarget } from "@/adapters/git";
import { DiffModel, type ParsedDiff, parseUnifiedDiff } from "@/features/source-control/model";
import type { FixtureRepo } from "../helpers/git-fixture";
import { registerCleanup, repo } from "./support";

registerCleanup();

async function parsed(git: GitCliAdapter, target: GitDiffTarget): Promise<ParsedDiff> {
  const diff = await git.diff(target);
  const result = parseUnifiedDiff(diff.patch);
  expect(result.problems).toEqual([]);
  return result;
}

async function numstat(fx: FixtureRepo, ...args: string[]): Promise<[number, number]> {
  const out = (await fx.git("diff", "--numstat", ...args)).trim();
  const [added = "0", removed = "0"] = out.split("\t");
  return [Number(added), Number(removed)];
}

describe("real patches", () => {
  test("multiple hunks match Git's numstat", async () => {
    const original = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    const { fx, git } = await repo({ files: { "f.txt": `${original.join("\n")}\n` }, commit: "init" });
    const edited = [...original];
    edited[2] = "changed 3";
    edited.splice(30, 1);
    edited.splice(50, 0, "inserted near 51");
    await fx.write("f.txt", `${edited.join("\n")}\n`);
    const diff = await parsed(git, { path: "f.txt" });
    expect(diff.hunks.length).toBe(3);
    expect([diff.added, diff.removed]).toEqual(await numstat(fx, "--", "f.txt"));
    // Every line number in a hunk is consistent with the hunk header.
    for (const hunk of diff.hunks) {
      const old = hunk.lines.filter((l) => l.oldLine !== null).map((l) => l.oldLine);
      expect(old[0]).toBe(hunk.oldStart);
      expect(old.length).toBe(hunk.oldCount);
    }
  });

  test("additions only (untracked) and deletions only", async () => {
    const { fx, git } = await repo({ files: { "gone.txt": "a\nb\nc\n" }, commit: "init" });
    await fx.write("new.txt", "1\n2\n");
    const added = await parsed(git, { path: "new.txt" });
    expect(added).toMatchObject({ status: "added", oldPath: null, newPath: "new.txt", added: 2, removed: 0 });
    await fx.remove("gone.txt");
    const deleted = await parsed(git, { path: "gone.txt" });
    expect(deleted).toMatchObject({
      status: "deleted",
      oldPath: "gone.txt",
      newPath: null,
      added: 0,
      removed: 3,
    });
  });

  test("no newline at end of file on either side", async () => {
    const { fx, git } = await repo({ files: { "a.txt": "x\nlast", "b.txt": "x\nlast\n" }, commit: "init" });
    await fx.write("a.txt", "x\nlast\n");
    await fx.write("b.txt", "x\nlast");
    const a = await parsed(git, { path: "a.txt" });
    expect(a.hunks[0]?.lines.map((l) => [l.kind, l.noNewlineAtEnd])).toEqual([
      ["context", false],
      ["removed", true],
      ["added", false],
    ]);
    const b = await parsed(git, { path: "b.txt" });
    expect(b.hunks[0]?.lines.map((l) => [l.kind, l.noNewlineAtEnd])).toEqual([
      ["context", false],
      ["removed", false],
      ["added", true],
    ]);
  });

  test("CRLF content", async () => {
    const { fx, git } = await repo({ files: { "w.txt": "one\r\ntwo\r\nthree\r\n" }, commit: "init" });
    await fx.write("w.txt", "one\r\nTWO\r\nthree\r\n");
    const diff = await parsed(git, { path: "w.txt" });
    expect(diff.hunks[0]?.lines.map((l) => [l.kind, l.text, l.crlf])).toEqual([
      ["context", "one", true],
      ["removed", "two", true],
      ["added", "TWO", true],
      ["context", "three", true],
    ]);
  });

  test("Turkish text, emoji and a Turkish path", async () => {
    const path = "çalışma/şırınga ığüşöç.ts";
    const { fx, git } = await repo({ files: { [path]: "const ad = 'Ayşe';\n" }, commit: "init" });
    await fx.write(path, "const ad = 'Ayşe Yılmaz 🚀';\n");
    const diff = await parsed(git, { path });
    expect(diff.oldPath).toBe(path);
    expect(diff.newPath).toBe(path);
    expect(diff.hunks[0]?.lines[1]?.text).toBe("const ad = 'Ayşe Yılmaz 🚀';");
    const model = new DiffModel(diff);
    expect(
      model.wordRanges({ hunk: 0, line: 1 })?.map((r) => diff.hunks[0]?.lines[1]?.text.slice(r.start, r.end)),
    ).toEqual([" Yılmaz 🚀"]);
  });

  test("names Git must quote (newline, tab, quote) round-trip", async () => {
    const { fx, git } = await repo({ files: { "seed.txt": "s\n" }, commit: "init" });
    const names = ["new\nline.txt", "tab\there.txt", 'q"uote.txt'];
    for (const name of names) await fx.write(name, "x\n");
    await fx.commitAll("weird names");
    for (const name of names) {
      await fx.write(name, "y\n");
      const diff = await parsed(git, { path: name });
      expect([diff.oldPath, diff.newPath]).toEqual([name, name]);
    }
  });

  test("staged rename with edits", async () => {
    const body = Array.from({ length: 20 }, (_, i) => `row ${i}`).join("\n");
    const { fx, git } = await repo({ files: { "old name.txt": `${body}\n` }, commit: "init" });
    await fx.git("mv", "old name.txt", "new name.txt");
    await fx.write("new name.txt", `${body.replace("row 5", "row five")}\n`);
    await fx.git("add", "new name.txt");
    const diff = await parsed(git, { path: "new name.txt", origPath: "old name.txt", staged: true });
    expect(diff).toMatchObject({
      status: "renamed",
      oldPath: "old name.txt",
      newPath: "new name.txt",
      added: 1,
      removed: 1,
    });
    expect(diff.similarity).toBeGreaterThan(50);
  });

  test("binary, empty and mode-only patches", async () => {
    const { fx, git } = await repo({
      files: { "bin.dat": new Uint8Array([0, 1, 2]), "run.sh": "echo hi\n" },
      commit: "init",
    });
    await fx.write("bin.dat", new Uint8Array([0, 1, 2, 3]));
    const binary = await git.diff({ path: "bin.dat" });
    expect(binary.isBinary).toBe(true);
    expect(parseUnifiedDiff(binary.patch)).toMatchObject({ isEmpty: true, problems: [] });
    expect(await parsed(git, { path: "run.sh" })).toMatchObject({ isEmpty: true, hunks: [] });
    await fx.git("update-index", "--chmod=+x", "run.sh");
    const mode = await parsed(git, { path: "run.sh", staged: true });
    expect(mode).toMatchObject({ oldMode: "100644", newMode: "100755", hunks: [], isEmpty: false });
  });

  test("very long lines", async () => {
    const long = `const data = "${"x".repeat(100_000)}";`;
    const { fx, git } = await repo({ files: { "min.js": `${long}\n` }, commit: "init" });
    await fx.write("min.js", `${long.replace("const", "let")}\n`);
    const diff = await parsed(git, { path: "min.js" });
    expect(diff.hunks[0]?.lines[1]?.text.length).toBe(long.length - 2);
    const model = new DiffModel(diff);
    // Word diff is skipped for lines this long.
    expect(model.wordRanges({ hunk: 0, line: 1 })).toBeNull();
  });

  test("a 20 000-line real patch (timings printed)", async () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `export const value${i} = ${i};`);
    const { fx, git } = await repo({ files: { "big.ts": `${lines.join("\n")}\n` }, commit: "init" });
    // Change every 10th line: about 2 000 changes spread over the file.
    await fx.write(
      "big.ts",
      `${lines.map((line, i) => (i % 10 === 0 ? line.replace("const", "let") : line)).join("\n")}\n`,
    );
    await fx.write("fresh.ts", `${lines.join("\n")}\n`);

    let t = performance.now();
    const modified = await git.diff({ path: "big.ts" });
    const gitMs = performance.now() - t;
    t = performance.now();
    const diff = parseUnifiedDiff(modified.patch);
    const parseMs = performance.now() - t;
    t = performance.now();
    const model = new DiffModel(diff);
    const rowsMs = performance.now() - t;
    t = performance.now();
    const split = model.split;
    const splitMs = performance.now() - t;
    expect(diff.problems).toEqual([]);
    expect([diff.added, diff.removed]).toEqual(await numstat(fx, "--", "big.ts"));
    expect(split.length).toBeGreaterThan(0);

    t = performance.now();
    const fresh = parseUnifiedDiff((await git.diff({ path: "fresh.ts" })).patch);
    const freshModel = new DiffModel(fresh);
    const freshMs = performance.now() - t;
    expect(fresh.added).toBe(20_000);
    expect(freshModel.unified).toHaveLength(20_001);
    console.log(
      `real 20k-line file, 2 000 changes: git diff ${gitMs.toFixed(0)} ms, parse ${parseMs.toFixed(1)} ms (${modified.patch.split("\n").length} patch lines), unified ${rowsMs.toFixed(1)} ms, split ${splitMs.toFixed(1)} ms; untracked 20k-line file diff+parse+rows ${freshMs.toFixed(0)} ms`,
    );
  });
});
