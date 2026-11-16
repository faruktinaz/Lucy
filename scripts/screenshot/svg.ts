/** CapturedFrame -> SVG on an exact cell grid. */
import type { Shape } from "./box-drawing";
import { type Glyph, type Layout, layoutFrame, WINDOW_FONT_FAMILY } from "./layout";
import type { Frame, ScreenshotOptions } from "./types";
import { escapeXml, num } from "./xml";

function shapeToSvg(shape: Shape): string {
  switch (shape.kind) {
    case "rect": {
      const opacity = shape.opacity === undefined ? "" : ` fill-opacity="${num(shape.opacity)}"`;
      return `<rect x="${num(shape.x)}" y="${num(shape.y)}" width="${num(shape.w)}" height="${num(shape.h)}"${opacity}/>`;
    }
    case "fill":
      return `<path d="${shape.d}"/>`;
    case "stroke":
      return `<path d="${shape.d}" fill="none" stroke="currentColor" stroke-width="${num(shape.width)}"/>`;
  }
}

function styleAttrs(glyph: Glyph): string {
  return `fill="${glyph.color}"${glyph.bold ? ' font-weight="bold"' : ""}${glyph.italic ? ' font-style="italic"' : ""}`;
}

/**
 * Glyphs become <text> elements. Every glyph gets its own x (the center of its cells, with
 * text-anchor middle), so each one starts a new text chunk and the font's advance can never
 * shift a later glyph off the grid, even when a glyph comes from a fallback font. Adjacent
 * simple glyphs of one style share an element with an x list to keep the file small.
 */
function textToSvg(glyphs: readonly Glyph[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < glyphs.length) {
    const first = glyphs[i]!;
    if (!first.simple) {
      out.push(
        `<text x="${num(first.cx)}" y="${num(first.y)}" ${styleAttrs(first)}>${escapeXml(first.text)}</text>`,
      );
      i++;
      continue;
    }
    const run: Glyph[] = [first];
    let j = i + 1;
    while (j < glyphs.length) {
      const next = glyphs[j]!;
      const last = run[run.length - 1]!;
      if (
        !next.simple ||
        next.row !== first.row ||
        next.color !== first.color ||
        next.bold !== first.bold ||
        next.italic !== first.italic ||
        next.col !== last.col + 1
      ) {
        break;
      }
      run.push(next);
      j++;
    }
    const xs = run.map((g) => num(g.cx)).join(" ");
    const text = escapeXml(run.map((g) => g.text).join(""));
    out.push(`<text x="${xs}" y="${num(first.y)}" ${styleAttrs(first)}>${text}</text>`);
    i = j;
  }
  return out.join("\n");
}

export interface SvgParts {
  /** <defs> and <style> content. */
  head: string;
  /** Window chrome and backgrounds (drawn under the grid). */
  under: string;
  /** Cell backgrounds, vector glyphs and decorations. */
  grid: string;
  /** Glyph text. */
  text: string;
  /** Drawn last (window border). */
  over: string;
}

/** The SVG pieces, split so the HTML emitter can replace the text layer with DOM text. */
export function svgParts(layout: Layout): SvgParts {
  const { metrics: m, window: win } = layout;
  const head: string[] = [
    `<style>text{font-family:${escapeXml(m.fontFamily)};font-size:${num(m.fontSize)}px;text-anchor:middle;` +
      "white-space:pre;font-kerning:none;font-variant-ligatures:none}" +
      `.lucy-title{font-family:${escapeXml(WINDOW_FONT_FAMILY)};font-size:${num(Math.round(m.fontSize * 0.87))}px;` +
      "font-weight:500}</style>",
  ];
  const under: string[] = [];
  const over: string[] = [];

  if (win) {
    head.push(
      `<clipPath id="lucy-window"><rect x="${win.x}" y="${win.y}" width="${win.w}" height="${win.h}" rx="${win.radius}"/></clipPath>`,
    );
    if (win.shadow) {
      head.push(
        `<filter id="lucy-shadow" x="-20%" y="-20%" width="140%" height="140%">` +
          `<feDropShadow dx="0" dy="${num(m.fontSize * 0.8)}" stdDeviation="${num(m.fontSize)}" flood-color="#000" flood-opacity="0.38"/></filter>`,
      );
      under.push(
        `<rect x="${win.x}" y="${win.y}" width="${win.w}" height="${win.h}" rx="${win.radius}" fill="${layout.background}" filter="url(#lucy-shadow)"/>`,
      );
    }
    under.push(`<g clip-path="url(#lucy-window)">`);
    under.push(
      `<rect x="${win.x}" y="${win.y}" width="${win.w}" height="${win.h}" fill="${layout.background}"/>`,
    );
    under.push(
      `<rect x="${win.x}" y="${win.y}" width="${win.w}" height="${win.titleBarH}" fill="${win.titleBarColor}"/>`,
      `<rect x="${win.x}" y="${win.y + win.titleBarH - 1}" width="${win.w}" height="1" fill="${win.separatorColor}"/>`,
    );
    const dotR = Math.round(m.fontSize * 0.4);
    const cy = win.y + win.titleBarH / 2;
    for (let i = 0; i < 3; i++) {
      const cx = win.x + Math.round(m.fontSize * 1.3) + i * Math.round(m.fontSize * 1.3);
      under.push(`<circle cx="${num(cx)}" cy="${num(cy)}" r="${dotR}" fill="${win.dotColor}"/>`);
    }
    if (win.title) {
      under.push(
        `<text class="lucy-title" x="${num(win.x + win.w / 2)}" y="${num(cy)}" dominant-baseline="central" fill="${win.titleColor}">${escapeXml(win.title)}</text>`,
      );
    }
    over.push("</g>");
    over.push(
      `<rect x="${win.x + 0.5}" y="${win.y + 0.5}" width="${win.w - 1}" height="${win.h - 1}" rx="${win.radius - 0.5}" fill="none" stroke="${win.borderColor}"/>`,
    );
  } else {
    under.push(`<rect width="${m.width}" height="${m.height}" fill="${layout.background}"/>`);
  }

  const grid: string[] = [];
  if (layout.backgrounds.length > 0) {
    grid.push('<g shape-rendering="crispEdges">');
    for (const r of layout.backgrounds) {
      grid.push(
        `<rect x="${num(r.x)}" y="${num(r.y)}" width="${num(r.w)}" height="${num(r.h)}" fill="${r.color}"/>`,
      );
    }
    grid.push("</g>");
  }
  for (const v of layout.vectors) {
    const crisp = v.shapes.every((s) => s.kind === "rect") ? ' shape-rendering="crispEdges"' : "";
    grid.push(
      `<g transform="translate(${num(v.x)} ${num(v.y)})" fill="${v.color}" color="${v.color}"${crisp}>${v.shapes.map(shapeToSvg).join("")}</g>`,
    );
  }
  if (layout.decorations.length > 0) {
    grid.push('<g shape-rendering="crispEdges">');
    for (const d of layout.decorations) {
      grid.push(
        `<rect x="${num(d.x)}" y="${num(d.y)}" width="${num(d.w)}" height="${num(d.h)}" fill="${d.color}"/>`,
      );
    }
    grid.push("</g>");
  }

  return {
    head: head.join("\n"),
    under: under.join("\n"),
    grid: grid.join("\n"),
    text: textToSvg(layout.glyphs),
    over: over.join("\n"),
  };
}

export function layoutToSvg(layout: Layout, { includeText = true }: { includeText?: boolean } = {}): string {
  const { width, height } = layout.metrics;
  const parts = svgParts(layout);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    layout.title ? `<title>${escapeXml(layout.title)}</title>` : "",
    `<defs>${parts.head}</defs>`,
    parts.under,
    parts.grid,
    includeText ? parts.text : "",
    parts.over,
    "</svg>",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

/** Renders a frame as a standalone SVG document. */
export function frameToSvg(frame: Frame, options: ScreenshotOptions = {}): string {
  return `${layoutToSvg(layoutFrame(frame, options))}\n`;
}
