/**
 * Screenshot library: turns an OpenTUI `CapturedFrame` (`captureSpans()`) into SVG, HTML,
 * ANSI, plain text and, when a Chromium-family browser is installed, PNG.
 */
export { frameToAnsi } from "./ansi";
export { type CellBox, isVectorGlyph, type Shape, vectorGlyphShapes } from "./box-drawing";
export { BROWSER_ENV_VAR, type BrowserInfo, findBrowser } from "./browser";
export { findTextInFrame, frameCells, frameToText, graphemes, graphemeWidth } from "./cells";
export { DEFAULT_BACKGROUND, DEFAULT_FOREGROUND } from "./color";
export { frameToHtml, SIZE_META_NAME } from "./html";
export { DEFAULT_FONT_FAMILY, type Layout, layoutFrame } from "./layout";
export { type PngResult, type RenderPngOptions, readPngSize, renderPng } from "./png";
export { type SavedScreenshot, type SaveScreenshotOptions, saveScreenshot } from "./save";
export { frameToSvg } from "./svg";
export {
  Attr,
  type ColorIntent,
  type Frame,
  type FrameColor,
  type FrameLine,
  type FrameSpan,
  type ScreenshotOptions,
  type WindowFrameOptions,
} from "./types";
