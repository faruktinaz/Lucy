/**
 * CapturedFrame -> standalone HTML page.
 *
 * Backgrounds, vector glyphs, decorations and the window chrome come from the same SVG geometry
 * as `frameToSvg`; the text is real DOM (selectable), one absolutely positioned element per
 * glyph, centered in its cells, so the grid stays exact whatever the font's advance.
 */
import { type Glyph, layoutFrame } from "./layout";
import { layoutToSvg } from "./svg";
import type { Frame, ScreenshotOptions } from "./types";
import { escapeXml, num } from "./xml";

/** `<meta name=…>` that records the page size, so `renderPng` can size the browser viewport. */
export const SIZE_META_NAME = "lucy-screenshot-size";

export function frameToHtml(frame: Frame, options: ScreenshotOptions = {}): string {
  const layout = layoutFrame(frame, options);
  const m = layout.metrics;

  // Colors and font styles become short classes; positions stay inline.
  const classes = new Map<string, string>();
  const classFor = (glyph: Glyph): string => {
    const key = `${glyph.color}|${glyph.bold ? 1 : 0}|${glyph.italic ? 1 : 0}`;
    let name = classes.get(key);
    if (!name) {
      name = `s${classes.size}`;
      classes.set(key, name);
    }
    return name;
  };
  const rows = new Map<number, string[]>();
  for (const glyph of layout.glyphs) {
    const wide = glyph.cells === 2 ? " w" : "";
    const element = `<span class="${classFor(glyph)}${wide}" style="left:${num(glyph.x - m.gridX)}px">${escapeXml(glyph.text)}</span>`;
    const row = rows.get(glyph.row);
    if (row) row.push(element);
    else rows.set(glyph.row, [element]);
  }
  const rowHtml = [...rows.entries()]
    .map(([row, spans]) => `<div class="r" style="top:${row * m.cellH}px">${spans.join("")}</div>`)
    .join("\n");
  const classCss = [...classes.entries()]
    .map(([key, name]) => {
      const [color, bold, italic] = key.split("|");
      return `.${name}{color:${color}${bold === "1" ? ";font-weight:bold" : ""}${italic === "1" ? ";font-style:italic" : ""}}`;
    })
    .join("\n");

  // A CSS line box of height cellH centers the font's content area, which puts the baseline
  // where the SVG emitter puts it.
  const css = `
html,body{margin:0;padding:0;background:transparent}
.screen{position:relative;width:${m.width}px;height:${m.height}px}
.screen>svg{position:absolute;left:0;top:0;display:block}
.text{position:absolute;left:${m.gridX}px;top:${m.gridY}px;width:${m.cellW * frame.cols}px;height:${m.cellH * frame.rows}px;
  font-family:${m.fontFamily};font-size:${m.fontSize}px;line-height:${m.cellH}px;white-space:pre;
  font-kerning:none;font-variant-ligatures:none}
.r{position:absolute;left:0;height:${m.cellH}px}
.r>span{position:absolute;top:0;width:${m.cellW}px;text-align:center;display:block}
.r>span.w{width:${m.cellW * 2}px}
${classCss}`;

  const title = layout.title || "Terminal screenshot";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="${SIZE_META_NAME}" content="${m.width}x${m.height}">
<title>${escapeXml(title)}</title>
<style>${css}
</style>
</head>
<body>
<div class="screen">
${layoutToSvg(layout, { includeText: false })}
<div class="text">
${rowHtml}
</div>
</div>
</body>
</html>
`;
}
