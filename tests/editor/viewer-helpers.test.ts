import { describe, expect, test } from "bun:test";
import {
  breadcrumbSegments,
  canPreviewMarkdown,
  createViewerState,
  createViewerStore,
  describeMime,
  encodingLabel,
  exportViewerState,
  formatFileSize,
  goToLinePlaceholder,
  isMarkdownLanguage,
  lineEndingLabel,
  parseGoToLine,
  restoreViewerState,
  showsMarkdownPreview,
  splitLines,
  toggleMarkdownPreview,
  unavailableDocument,
} from "@/features/editor/model";

describe("parseGoToLine", () => {
  test("accepted forms, 1-based in, 0-based out", () => {
    expect(parseGoToLine("42", 100)).toEqual({ ok: true, line: 41, column: 0, clamped: false });
    expect(parseGoToLine("42:7", 100)).toEqual({ ok: true, line: 41, column: 6, clamped: false });
    expect(parseGoToLine(":42", 100)).toEqual({ ok: true, line: 41, column: 0, clamped: false });
    expect(parseGoToLine(" :42:7 ", 100)).toEqual({ ok: true, line: 41, column: 6, clamped: false });
    expect(parseGoToLine("42,7", 100)).toEqual({ ok: true, line: 41, column: 6, clamped: false });
  });

  test("clamping", () => {
    expect(parseGoToLine("500", 100)).toEqual({ ok: true, line: 99, column: 0, clamped: true });
    expect(parseGoToLine("0", 100)).toEqual({ ok: true, line: 0, column: 0, clamped: true });
    expect(parseGoToLine("99999999999999999999", 100)).toMatchObject({ ok: true, line: 99, clamped: true });
    expect(parseGoToLine("1", 0)).toEqual({ ok: true, line: 0, column: 0, clamped: false });
  });

  test("column is in characters and clamped to the line text", () => {
    const lines = ["ab", "😀x şy"];
    const lineText = (line: number) => lines[line] ?? "";
    // Column 2 on line 2 is after the emoji (2 UTF-16 units).
    expect(parseGoToLine("2:2", 2, { lineText })).toEqual({ ok: true, line: 1, column: 2, clamped: false });
    expect(parseGoToLine("2:5", 2, { lineText })).toEqual({ ok: true, line: 1, column: 5, clamped: false });
    expect(parseGoToLine("1:3", 2, { lineText })).toEqual({ ok: true, line: 0, column: 2, clamped: false });
    expect(parseGoToLine("1:30", 2, { lineText })).toEqual({ ok: true, line: 0, column: 2, clamped: true });
  });

  test("clear messages for empty and invalid input", () => {
    expect(parseGoToLine("", 120)).toEqual({
      ok: false,
      reason: "empty",
      message: "Type a line number between 1 and 120.",
    });
    const invalid = parseGoToLine("abc", 120);
    expect(invalid).toEqual({
      ok: false,
      reason: "invalid",
      message: '"abc" is not a line number. Type a number between 1 and 120, such as 42 or 42:7.',
    });
    for (const bad of ["-3", "4:", "1.5", "12abc", "4:x", "‮9"]) {
      expect(parseGoToLine(bad, 10).ok).toBe(false);
    }
    const unsafe = parseGoToLine("‮evil", 10);
    expect(!unsafe.ok && unsafe.message.includes("‮")).toBe(false);
    expect(goToLinePlaceholder(120)).toBe("Go to line 1–120, or line:column");
  });
});

describe("breadcrumbs", () => {
  test("segments with cumulative paths", () => {
    expect(breadcrumbSegments("src/features/editor/index.ts")).toEqual([
      { label: "src", path: "src", isLast: false },
      { label: "features", path: "src/features", isLast: false },
      { label: "editor", path: "src/features/editor", isLast: false },
      { label: "index.ts", path: "src/features/editor/index.ts", isLast: true },
    ]);
    expect(breadcrumbSegments("README.md")).toEqual([
      { label: "README.md", path: "README.md", isLast: true },
    ]);
    expect(breadcrumbSegments("./a//b/")).toEqual([
      { label: "a", path: "a", isLast: false },
      { label: "b", path: "a/b", isLast: true },
    ]);
    expect(breadcrumbSegments("")).toEqual([]);
  });

  test("labels are display-safe, paths stay raw", () => {
    const [segment] = breadcrumbSegments("evil‮txt.exe\u0007");
    expect(segment?.label).toBe("evil�txt.exe�");
    expect(segment?.path).toBe("evil‮txt.exe\u0007");
  });
});

describe("Markdown flag", () => {
  const md = {
    ...unavailableDocument("a.md", "io-error"),
  };
  test("only text documents detected as Markdown can preview", () => {
    expect(isMarkdownLanguage("markdown")).toBe(true);
    expect(isMarkdownLanguage("mdx")).toBe(false);
    expect(canPreviewMarkdown(md)).toBe(false);
    expect(canPreviewMarkdown(null)).toBe(false);
    const state = createViewerState();
    expect(toggleMarkdownPreview(state, md)).toBe(state);
    expect(showsMarkdownPreview({ ...state, markdownPreview: true }, md)).toBe(false);
  });
});

describe("viewer state export / restore", () => {
  test("round trip", () => {
    const state = { activeLine: 12, scrollTop: 4, scrollLeft: 3, wrap: true, markdownPreview: true };
    const snapshot = exportViewerState(state);
    expect(snapshot).toEqual({ v: 1, ...state });
    expect(restoreViewerState(JSON.parse(JSON.stringify(snapshot)))).toEqual(state);
  });

  test("invalid fields fall back one by one; unknown versions fall back entirely", () => {
    expect(
      restoreViewerState({
        v: 1,
        activeLine: -3,
        scrollTop: "x",
        scrollLeft: 2.5,
        wrap: "yes",
        markdownPreview: true,
      }),
    ).toEqual({ activeLine: 0, scrollTop: 0, scrollLeft: 0, wrap: false, markdownPreview: true });
    expect(restoreViewerState({ v: 2, activeLine: 9 }, { wrap: true })).toEqual(
      createViewerState({ wrap: true }),
    );
    expect(restoreViewerState(null)).toEqual(createViewerState());
    expect(restoreViewerState([1, 2])).toEqual(createViewerState());
  });

  test("store holds the state", () => {
    const store = createViewerStore();
    let calls = 0;
    store.subscribe(() => calls++);
    store.update({ activeLine: 3 });
    store.update({ activeLine: 3 });
    expect(store.get().activeLine).toBe(3);
    expect(calls).toBe(1);
  });
});

describe("labels", () => {
  test("file sizes", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(1023)).toBe("1023 B");
    expect(formatFileSize(1024)).toBe("1 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(12_345)).toBe("12 KB");
    expect(formatFileSize(1024 * 1024 - 1)).toBe("1 MB");
    expect(formatFileSize(3.45 * 1024 * 1024)).toBe("3.5 MB");
    expect(formatFileSize(5 * 1024 ** 3)).toBe("5 GB");
    expect(formatFileSize(-1)).toBe("unknown size");
  });

  test("encodings, line endings, MIME types", () => {
    expect(encodingLabel("utf-8", false)).toBe("UTF-8");
    expect(encodingLabel("utf-8", true)).toBe("UTF-8 with BOM");
    expect(encodingLabel("utf-16be", true)).toBe("UTF-16 BE");
    expect(lineEndingLabel("lf")).toBe("LF");
    expect(lineEndingLabel("crlf")).toBe("CRLF");
    expect(lineEndingLabel("mixed")).toBe("Mixed");
    expect(describeMime("image/png")).toBe("PNG image");
    expect(describeMime("image/svg+xml")).toBe("SVG image");
    expect(describeMime("application/pdf")).toBe("PDF document");
    expect(describeMime("font/woff2")).toBe("WOFF2 font");
    expect(describeMime("application/x-mach-binary")).toBe("Mach-O executable");
    expect(describeMime("application/x-whatever")).toBe("Binary file");
  });

  test("splitLines", () => {
    expect(splitLines("")).toEqual([""]);
    expect(splitLines("\n")).toEqual([""]);
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
    expect(splitLines("a\rb\n")).toEqual(["a\rb"]);
  });
});
