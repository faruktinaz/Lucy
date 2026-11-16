import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Attr,
  type Frame,
  type FrameColor,
  type FrameSpan,
  findBrowser,
  findTextInFrame,
  frameToAnsi,
  frameToHtml,
  frameToSvg,
  frameToText,
  renderPng,
  saveScreenshot,
  vectorGlyphShapes,
} from "../../scripts/screenshot";
import { cropImage, decodePng, encodePng } from "../../scripts/screenshot/png-codec";
import { mountTui } from "../helpers/tui";
import { TestScene } from "./test-scene";

const rgb = (hex: string, a = 1): FrameColor => ({
  r: Number.parseInt(hex.slice(1, 3), 16) / 255,
  g: Number.parseInt(hex.slice(3, 5), 16) / 255,
  b: Number.parseInt(hex.slice(5, 7), 16) / 255,
  a,
});
const REPLACEMENT = String.fromCodePoint(0xfffd);
const TRANSPARENT: FrameColor = { r: 0, g: 0, b: 0, a: 0 };
const WHITE = rgb("#ffffff");
const indexed = (slot: number, snapshot: string): FrameColor => ({
  ...rgb(snapshot),
  intent: "indexed",
  slot,
});
const DEFAULT_FG: FrameColor = { ...rgb("#ffffff"), intent: "default" };
const DEFAULT_BG: FrameColor = { ...rgb("#000000"), intent: "default" };

function span(text: string, width: number, over: Partial<FrameSpan> = {}): FrameSpan {
  return { text, width, fg: WHITE, bg: TRANSPARENT, attributes: 0, ...over };
}

/** One frame per row list; every row is padded to `cols` with a transparent span. */
function frame(cols: number, rows: FrameSpan[][]): Frame {
  return {
    cols,
    rows: rows.length,
    cursor: [0, 0],
    lines: rows.map((spans) => {
      const used = spans.reduce((n, s) => n + s.width, 0);
      return { spans: used < cols ? [...spans, span(" ".repeat(cols - used), cols - used)] : spans };
    }),
  };
}

/** Default metrics: font size 15 gives 9x18 cells. */
const CELL_W = 9;

describe("frameToSvg", () => {
  test("is a sized SVG document on the cell grid", () => {
    const svg = frameToSvg(frame(10, [[span("hi", 2)], []]));
    expect(
      svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="90" height="36" viewBox="0 0 90 36">'),
    ).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(svg).toContain('<rect width="90" height="36" fill="#15161a"/>');
    expect(svg).toContain(
      "font-family:&quot;JetBrainsMono Nerd Font&quot;, &quot;JetBrains Mono&quot;, Menlo, monospace",
    );
  });

  test("positions every glyph at the center of its cell, not by text flow", () => {
    const svg = frameToSvg(frame(10, [[span("ab  c", 5)]]));
    expect(svg).toContain('<text x="4.5 13.5" y="');
    expect(svg).toContain(">ab</text>");
    // The run restarts after the spaces, at column 4.
    expect(svg).toContain(`<text x="${4 * CELL_W + 4.5}" y="`);
  });

  test("wide glyphs occupy two cells and push later glyphs by two columns", () => {
    const svg = frameToSvg(frame(6, [[span("漢x👍y", 6)]]));
    expect(svg).toContain(`<text x="${CELL_W}" y="`); // 漢: center of columns 0-1
    expect(svg).toContain(">漢</text>");
    expect(svg).toContain(`<text x="${2 * CELL_W + 4.5}" y="`); // x at column 2
    expect(svg).toContain(`<text x="${4 * CELL_W}" y="`); // 👍: center of columns 3-4
    expect(svg).toContain(`<text x="${5 * CELL_W + 4.5}" y="`); // y at column 5
  });

  test("escapes <, & and > (and quotes) and drops characters XML forbids", () => {
    const svg = frameToSvg(frame(12, [[span(`<a & "b">`, 9), span("\u0001", 1)]]), { title: `T<&>"` });
    expect(svg).toContain("&lt;a");
    expect(svg).toContain("&amp;");
    expect(svg).toContain("&quot;b&quot;&gt;");
    expect(svg).toContain("<title>T&lt;&amp;&gt;&quot;</title>");
    expect(svg).not.toContain("\u0001");
    expect(svg).toContain(REPLACEMENT);
    expect(svg).not.toContain("<a ");
  });

  test("bold, italic, underline, strikethrough, dim, inverse and hidden", () => {
    const red = rgb("#ff0000");
    const blue = rgb("#0000ff");
    const svg = frameToSvg(
      frame(20, [
        [
          span("B", 1, { attributes: Attr.BOLD }),
          span("I", 1, { attributes: Attr.ITALIC }),
          span("U", 1, { attributes: Attr.UNDERLINE, fg: red }),
          span("S", 1, { attributes: Attr.STRIKETHROUGH, fg: blue }),
          span("D", 1, { attributes: Attr.DIM, fg: WHITE, bg: rgb("#000000") }),
          span("V", 1, { attributes: Attr.INVERSE, fg: red, bg: blue }),
          span("H", 1, { attributes: Attr.HIDDEN }),
        ],
      ]),
    );
    expect(svg).toMatch(/<text [^>]*font-weight="bold"[^>]*>B</);
    expect(svg).toMatch(/<text [^>]*font-style="italic"[^>]*>I</);
    // Underline and strikethrough are drawn as rectangles across the span's cells.
    expect(svg).toMatch(
      new RegExp(`<rect x="${2 * CELL_W}" y="\\d+" width="${CELL_W}" height="1" fill="#ff0000"/>`),
    );
    expect(svg).toMatch(
      new RegExp(`<rect x="${3 * CELL_W}" y="\\d+" width="${CELL_W}" height="1" fill="#0000ff"/>`),
    );
    // Dim moves white 45% toward black.
    expect(svg).toMatch(/fill="#8c8c8c"[^>]*>D</);
    // Inverse swaps the colors, as the terminal does with SGR 7.
    expect(svg).toContain(`<rect x="${5 * CELL_W}" y="0" width="${CELL_W}" height="18" fill="#ff0000"/>`);
    expect(svg).toMatch(/fill="#0000ff"[^>]*>V</);
    expect(svg).not.toContain(">H<");
  });

  test("transparent backgrounds use the default background; translucent ones are composited", () => {
    const svg = frameToSvg(frame(4, [[span("a", 1), span("b", 1, { bg: rgb("#ffffff", 0.5) })]]), {
      background: "#000000",
    });
    // Only the translucent cell gets its own rectangle: white at 50% over black.
    const cellRects = svg.match(/<rect x="[\d.]+" y="0" width="9" height="18" fill="#[0-9a-f]{6}"\/>/g) ?? [];
    expect(cellRects).toEqual([`<rect x="${CELL_W}" y="0" width="9" height="18" fill="#808080"/>`]);
  });

  test("indexed colors use the palette for 0..15 and their snapshot otherwise; default colors use the options", () => {
    const palette = Array.from({ length: 16 }, (_, i) => `#0000${i.toString(16).padStart(2, "0")}`);
    palette[1] = "#abcdef";
    const svg = frameToSvg(
      frame(6, [
        [
          span("p", 1, { fg: indexed(1, "#800000") }),
          span("s", 1, { fg: indexed(208, "#ff8700") }),
          span("d", 1, { fg: DEFAULT_FG, bg: DEFAULT_BG }),
        ],
      ]),
      { palette, foreground: "#112233", background: "#445566" },
    );
    expect(svg).toMatch(/fill="#abcdef"[^>]*>p</);
    expect(svg).toMatch(/fill="#ff8700"[^>]*>s</);
    expect(svg).toMatch(/fill="#112233"[^>]*>d</);
    expect(svg).toContain('<rect width="54" height="18" fill="#445566"/>');

    const withoutPalette = frameToSvg(frame(2, [[span("p", 1, { fg: indexed(1, "#800000") })]]));
    expect(withoutPalette).toMatch(/fill="#800000"[^>]*>p</);
    expect(() => frameToSvg(frame(1, [[]]), { palette: ["#000000"] })).toThrow("16 colors");
  });

  test("box-drawing characters become vector shapes (or font text when disabled)", () => {
    const borders = frame(3, [[span("┌─┐", 3)], [span("└─┘", 3)]]);
    const svg = frameToSvg(borders);
    expect(svg).not.toContain("─</text>");
    expect(svg.match(/<g transform="translate/g)?.length).toBe(6);
    expect(frameToSvg(borders, { vectorGlyphs: false })).toContain(">┌─┐</text>");
  });

  test("the window frame adds a title bar, rounded clip and shadow", () => {
    const plain = frameToSvg(frame(10, [[span("x", 1)]]));
    const framed = frameToSvg(frame(10, [[span("x", 1)]]), { window: { title: "lucy <demo>" } });
    expect(framed).toContain('<clipPath id="lucy-window">');
    expect(framed).toContain("feDropShadow");
    expect(framed).toContain(">lucy &lt;demo&gt;</text>");
    expect(plain).not.toContain("clipPath");
    const width = (svg: string) => Number(/width="(\d+)"/.exec(svg)?.[1]);
    expect(width(framed)).toBeGreaterThan(width(plain));
    expect(frameToSvg(frame(10, [[span("x", 1)]]), { window: { shadow: false } })).not.toContain(
      "feDropShadow",
    );
  });
});

describe("vector glyph geometry", () => {
  const box = { w: 9, h: 18, light: 1 };
  const rects = (glyph: string) =>
    (vectorGlyphShapes(glyph, box) ?? []).flatMap((s) => (s.kind === "rect" ? [s] : []));

  /** [min, max] covered along one axis by the union of the glyph's rectangles (they must overlap or touch). */
  const extent = (glyph: string, axis: "x" | "y") => {
    const spans = rects(glyph)
      .map((r) => (axis === "x" ? [r.x, r.x + r.w] : [r.y, r.y + r.h]) as [number, number])
      .sort((a, b) => a[0] - b[0]);
    let [min, max] = spans[0]!;
    for (const [start, end] of spans.slice(1)) {
      expect(start).toBeLessThanOrEqual(max); // no gap between the arms
      max = Math.max(max, end);
    }
    return [min, max];
  };

  test("straight lines span the full cell so neighbors join without gaps", () => {
    expect(extent("─", "x")).toEqual([0, 9]);
    expect(rects("─").every((r) => r.h === 1)).toBe(true);
    expect(extent("│", "y")).toEqual([0, 18]);
    // A heavy line is twice as thick.
    expect(extent("━", "x")).toEqual([0, 9]);
    expect(rects("━").every((r) => r.h === 2)).toBe(true);
    expect(extent("═", "x")).toEqual([0, 9]);
    expect(extent("║", "y")).toEqual([0, 18]);
  });

  test("corners and junctions line up with the straight pieces", () => {
    const [h] = rects("─");
    const [v] = rects("│");
    for (const glyph of ["┌", "┐", "└", "┘", "├", "┤", "┬", "┴", "┼"]) {
      for (const r of rects(glyph)) {
        if (r.h === 1) expect(r.y).toBe(h!.y);
        if (r.w === 1) expect(r.x).toBe(v!.x);
      }
    }
    // Double lines: the outer and inner strokes of ╔ reach the right and bottom edges.
    const double = rects("╔");
    expect(double.filter((r) => r.x + r.w === 9)).toHaveLength(2);
    expect(double.filter((r) => r.y + r.h === 18)).toHaveLength(2);
  });

  test("blocks, shades, arcs and powerline separators", () => {
    expect(rects("█")[0]).toMatchObject({ x: 0, y: 0, w: 9, h: 18 });
    expect(rects("▀")[0]).toMatchObject({ y: 0, h: 9 });
    expect(rects("▒")[0]).toMatchObject({ opacity: 0.5 });
    expect(vectorGlyphShapes("╭", box)?.[0]?.kind).toBe("stroke");
    expect(vectorGlyphShapes(String.fromCodePoint(0xe0b0), box)?.[0]).toEqual({
      kind: "fill",
      d: "M0 0L9 9L0 18Z",
    });
    expect(vectorGlyphShapes("a", box)).toBeNull();
  });
});

describe("frameToHtml", () => {
  test("is a standalone page with the same geometry and DOM text", () => {
    const html = frameToHtml(
      frame(6, [[span("<&>", 3), span("漢", 2), span("x", 1, { attributes: Attr.BOLD })]]),
    );
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta name="lucy-screenshot-size" content="54x18">');
    expect(html).toContain('style="left:0px">&lt;</span>');
    expect(html).toContain('style="left:9px">&amp;</span>');
    expect(html).toContain('style="left:18px">&gt;</span>');
    expect(html).toMatch(/class="s\d+ w" style="left:27px">漢<\/span>/);
    expect(html).toMatch(/style="left:45px">x<\/span>/);
    expect(html).toMatch(/\.s\d+\{color:#ffffff;font-weight:bold\}/);
    // Text lives in the DOM only; the SVG layer carries no glyph text.
    expect(html).not.toContain("</text>");
  });
});

describe("frameToAnsi and frameToText", () => {
  test("truecolor, indexed, default and attributes", () => {
    const ansi = frameToAnsi(
      frame(4, [
        [
          span("a", 1, { fg: rgb("#ff8000"), bg: rgb("#000010"), attributes: Attr.BOLD | Attr.UNDERLINE }),
          span("b", 1, { fg: indexed(3, "#808000") }),
          span("c", 1, { fg: DEFAULT_FG, bg: DEFAULT_BG }),
          span("\x1b", 1),
        ],
      ]),
    );
    expect(ansi).toContain("\x1b[0;1;4;38;2;255;128;0;48;2;0;0;16ma");
    expect(ansi).toContain("\x1b[0;38;5;3;49mb");
    expect(ansi).toContain("\x1b[0;39;49mc");
    expect(ansi).toContain(REPLACEMENT); // control characters never reach the viewer's terminal
    expect(ansi.endsWith("\x1b[0m\n")).toBe(true);
  });

  test("text and text search account for wide glyphs", () => {
    const f = frame(8, [[span("ab", 2)], [span("漢字 go", 7)]]);
    expect(frameToText(f)).toBe("ab      \n漢字 go ");
    expect(findTextInFrame(f, "go")).toEqual({ x: 5, y: 1 });
    expect(findTextInFrame(f, "zz")).toBeNull();
  });
});

describe("real frames", () => {
  test("a live CapturedFrame converts directly", async () => {
    const tui = await mountTui(<TestScene />);
    const captured = tui.spans();
    const svg = frameToSvg(captured);
    expect(svg).toContain(">Explorer</text>");
    expect(svg).toContain(">漢</text>");
    expect(frameToHtml(captured)).toContain(">İ</span>");
    expect(frameToText(captured).split("\n")).toHaveLength(35);
  });
});

describe("PNG", () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "lucy-shot-test-"));
    dirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  test("codec round trip and crop (no browser needed)", () => {
    const data = new Uint8Array(4 * 3 * 4);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37) % 256;
    const image = { width: 4, height: 3, data };
    expect(decodePng(encodePng(image))).toEqual(image);
    const cropped = cropImage(image, 2, 2);
    expect(cropped.width).toBe(2);
    expect([...cropped.data.subarray(8, 12)]).toEqual([...data.subarray(16, 20)]);
  });

  test("renderPng reports a typed skip when no browser is available", async () => {
    const dir = tempDir();
    const result = await renderPng(join(dir, "missing.svg"), join(dir, "out.png"), { browser: null });
    expect(result.status).toBe("skipped");
  });

  test.skipIf(findBrowser() === null)(
    "saveScreenshot writes every format and a PNG with the frame's colors",
    async () => {
      const dir = tempDir();
      const f = frame(10, [[span("   ", 3, { bg: rgb("#ff0000") }), span("ok", 2)], []]);
      const saved = await saveScreenshot(f, join(dir, "nested", "shot"), {
        background: "#0000ff",
        ansi: true,
      });
      expect(readFileSync(saved.txt, "utf8")).toBe(`${frameToText(f)}\n`);
      expect(readFileSync(saved.svg, "utf8")).toContain("<svg");
      expect(readFileSync(saved.html, "utf8")).toContain("<!doctype html>");
      expect(saved.ansi).toBe(join(dir, "nested", "shot.ansi"));
      expect(saved.png.status).toBe("written");
      if (saved.png.status !== "written") return;
      expect([saved.png.width, saved.png.height]).toEqual([180, 72]); // 90x36 CSS px at scale 2
      const image = decodePng(readFileSync(saved.png.path));
      const pixel = (x: number, y: number) => [
        ...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4),
      ];
      expect(pixel(10, 10)).toEqual([255, 0, 0, 255]); // red cell background
      expect(pixel(170, 60)).toEqual([0, 0, 255, 255]); // default background
    },
    60_000,
  );
});
