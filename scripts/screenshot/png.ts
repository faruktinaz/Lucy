/**
 * Rasterizes a screenshot SVG or HTML file with a headless Chromium-family browser.
 *
 * PNG output is a developer convenience: when no browser is installed, or the browser fails,
 * the result says so instead of throwing, and nothing else depends on it.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "@/core/process";
import { type BrowserInfo, findBrowser } from "./browser";
import { SIZE_META_NAME } from "./html";
import { cropImage, decodePng, encodePng } from "./png-codec";

/**
 * Headless Chrome lays out small windows wrongly (observed: 300x120 and 600x120 CSS px showed
 * only part of the page), so pages are rendered into at least this window and then cropped.
 */
const MIN_WINDOW = { width: 800, height: 600 };

export type PngResult =
  | { status: "written"; path: string; width: number; height: number; browser: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export interface RenderPngOptions {
  /** Device pixel ratio. Default 2 (crisp on Retina screens and in READMEs). */
  scale?: number;
  /** Browser to use; discovered with `findBrowser()` when omitted. */
  browser?: BrowserInfo | null;
  timeoutMs?: number;
}

/** CSS pixel size declared by a file produced by `frameToSvg` or `frameToHtml`. */
export function readDeclaredSize(
  source: string,
  kind: "svg" | "html",
): { width: number; height: number } | null {
  const match =
    kind === "svg"
      ? /<svg\b[^>]*?\swidth="(\d+(?:\.\d+)?)"[^>]*?\sheight="(\d+(?:\.\d+)?)"/.exec(source)
      : new RegExp(`<meta name="${SIZE_META_NAME}" content="(\\d+)x(\\d+)"`).exec(source);
  if (!match?.[1] || !match[2]) return null;
  return { width: Math.ceil(Number(match[1])), height: Math.ceil(Number(match[2])) };
}

/** Width and height from a PNG header, or null when the file is not a PNG. */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((byte, i) => bytes[i] !== byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * Flags that keep the browser offline, quiet and away from the user's profile: a throwaway
 * profile directory, no first-run or sync, no background networking, every hostname
 * unresolvable, and a mock keychain so macOS never prompts.
 */
function browserArgs(
  profileDir: string,
  width: number,
  height: number,
  scale: number,
  output: string,
): string[] {
  return [
    "--headless=new",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-extensions",
    "--disable-component-update",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication",
    "--no-pings",
    "--metrics-recording-only",
    "--host-resolver-rules=MAP * ~NOTFOUND",
    "--use-mock-keychain",
    "--password-store=basic",
    "--mute-audio",
    "--hide-scrollbars",
    "--allow-file-access-from-files",
    "--default-background-color=00000000",
    `--force-device-scale-factor=${scale}`,
    `--window-size=${width},${height}`,
    `--screenshot=${output}`,
  ];
}

export async function renderPng(
  inputPath: string,
  outputPath: string,
  options: RenderPngOptions = {},
): Promise<PngResult> {
  const scale = options.scale ?? 2;
  const browser = options.browser === undefined ? findBrowser() : options.browser;
  if (!browser) {
    return {
      status: "skipped",
      reason:
        "No Chromium-family browser found (Google Chrome, Chromium or Brave); set LUCY_SCREENSHOT_BROWSER",
    };
  }
  const input = resolve(inputPath);
  const output = resolve(outputPath);
  const kind = extname(input).toLowerCase() === ".svg" ? "svg" : "html";
  let size: { width: number; height: number } | null;
  try {
    size = readDeclaredSize(readFileSync(input, "utf8"), kind);
  } catch (error) {
    return { status: "failed", reason: `Cannot read ${input}: ${String(error)}` };
  }
  if (!size) return { status: "failed", reason: `${input} does not declare its size` };

  const profileDir = mkdtempSync(resolve(tmpdir(), "lucy-screenshot-profile-"));
  try {
    rmSync(output, { force: true });
    const window = {
      width: Math.max(size.width, MIN_WINDOW.width),
      height: Math.max(size.height, MIN_WINDOW.height),
    };
    const result = await run(
      [
        browser.path,
        ...browserArgs(profileDir, window.width, window.height, scale, output),
        pathToFileURL(input).href,
      ],
      { timeoutMs: options.timeoutMs ?? 60_000 },
    );
    if (!existsSync(output) || statSync(output).size === 0) {
      const detail = result.timedOut ? "timed out" : `exit code ${result.code}`;
      const stderr = result.stderr.trim().split("\n").slice(-3).join(" | ");
      return { status: "failed", reason: `${browser.name} wrote no screenshot (${detail}) ${stderr}`.trim() };
    }
    let png = readPngSize(readFileSync(output));
    if (!png) return { status: "failed", reason: `${output} is not a PNG` };
    const target = { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
    if (png.width !== target.width || png.height !== target.height) {
      const cropped = cropImage(decodePng(readFileSync(output)), target.width, target.height);
      writeFileSync(output, encodePng(cropped));
      png = { width: cropped.width, height: cropped.height };
    }
    return { status: "written", path: output, width: png.width, height: png.height, browser: browser.name };
  } catch (error) {
    return { status: "failed", reason: String(error) };
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
}
