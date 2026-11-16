import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isLucyError } from "@/core/errors";
import { run } from "@/core/process";
import { documentLines, loadDocument, type ViewerDocument } from "@/features/editor/model";
import { createSyntax, createTempDirs, generateLines, ms, writeFiles } from "./helpers";

const tempDir = createTempDirs("load");
const syntax = createSyntax(tempDir());
afterAll(() => syntax.dispose());

function expectKind<K extends ViewerDocument["kind"]>(
  doc: ViewerDocument,
  kind: K,
): Extract<ViewerDocument, { kind: K }> {
  expect(doc.kind).toBe(kind);
  return doc as Extract<ViewerDocument, { kind: K }>;
}

const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const PNG = Uint8Array.from([
  0x89,
  ...new TextEncoder().encode("PNG\r\n\x1a\n"),
  ...be32(13),
  ...new TextEncoder().encode("IHDR"),
  ...be32(640),
  ...be32(480),
  8,
  6,
  0,
  0,
  0,
  ...new Uint8Array(32),
]);

describe("loadDocument: text", () => {
  test("TypeScript file: language, highlighting and status-bar facts", async () => {
    const root = tempDir();
    writeFiles(root, { "src/app.ts": "export const a = 1;\nexport const b = 2;\n" });
    const doc = expectKind(await loadDocument(root, "src/app.ts", { syntax }), "text");
    expect(doc.name).toBe("app.ts");
    expect(doc.language).toEqual({ id: "typescript", displayName: "TypeScript" });
    expect(doc.highlight).toEqual({ enabled: true, filetype: "typescript" });
    expect(doc.lineCount).toBe(2);
    expect(doc.encodingLabel).toBe("UTF-8");
    expect(doc.lineEndingLabel).toBe("LF");
    expect(doc.finalNewline).toBe(true);
    expect(doc.sizeLabel).toBe("40 B");
    expect(doc.notices).toEqual([]);
    expect(doc.actions).toContain("edit-in-terminal-editor");
    expect(doc.isMarkdown).toBe(false);
  });

  test("CRLF line endings: label, line count, and lines without the CR", async () => {
    const root = tempDir();
    writeFiles(root, { "win.txt": "one\r\ntwo\r\nthree\r\n" });
    const doc = expectKind(await loadDocument(root, "win.txt", { syntax }), "text");
    expect(doc.lineEnding).toBe("crlf");
    expect(doc.lineEndingLabel).toBe("CRLF");
    expect(doc.lineCount).toBe(3);
    expect(documentLines(doc)).toEqual(["one", "two", "three"]);
  });

  test("mixed line endings", async () => {
    const root = tempDir();
    writeFiles(root, { "mixed.txt": "a\r\nb\nc" });
    const doc = expectKind(await loadDocument(root, "mixed.txt", { syntax }), "text");
    expect(doc.lineEndingLabel).toBe("Mixed");
    expect(documentLines(doc)).toEqual(["a", "b", "c"]);
  });

  test("UTF-8 BOM is reported and stripped from the content", async () => {
    const root = tempDir();
    writeFiles(root, {
      "bom.json": Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"a": 1}\n')]),
    });
    const doc = expectKind(await loadDocument(root, "bom.json", { syntax }), "text");
    expect(doc.bom).toBe(true);
    expect(doc.encodingLabel).toBe("UTF-8 with BOM");
    expect(doc.content).toBe('{"a": 1}\n');
    expect(doc.language.id).toBe("json");
  });

  test("UTF-16 LE with BOM", async () => {
    const root = tempDir();
    const body = Buffer.from("merhaba\n", "utf16le");
    writeFiles(root, { "u16.txt": Uint8Array.from([0xff, 0xfe, ...body]) });
    const doc = expectKind(await loadDocument(root, "u16.txt", { syntax }), "text");
    expect(doc.encodingLabel).toBe("UTF-16 LE");
    expect(doc.content).toBe("merhaba\n");
  });

  test("Turkish text keeps its characters and UTF-16 line lengths", async () => {
    const root = tempDir();
    const text = "İstanbul'da ışık\nÇağrı ÖĞRENCİ şüphe\n";
    writeFiles(root, { "tr.md": text });
    const doc = expectKind(await loadDocument(root, "tr.md", { syntax }), "text");
    expect(doc.content).toBe(text);
    expect(doc.lineCount).toBe(2);
    expect(documentLines(doc)[1]).toBe("Çağrı ÖĞRENCİ şüphe");
    expect(doc.isMarkdown).toBe(true);
    expect(doc.language.displayName).toBe("Markdown");
  });

  test("empty file shows one empty line", async () => {
    const root = tempDir();
    writeFiles(root, { "empty.ts": "" });
    const doc = expectKind(await loadDocument(root, "empty.ts", { syntax }), "text");
    expect(doc.lineCount).toBe(1);
    expect(doc.content).toBe("");
    expect(documentLines(doc)).toEqual([""]);
    expect(doc.sizeLabel).toBe("0 B");
  });

  test("file without a trailing newline", async () => {
    const root = tempDir();
    writeFiles(root, { "no-eol.py": "print('a')\nprint('b')" });
    const doc = expectKind(await loadDocument(root, "no-eol.py", { syntax }), "text");
    expect(doc.finalNewline).toBe(false);
    expect(doc.lineCount).toBe(2);
    expect(documentLines(doc)).toEqual(["print('a')", "print('b')"]);
    expect(doc.language.id).toBe("python");
  });

  test("shebang decides the language of an extensionless script", async () => {
    const root = tempDir();
    writeFiles(root, { "bin/tool": "#!/usr/bin/env python3\nprint(1)\n" });
    const doc = expectKind(await loadDocument(root, "bin/tool", { syntax }), "text");
    expect(doc.language.id).toBe("python");
  });

  test("plain text: no highlighting and no notice", async () => {
    const root = tempDir();
    writeFiles(root, { "notes.txt": "hello\n" });
    const doc = expectKind(await loadDocument(root, "notes.txt", { syntax }), "text");
    expect(doc.highlight).toEqual({ enabled: false, reason: "plain-text" });
    expect(doc.notices).toEqual([]);
  });

  test("MDX is not previewable", async () => {
    const root = tempDir();
    writeFiles(root, { "page.mdx": "# Hi\n" });
    const doc = expectKind(await loadDocument(root, "page.mdx", { syntax }), "text");
    expect(doc.isMarkdown).toBe(false);
  });

  test("50k-line file loads as text with highlighting off and a quiet notice", async () => {
    const root = tempDir();
    writeFiles(root, { "big.ts": generateLines(50_000) });
    const started = performance.now();
    const doc = expectKind(await loadDocument(root, "big.ts", { syntax }), "text");
    const loadTime = ms(started);
    const splitStart = performance.now();
    const lines = documentLines(doc);
    console.log(
      `[timing] load 50k-line file (${doc.sizeLabel}): ${loadTime}; split lines: ${ms(splitStart)}`,
    );
    expect(doc.lineCount).toBe(50_000);
    expect(lines.length).toBe(50_000);
    expect(doc.highlight).toEqual({ enabled: false, reason: "size-limit" });
    expect(doc.notices.map((n) => n.kind)).toEqual(["highlighting-off"]);
    expect(documentLines(doc)).toBe(lines); // memoized
  });
});

describe("loadDocument: binary and too large", () => {
  test("PNG image: type, size and dimensions for the information card", async () => {
    const root = tempDir();
    writeFiles(root, { "logo.png": PNG });
    const doc = expectKind(await loadDocument(root, "logo.png", { syntax }), "binary");
    expect(doc.mime).toBe("image/png");
    expect(doc.typeLabel).toBe("PNG image");
    expect(doc.image).toEqual({ format: "png", width: 640, height: 480 });
    expect(doc.dimensionsLabel).toBe("640 × 480");
    expect(doc.sizeLabel).toBe(`${PNG.length} B`);
    expect(doc.actions).toEqual(["open-externally", "reveal-in-explorer"]);
  });

  test("other binary file", async () => {
    const root = tempDir();
    const bytes = new Uint8Array(3000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256;
    writeFiles(root, { "blob.bin": bytes });
    const doc = expectKind(await loadDocument(root, "blob.bin", { syntax }), "binary");
    expect(doc.typeLabel).toBe("Binary file");
    expect(doc.image).toBeNull();
    expect(doc.dimensionsLabel).toBeNull();
    expect(doc.sizeLabel).toBe("2.9 KB");
  });

  test("text above editor.max_file_size_mb becomes a too-large card", async () => {
    const root = tempDir();
    writeFiles(root, { "huge.log": "x".repeat(1024 * 1024 + 10) });
    const doc = expectKind(await loadDocument(root, "huge.log", { syntax, maxFileSizeMb: 1 }), "too-large");
    expect(doc.limitLabel).toBe("1 MB");
    expect(doc.sizeLabel).toBe("1 MB");
    expect(doc.actions).toEqual(["edit-in-terminal-editor", "open-externally", "reveal-in-explorer"]);
  });
});

describe("loadDocument: failure states", () => {
  test("missing file: not found, or deleted when the tab had shown it", async () => {
    const root = tempDir();
    const missing = expectKind(await loadDocument(root, "gone.ts", { syntax }), "unavailable");
    expect(missing.reason).toBe("not-found");
    expect(missing.title).toBe("File not found");
    expect(missing.actions).toContain("retry");
    const deleted = expectKind(
      await loadDocument(root, "gone.ts", { syntax, wasLoaded: true }),
      "unavailable",
    );
    expect(deleted.reason).toBe("deleted");
    expect(deleted.title).toBe("File was deleted");
    expect(deleted.message).toContain('"gone.ts" was deleted');
  });

  test("folder and FIFO are not regular files", async () => {
    const root = tempDir();
    mkdirSync(join(root, "dir"));
    const folder = expectKind(await loadDocument(root, "dir", { syntax }), "unavailable");
    expect(folder.reason).toBe("not-a-regular-file");
    expect(folder.message).toContain("is a folder");

    const fifo = await run(["mkfifo", join(root, "pipe")]);
    expect(fifo.code).toBe(0);
    const pipe = expectKind(await loadDocument(root, "pipe", { syntax }), "unavailable");
    expect(pipe.reason).toBe("not-a-regular-file");
    expect(pipe.message).toContain("named pipe");
  });

  test.skipIf(process.getuid?.() === 0)("permission denied", async () => {
    const root = tempDir();
    writeFiles(root, { "secret.txt": "x\n" });
    chmodSync(join(root, "secret.txt"), 0o000);
    const doc = expectKind(await loadDocument(root, "secret.txt", { syntax }), "unavailable");
    expect(doc.reason).toBe("permission-denied");
    expect(doc.title).toBe("Permission denied");
  });

  test("path escaping the workspace is an invalid path, not a read", async () => {
    const root = tempDir();
    const doc = expectKind(await loadDocument(root, "../etc/passwd", { syntax }), "unavailable");
    expect(doc.reason).toBe("invalid-path");
  });

  test("symlink to a file outside the workspace: shown with a notice, no edit action", async () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "shared.ts"), "export {};\n");
    symlinkSync(join(outside, "shared.ts"), join(root, "link.ts"));
    const doc = expectKind(await loadDocument(root, "link.ts", { syntax }), "text");
    expect(doc.outsideWorkspace).toBe(true);
    expect(doc.isSymlink).toBe(true);
    expect(doc.notices.map((n) => n.kind)).toEqual(["outside-workspace"]);
    expect(doc.actions).not.toContain("edit-in-terminal-editor");
  });

  test("file name with control characters is display-safe in the card", async () => {
    const root = tempDir();
    const doc = expectKind(await loadDocument(root, "bad‮name.txt", { syntax }), "unavailable");
    expect(doc.name).toBe("bad�name.txt");
    expect(doc.message).not.toContain("‮");
  });

  test("an aborted load throws CANCELLED instead of returning a state", async () => {
    const root = tempDir();
    writeFiles(root, { "a.ts": "x\n" });
    const controller = new AbortController();
    controller.abort();
    const error = await loadDocument(root, "a.ts", { syntax, signal: controller.signal }).catch(
      (e: unknown) => e,
    );
    expect(isLucyError(error, "CANCELLED")).toBe(true);
  });
});
