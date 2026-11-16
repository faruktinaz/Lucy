import { describe, expect, test } from "bun:test";
import { displayWidth } from "@/core/text";
import { layoutPreview, PREVIEW_ELLIPSIS, type PreviewLayout } from "@/features/search/preview-layout";

function render(layout: PreviewLayout): string {
  const body = layout.runs.map((run) => (run.match ? `[${run.text}]` : run.text)).join("");
  return `${layout.leading ? PREVIEW_ELLIPSIS : ""}${body}${layout.trailing ? PREVIEW_ELLIPSIS : ""}`;
}

function width(layout: PreviewLayout): number {
  const text = layout.runs.map((run) => run.text).join("");
  return displayWidth(text) + (layout.leading ? 1 : 0) + (layout.trailing ? 1 : 0);
}

describe("layoutPreview", () => {
  test("a short line is shown whole with its matches marked", () => {
    const layout = layoutPreview(
      "const needle = needle;",
      [
        { start: 6, end: 12 },
        { start: 15, end: 21 },
      ],
      40,
    );
    expect(render(layout)).toBe("const [needle] = [needle];");
  });

  test("a long line is cut at the end with an ellipsis", () => {
    const layout = layoutPreview("needle and then a lot of other text", [{ start: 0, end: 6 }], 16);
    expect(render(layout)).toBe("[needle] and then…");
    expect(width(layout)).toBe(16);
  });

  test("a match beyond the visible width slides into view with context before it", () => {
    const text = `${"x".repeat(80)} target here`;
    const start = text.indexOf("target");
    const layout = layoutPreview(text, [{ start, end: start + 6 }], 24);
    const shown = render(layout);
    expect(shown.startsWith(PREVIEW_ELLIPSIS)).toBe(true);
    expect(shown).toContain("[target]");
    expect(width(layout)).toBeLessThanOrEqual(24);
  });

  test("an excerpt the engine already clipped keeps both ellipses", () => {
    const layout = layoutPreview("needle", [{ start: 0, end: 6 }], 30, true, true);
    expect(render(layout)).toBe("…[needle]…");
  });

  test("wide characters are measured in cells, never splitting a grapheme", () => {
    const text = "漢字漢字漢字 needle 👩‍💻👩‍💻";
    const start = text.indexOf("needle");
    for (let cells = 6; cells <= 30; cells++) {
      const layout = layoutPreview(text, [{ start, end: start + 6 }], cells);
      expect(width(layout)).toBeLessThanOrEqual(cells);
      // The ZWJ sequence is never cut in half.
      const joined = layout.runs.map((run) => run.text).join("");
      expect(joined.includes("‍") ? joined.includes("👩‍💻") : true).toBe(true);
    }
  });

  test("Turkish text keeps its letters and highlights", () => {
    const text = "İçerik çalışma notları: çalışma";
    const start = text.lastIndexOf("çalışma");
    const layout = layoutPreview(text, [{ start, end: start + 7 }], 20);
    expect(render(layout)).toContain("[çalışma]");
    expect(width(layout)).toBeLessThanOrEqual(20);
  });

  test("no width, no text", () => {
    expect(layoutPreview("needle", [{ start: 0, end: 6 }], 0).runs).toEqual([]);
  });
});
