import { describe, expect, test } from "bun:test";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isValidUtf8, looksBinary } from "@/adapters/filesystem/file-sniff";
import { bmpSize, gifSize, imageSize, jpegSize, pngSize, webpSize } from "@/adapters/filesystem/image-size";
import { readFileForViewer } from "@/adapters/filesystem/read-file";
import { isLucyError, type LucyErrorCode } from "@/core/errors";
import { run } from "@/core/process";
import { createTempDirs, writeTree } from "./helpers";

const tempDir = createTempDirs("lucy-read-");

function bytes(...parts: Array<number[] | string | Uint8Array>): Uint8Array {
  const chunks = parts.map((part) =>
    typeof part === "string"
      ? new TextEncoder().encode(part)
      : part instanceof Uint8Array
        ? part
        : Uint8Array.from(part),
  );
  return Uint8Array.from(chunks.flatMap((chunk) => [...chunk]));
}

const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
const be16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff];
const le24 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

const PNG = bytes(
  [0x89],
  "PNG\r\n\x1a\n",
  be32(13),
  "IHDR",
  be32(640),
  be32(480),
  [8, 6, 0, 0, 0],
  new Uint8Array(32),
);
const GIF = bytes("GIF89a", le16(320), le16(200), new Uint8Array(16));
const JPEG = bytes(
  [0xff, 0xd8],
  [0xff, 0xe0],
  be16(16),
  "JFIF\0",
  new Uint8Array(9),
  [0xff, 0xff], // Fill byte before the next marker.
  [0xc0],
  be16(17),
  [8],
  be16(1080),
  be16(1920),
  new Uint8Array(12),
);
const WEBP_VP8X = bytes(
  "RIFF",
  le32(30),
  "WEBP",
  "VP8X",
  le32(10),
  [0, 0, 0, 0],
  le24(799),
  le24(599),
  new Uint8Array(8),
);
const vp8lBits = 99 | (49 << 14);
const WEBP_VP8L = bytes(
  "RIFF",
  le32(30),
  "WEBP",
  "VP8L",
  le32(5),
  [0x2f],
  le32(vp8lBits),
  new Uint8Array(10),
);
const WEBP_VP8 = bytes(
  "RIFF",
  le32(30),
  "WEBP",
  "VP8 ",
  le32(10),
  [0, 0, 0],
  [0x9d, 0x01, 0x2a],
  le16(300),
  le16(150),
  new Uint8Array(8),
);
const BMP = bytes("BM", le32(0), le32(0), le32(54), le32(40), le32(16), le32(-9 >>> 0), new Uint8Array(8));

async function expectCode(promise: Promise<unknown>, code: LucyErrorCode): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (!isLucyError(error)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("image headers", () => {
  test("parses PNG, GIF, JPEG, WebP (VP8, VP8L, VP8X) and BMP dimensions", () => {
    expect(pngSize(PNG)).toEqual({ format: "png", width: 640, height: 480 });
    expect(gifSize(GIF)).toEqual({ format: "gif", width: 320, height: 200 });
    expect(jpegSize(JPEG)).toEqual({ format: "jpeg", width: 1920, height: 1080 });
    expect(webpSize(WEBP_VP8X)).toEqual({ format: "webp", width: 800, height: 600 });
    expect(webpSize(WEBP_VP8L)).toEqual({ format: "webp", width: 100, height: 50 });
    expect(webpSize(WEBP_VP8)).toEqual({ format: "webp", width: 300, height: 150 });
    expect(bmpSize(BMP)).toEqual({ format: "bmp", width: 16, height: 9 });
    expect(imageSize(JPEG)?.format).toBe("jpeg");
  });

  test("rejects truncated or foreign headers", () => {
    expect(pngSize(PNG.subarray(0, 20))).toBeNull();
    expect(jpegSize(JPEG.subarray(0, 10))).toBeNull();
    expect(gifSize(PNG)).toBeNull();
    expect(imageSize(bytes("hello world, not an image at all"))).toBeNull();
    expect(jpegSize(bytes([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0]))).toBeNull();
  });
});

describe("text sniffing", () => {
  test("UTF-8 validation tolerates a sequence cut at the sample boundary only when asked", () => {
    const cut = bytes("abc", [0xc4]); // First byte of "ğ".
    expect(isValidUtf8(cut, true)).toBe(true);
    expect(isValidUtf8(cut, false)).toBe(false);
    expect(isValidUtf8(bytes([0xc0, 0x80]), true)).toBe(false); // Overlong.
    expect(isValidUtf8(bytes([0xed, 0xa0, 0x80]), true)).toBe(false); // Surrogate.
    expect(isValidUtf8(bytes("ığüşöç İstanbul 🎉"), false)).toBe(true);
    expect(looksBinary(bytes("plain\0text"), true)).toBe(true);
    expect(looksBinary(bytes([0xff, 0xfe, 0x41, 0x00]), true)).toBe(false); // UTF-16 LE BOM.
  });
});

describe("readFileForViewer", () => {
  test("text files: line endings, counts, BOM, encodings", async () => {
    const root = await tempDir();
    await writeTree(root, {
      "lf.txt": "a\nb\n",
      "crlf.txt": "a\r\nb\r\nc",
      "mixed.txt": "a\r\nb\nc\n",
      "empty.txt": "",
      "bom.txt": bytes([0xef, 0xbb, 0xbf], "hello\n"),
      "utf16.txt": bytes([0xff, 0xfe], new Uint8Array(Buffer.from("hi\nthere", "utf16le"))),
      "ığüşöç İstanbul.md": "# Merhaba\n",
    });
    expect(await readFileForViewer(root, "lf.txt")).toMatchObject({
      kind: "text",
      content: "a\nb\n",
      lineCount: 2,
      lineEnding: "lf",
      finalNewline: true,
      bom: false,
      encoding: "utf-8",
      size: 4,
      outsideWorkspace: false,
    });
    expect(await readFileForViewer(root, "crlf.txt")).toMatchObject({
      lineEnding: "crlf",
      lineCount: 3,
      finalNewline: false,
    });
    expect(await readFileForViewer(root, "mixed.txt")).toMatchObject({ lineEnding: "mixed", lineCount: 3 });
    expect(await readFileForViewer(root, "empty.txt")).toMatchObject({
      kind: "text",
      lineCount: 0,
      content: "",
    });
    expect(await readFileForViewer(root, "bom.txt")).toMatchObject({ content: "hello\n", bom: true });
    expect(await readFileForViewer(root, "utf16.txt")).toMatchObject({
      kind: "text",
      encoding: "utf-16le",
      content: "hi\nthere",
      bom: true,
    });
    expect(await readFileForViewer(root, "ığüşöç İstanbul.md")).toMatchObject({ content: "# Merhaba\n" });
  });

  test("binary detection: NUL byte, invalid UTF-8, and a character cut at 8 KiB is still text", async () => {
    const root = await tempDir();
    const boundary = bytes("x".repeat(8191), "ğ", "tail\n"); // "ğ" straddles byte 8192.
    await writeTree(root, {
      "nul.bin": bytes("abc", [0], "def"),
      "latin1.txt": bytes("caf", [0xe9], " au lait"),
      "boundary.txt": boundary,
      "image.png": PNG,
      "photo.jpg": JPEG,
      "archive.zip": bytes("PK\x03\x04", new Uint8Array(30)),
    });
    expect(await readFileForViewer(root, "nul.bin")).toMatchObject({
      kind: "binary",
      mime: "application/octet-stream",
    });
    expect(await readFileForViewer(root, "latin1.txt")).toMatchObject({ kind: "binary" });
    const text = await readFileForViewer(root, "boundary.txt");
    expect(text.kind).toBe("text");
    if (text.kind === "text") expect(text.content.endsWith("ğtail\n")).toBe(true);
    expect(await readFileForViewer(root, "image.png")).toMatchObject({
      kind: "binary",
      mime: "image/png",
      image: { format: "png", width: 640, height: 480 },
    });
    expect(await readFileForViewer(root, "photo.jpg")).toMatchObject({
      mime: "image/jpeg",
      image: { width: 1920 },
    });
    expect(await readFileForViewer(root, "archive.zip")).toMatchObject({
      mime: "application/zip",
      image: null,
    });
  });

  test("files over the limit are too-large, unless they are binary (then sniffed from the header)", async () => {
    const root = await tempDir();
    await writeTree(root, { "big.txt": "line\n".repeat(400), "big.png": bytes(PNG, new Uint8Array(4000)) });
    const limits = { maxTextBytes: 1000 };
    expect(await readFileForViewer(root, "big.txt", { limits })).toMatchObject({
      kind: "too-large",
      size: 2000,
      limit: 1000,
    });
    expect(await readFileForViewer(root, "big.png", { limits })).toMatchObject({
      kind: "binary",
      image: { width: 640, height: 480 },
    });
  });

  test("refuses FIFOs and devices without blocking, and folders", async () => {
    const root = await tempDir();
    await run(["mkfifo", join(root, "pipe")]);
    await symlink("/dev/null", join(root, "null-device"));
    await writeTree(root, { "folder/": "" });
    const started = performance.now();
    await expectCode(readFileForViewer(root, "pipe"), "UNSUPPORTED");
    await expectCode(readFileForViewer(root, "null-device"), "UNSUPPORTED");
    expect(performance.now() - started).toBeLessThan(1000);
    await expectCode(readFileForViewer(root, "folder"), "INVALID_ARGUMENT");
    await expectCode(readFileForViewer(root, "missing.txt"), "NOT_FOUND");
  });

  test("traversal is refused; a symlink to an outside file is read and flagged", async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await writeTree(outside, { "secret.txt": "outside\n" });
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
    await symlink(outside, join(root, "outdir"));
    await expectCode(readFileForViewer(root, "../secret.txt"), "OUTSIDE_WORKSPACE");
    await expectCode(readFileForViewer(root, join(outside, "secret.txt")), "OUTSIDE_WORKSPACE");
    expect(await readFileForViewer(root, "link.txt")).toMatchObject({
      kind: "text",
      content: "outside\n",
      isSymlink: true,
      outsideWorkspace: true,
    });
    expect(await readFileForViewer(root, "outdir/secret.txt")).toMatchObject({
      isSymlink: false,
      outsideWorkspace: true,
    });
  });

  test("honors an already-aborted signal", async () => {
    const root = await tempDir();
    await writeFile(join(root, "a.txt"), "a");
    const controller = new AbortController();
    controller.abort();
    await expectCode(readFileForViewer(root, "a.txt", { signal: controller.signal }), "CANCELLED");
  });
});
