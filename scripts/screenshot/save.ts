/** Writes every screenshot format for one frame next to each other. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { frameToAnsi } from "./ansi";
import { frameToText } from "./cells";
import { frameToHtml } from "./html";
import { type PngResult, type RenderPngOptions, renderPng } from "./png";
import { frameToSvg } from "./svg";
import type { Frame, ScreenshotOptions } from "./types";

export interface SaveScreenshotOptions extends ScreenshotOptions {
  /** Rasterize the SVG to `<base>.png` when a browser is available. Default true. */
  png?: boolean | RenderPngOptions;
  /** Also write `<base>.ansi` (view with `cat`). Default false. */
  ansi?: boolean;
}

export interface SavedScreenshot {
  txt: string;
  svg: string;
  html: string;
  ansi: string | null;
  png: PngResult;
}

/** Writes `<base>.txt`, `<base>.svg`, `<base>.html` and, when possible, `<base>.png`. */
export async function saveScreenshot(
  frame: Frame,
  basePath: string,
  options: SaveScreenshotOptions = {},
): Promise<SavedScreenshot> {
  const base = resolve(basePath);
  mkdirSync(dirname(base), { recursive: true });
  const { png, ansi, ...render } = options;

  const txt = `${base}.txt`;
  const svg = `${base}.svg`;
  const html = `${base}.html`;
  writeFileSync(txt, `${frameToText(frame)}\n`);
  writeFileSync(svg, frameToSvg(frame, render));
  writeFileSync(html, frameToHtml(frame, render));
  let ansiPath: string | null = null;
  if (ansi) {
    ansiPath = `${base}.ansi`;
    writeFileSync(ansiPath, frameToAnsi(frame));
  }
  const pngResult: PngResult =
    png === false
      ? { status: "skipped", reason: "PNG output disabled" }
      : await renderPng(svg, `${base}.png`, png === true || png === undefined ? {} : png);
  return { txt, svg, html, ansi: ansiPath, png: pngResult };
}
