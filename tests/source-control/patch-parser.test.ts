import { describe, expect, test } from "bun:test";
import { parseUnifiedDiff, unquoteGitPath } from "@/features/source-control/model";

const lines = (...parts: string[]) => `${parts.join("\n")}\n`;

describe("parseUnifiedDiff", () => {
  test("modified file with multiple hunks, numbers and section headings", () => {
    const diff = parseUnifiedDiff(
      lines(
        "diff --git a/src/app.ts b/src/app.ts",
        "index 1111111..2222222 100644",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,4 +1,4 @@",
        " import x from 'x';",
        "-const a = 1;",
        "+const a = 2;",
        " ",
        " export {};",
        "@@ -20,2 +20,4 @@ function main() {",
        "   one();",
        "+  two();",
        "+  three();",
        "   four();",
      ),
    );
    expect(diff).toMatchObject({
      oldPath: "src/app.ts",
      newPath: "src/app.ts",
      status: "modified",
      isBinary: false,
      added: 3,
      removed: 1,
      problems: [],
    });
    expect(diff.hunks).toHaveLength(2);
    const [first, second] = diff.hunks;
    expect(first).toMatchObject({ oldStart: 1, oldCount: 4, newStart: 1, newCount: 4, section: "" });
    expect(second).toMatchObject({
      header: "@@ -20,2 +20,4 @@ function main() {",
      oldStart: 20,
      newStart: 20,
      newCount: 4,
      section: "function main() {",
    });
    expect(first?.lines.map((l) => [l.kind, l.oldLine, l.newLine, l.text])).toEqual([
      ["context", 1, 1, "import x from 'x';"],
      ["removed", 2, null, "const a = 1;"],
      ["added", null, 2, "const a = 2;"],
      ["context", 3, 3, ""],
      ["context", 4, 4, "export {};"],
    ]);
    expect(second?.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ["context", 20, 20],
      ["added", null, 21],
      ["added", null, 22],
      ["context", 21, 23],
    ]);
  });

  test("new file (additions only) and deleted file (deletions only)", () => {
    const added = parseUnifiedDiff(
      lines(
        "diff --git a/new.txt b/new.txt",
        "new file mode 100644",
        "index 0000000..1111111",
        "--- /dev/null",
        "+++ b/new.txt",
        "@@ -0,0 +1,2 @@",
        "+one",
        "+two",
      ),
    );
    expect(added).toMatchObject({
      oldPath: null,
      newPath: "new.txt",
      status: "added",
      newMode: "100644",
      added: 2,
    });
    expect(added.hunks[0]?.lines.map((l) => l.newLine)).toEqual([1, 2]);

    const deleted = parseUnifiedDiff(
      lines(
        "diff --git a/old.txt b/old.txt",
        "deleted file mode 100755",
        "--- a/old.txt",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-one",
        "-two",
      ),
    );
    expect(deleted).toMatchObject({
      oldPath: "old.txt",
      newPath: null,
      status: "deleted",
      oldMode: "100755",
      removed: 2,
    });
    expect(deleted.hunks[0]?.lines.map((l) => l.oldLine)).toEqual([1, 2]);
  });

  test("hunk counts default to 1 when omitted", () => {
    const diff = parseUnifiedDiff(lines("--- a/f", "+++ b/f", "@@ -3 +3 @@", "-x", "+y"));
    expect(diff.hunks[0]).toMatchObject({ oldStart: 3, oldCount: 1, newStart: 3, newCount: 1 });
    expect(diff.problems).toEqual([]);
  });

  test("no newline at end of file on the old side, the new side, and both", () => {
    const oldSide = parseUnifiedDiff(
      lines("--- a/f", "+++ b/f", "@@ -1 +1 @@", "-last", "\\ No newline at end of file", "+last"),
    );
    expect(oldSide.hunks[0]?.lines.map((l) => [l.kind, l.noNewlineAtEnd])).toEqual([
      ["removed", true],
      ["added", false],
    ]);
    const newSide = parseUnifiedDiff(
      lines("--- a/f", "+++ b/f", "@@ -1 +1 @@", "-last", "+last", "\\ No newline at end of file"),
    );
    expect(newSide.hunks[0]?.lines.map((l) => l.noNewlineAtEnd)).toEqual([false, true]);
    const both = parseUnifiedDiff(
      lines(
        "--- a/f",
        "+++ b/f",
        "@@ -1,2 +1,2 @@",
        " a",
        "-b",
        "\\ No newline at end of file",
        "+c",
        "\\ No newline at end of file",
      ),
    );
    expect(both.hunks[0]?.lines.map((l) => l.noNewlineAtEnd)).toEqual([false, true, true]);
    expect(both.problems).toEqual([]);
    const context = parseUnifiedDiff(
      lines("--- a/f", "+++ b/f", "@@ -1,2 +1,2 @@", "-a", "+A", " end", "\\ No newline at end of file"),
    );
    expect(context.hunks[0]?.lines.at(-1)).toMatchObject({ kind: "context", noNewlineAtEnd: true });
  });

  test("CRLF content: text without \\r, crlf flag set; CRLF patch headers tolerated", () => {
    const diff = parseUnifiedDiff(
      "diff --git a/w.txt b/w.txt\r\n--- a/w.txt\r\n+++ b/w.txt\r\n@@ -1,2 +1,2 @@\r\n line one\r\n-old\r\n+new\r\n",
    );
    expect(diff.oldPath).toBe("w.txt");
    expect(diff.hunks[0]?.header).toBe("@@ -1,2 +1,2 @@");
    expect(diff.hunks[0]?.lines.map((l) => [l.text, l.crlf])).toEqual([
      ["line one", true],
      ["old", true],
      ["new", true],
    ]);
    // A line-ending-only change is visible through the flag.
    const eol = parseUnifiedDiff(lines("--- a/f", "+++ b/f", "@@ -1 +1 @@", "-same\r", "+same"));
    expect(eol.hunks[0]?.lines.map((l) => [l.text, l.crlf])).toEqual([
      ["same", true],
      ["same", false],
    ]);
  });

  test("Turkish text and emoji survive intact", () => {
    const diff = parseUnifiedDiff(
      lines(
        "--- a/çalışma/şırınga ığüşöç.ts",
        "+++ b/çalışma/şırınga ığüşöç.ts\t",
        "@@ -1 +1 @@",
        "-const selam = 'Merhaba dünya';",
        "+const selam = 'Merhaba dünya 🚀👩‍💻';",
      ),
    );
    expect(diff.oldPath).toBe("çalışma/şırınga ığüşöç.ts");
    expect(diff.newPath).toBe("çalışma/şırınga ığüşöç.ts");
    expect(diff.hunks[0]?.lines[1]?.text).toBe("const selam = 'Merhaba dünya 🚀👩‍💻';");
  });

  test("rename with edits and rename-only", () => {
    const edited = parseUnifiedDiff(
      lines(
        "diff --git a/old name.txt b/new name.txt",
        "similarity index 88%",
        "rename from old name.txt",
        "rename to new name.txt",
        "index 1111111..2222222 100644",
        "--- a/old name.txt\t",
        "+++ b/new name.txt\t",
        "@@ -1,2 +1,2 @@",
        " keep",
        "-before",
        "+after",
      ),
    );
    expect(edited).toMatchObject({
      oldPath: "old name.txt",
      newPath: "new name.txt",
      status: "renamed",
      similarity: 88,
      added: 1,
      removed: 1,
    });
    const renameOnly = parseUnifiedDiff(
      lines(
        "diff --git a/a.txt b/dir/b.txt",
        "similarity index 100%",
        "rename from a.txt",
        "rename to dir/b.txt",
      ),
    );
    expect(renameOnly).toMatchObject({
      oldPath: "a.txt",
      newPath: "dir/b.txt",
      status: "renamed",
      hunks: [],
      problems: [],
    });
  });

  test("copies and mode-only changes", () => {
    const copy = parseUnifiedDiff(
      lines("diff --git a/x b/y", "similarity index 100%", "copy from x", "copy to y"),
    );
    expect(copy).toMatchObject({ status: "copied", oldPath: "x", newPath: "y" });
    const mode = parseUnifiedDiff(
      lines("diff --git a/run me.sh b/run me.sh", "old mode 100644", "new mode 100755"),
    );
    expect(mode).toMatchObject({
      oldPath: "run me.sh",
      newPath: "run me.sh",
      oldMode: "100644",
      newMode: "100755",
      status: "modified",
      hunks: [],
      problems: [],
    });
  });

  test("binary markers", () => {
    const binary = parseUnifiedDiff(
      lines(
        "diff --git a/img.png b/img.png",
        "index 1111111..2222222 100644",
        "Binary files a/img.png and b/img.png differ",
      ),
    );
    expect(binary).toMatchObject({
      isBinary: true,
      oldPath: "img.png",
      newPath: "img.png",
      hunks: [],
      problems: [],
    });
    const newBinary = parseUnifiedDiff(
      lines(
        "diff --git a/b.bin b/b.bin",
        "new file mode 100644",
        "Binary files /dev/null and b/b.bin differ",
      ),
    );
    expect(newBinary).toMatchObject({ isBinary: true, status: "added", oldPath: null, newPath: "b.bin" });
    const gitBinary = parseUnifiedDiff(
      lines(
        "diff --git a/x.bin b/x.bin",
        "GIT binary patch",
        "literal 4",
        "LcmZQzWMT#Y01f~L",
        "",
        "literal 0",
        "HcmV?d00001",
        "",
      ),
    );
    expect(gitBinary).toMatchObject({ isBinary: true, problems: [] });
  });

  test("empty input", () => {
    for (const patch of ["", "\n", "   \n"]) {
      expect(parseUnifiedDiff(patch)).toMatchObject({
        isEmpty: true,
        hunks: [],
        added: 0,
        removed: 0,
        problems: [],
      });
    }
  });

  test("quoted paths with escapes and octal UTF-8 bytes", () => {
    expect(unquoteGitPath('"tab\\there.txt"')).toBe("tab\there.txt");
    expect(unquoteGitPath('"new\\nline \\"q\\" \\\\ back"')).toBe('new\nline "q" \\ back');
    expect(unquoteGitPath('"\\303\\247al\\304\\261\\305\\237ma"')).toBe("çalışma");
    expect(unquoteGitPath('"bad\\q"')).toBeNull();
    const diff = parseUnifiedDiff(
      lines(
        'diff --git "a/new\\nline.txt" "b/new\\nline.txt"',
        '--- "a/new\\nline.txt"',
        '+++ "b/new\\nline.txt"',
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ),
    );
    expect(diff.oldPath).toBe("new\nline.txt");
    expect(diff.newPath).toBe("new\nline.txt");
  });

  test("removed and added lines that look like file headers stay content", () => {
    const diff = parseUnifiedDiff(
      lines(
        "--- a/notes.md",
        "+++ b/notes.md",
        "@@ -1,2 +1,2 @@",
        "--- a/looks-like-a-header",
        "+++ b/also-content",
        " ctx",
      ),
    );
    expect(diff.oldPath).toBe("notes.md");
    expect(diff.hunks[0]?.lines.map((l) => [l.kind, l.text])).toEqual([
      ["removed", "-- a/looks-like-a-header"],
      ["added", "++ b/also-content"],
      ["context", "ctx"],
    ]);
  });

  test("blank context lines written without their leading space", () => {
    const diff = parseUnifiedDiff("--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n");
    expect(diff.hunks[0]?.lines.map((l) => [l.kind, l.text, l.oldLine])).toEqual([
      ["context", "a", 1],
      ["context", "", 2],
      ["removed", "b", 3],
      ["added", "c", null],
    ]);
    expect(diff.problems).toEqual([]);
  });

  test("conflict diffs from the adapter (unmerged notice line) parse cleanly", () => {
    const diff = parseUnifiedDiff(
      lines(
        "* Unmerged path f.txt",
        "diff --git a/f.txt b/f.txt",
        "--- a/f.txt",
        "+++ b/f.txt",
        "@@ -1 +1,5 @@",
        "+<<<<<<< HEAD",
        " ours",
        "+=======",
        "+theirs",
        "+>>>>>>> other",
      ),
    );
    expect(diff.problems).toEqual([]);
    expect(diff.added).toBe(4);
  });

  test("malformed input never throws and is described", () => {
    const truncated = parseUnifiedDiff(lines("--- a/f", "+++ b/f", "@@ -1,5 +1,5 @@", " a", "-b"));
    expect(truncated.hunks[0]?.lines).toHaveLength(2);
    expect(truncated.problems.join(" ")).toContain("incomplete");

    const badHeader = parseUnifiedDiff(lines("--- a/f", "+++ b/f", "@@ nonsense @@", "+x"));
    expect(badHeader.hunks).toEqual([]);
    expect(badHeader.problems.join(" ")).toContain("malformed hunk header");

    const twoFiles = parseUnifiedDiff(
      lines(
        "diff --git a/x b/x",
        "--- a/x",
        "+++ b/x",
        "@@ -1 +1 @@",
        "-1",
        "+2",
        "diff --git a/y b/y",
        "--- a/y",
      ),
    );
    expect(twoFiles.oldPath).toBe("x");
    expect(twoFiles.hunks).toHaveLength(1);
    expect(twoFiles.problems.join(" ")).toContain("more than one file");

    const combined = parseUnifiedDiff(lines("diff --cc f.txt", "@@@ -1,1 -1,1 +1,5 @@@", "++<<<<<<< HEAD"));
    expect(combined.problems.join(" ")).toContain("Combined");

    const overflow = parseUnifiedDiff(lines("--- a/f", "+++ b/f", "@@ -1 +1 @@", "-a", "+b", "+c"));
    expect(overflow.hunks[0]?.lines).toHaveLength(2);
    expect(overflow.problems.length).toBeGreaterThan(0);

    for (const garbage of ["@@", "@@ -", "\\", "+++", "diff --git", "\0\0\0", "@@ -1,2 +1,2 @@\n\\\n\\"]) {
      expect(() => parseUnifiedDiff(garbage)).not.toThrow();
    }
  });

  test("very long lines are kept whole", () => {
    const long = "x".repeat(50_000);
    const diff = parseUnifiedDiff(
      lines("--- a/min.js", "+++ b/min.js", "@@ -1 +1 @@", `-${long}`, `+${long}y`),
    );
    expect(diff.hunks[0]?.lines[1]?.text.length).toBe(50_001);
  });
});
