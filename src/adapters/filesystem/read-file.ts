/**
 * Loads a file for the code viewer: text (with encoding facts), binary (with a MIME guess
 * and image dimensions), or too large.
 *
 * Safety: only regular files are read. The file is `stat`ed first and FIFOs, sockets and
 * devices are refused; it is then opened with O_NONBLOCK and re-checked with `fstat`, so
 * even a file swapped for a FIFO in between can never block the UI. A file reached through
 * a symlink that resolves outside the workspace may be read, but the result says so.
 */
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, realpath, stat } from "node:fs/promises";
import { fromFsError, LucyError } from "@/core/errors";
import { isWithin } from "@/core/paths";
import { throwIfAborted } from "./async-util";
import { detectBom, guessMime, looksBinary, SNIFF_BYTES, type TextEncoding } from "./file-sniff";
import { type ImageInfo, imageSize } from "./image-size";
import { joinRelative, nameOf, normalizeWorkspacePath } from "./workspace-path";

export interface ViewerLimits {
  /** Largest file loaded as text. Default 5 MiB. */
  readonly maxTextBytes: number;
  /** Bytes read from large or binary files for sniffing and image headers. Default 64 KiB. */
  readonly headerBytes: number;
}

export const DEFAULT_VIEWER_LIMITS: ViewerLimits = { maxTextBytes: 5 * 1024 * 1024, headerBytes: 64 * 1024 };

export type LineEnding = "lf" | "crlf" | "mixed";

interface ViewerFileBase {
  /** Workspace-relative path as requested. */
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  /** The path itself is a symlink. */
  readonly isSymlink: boolean;
  /** The real file lies outside the workspace (reached through a symlink): show a notice. */
  readonly outsideWorkspace: boolean;
}

export interface ViewerTextFile extends ViewerFileBase {
  readonly kind: "text";
  /** Decoded text without the BOM. Invalid UTF-8 after the sniff window becomes U+FFFD. */
  readonly content: string;
  /** Lines as an editor shows them, not counting the empty line after a final newline ("" has 0). */
  readonly lineCount: number;
  readonly encoding: TextEncoding;
  readonly bom: boolean;
  /** "lf" when the file has no line breaks. */
  readonly lineEnding: LineEnding;
  readonly finalNewline: boolean;
}

export interface ViewerBinaryFile extends ViewerFileBase {
  readonly kind: "binary";
  readonly mime: string;
  readonly image: ImageInfo | null;
}

export interface ViewerTooLargeFile extends ViewerFileBase {
  readonly kind: "too-large";
  readonly limit: number;
}

export type ViewerFile = ViewerTextFile | ViewerBinaryFile | ViewerTooLargeFile;

export interface ReadFileForViewerOptions {
  limits?: Partial<ViewerLimits>;
  signal?: AbortSignal;
}

function describeSpecial(info: Stats): string {
  if (info.isFIFO()) return "a named pipe";
  if (info.isSocket()) return "a socket";
  if (info.isCharacterDevice() || info.isBlockDevice()) return "a device";
  return "not a regular file";
}

/** Reads from the start until EOF or `limit` bytes; the buffer grows from `sizeHint`. */
async function readUpTo(handle: FileHandle, limit: number, sizeHint: number): Promise<Uint8Array> {
  let buffer = new Uint8Array(Math.min(limit, Math.max(sizeHint + 1, 4096)));
  let filled = 0;
  while (filled < limit) {
    if (filled === buffer.length) {
      const grown = new Uint8Array(Math.min(limit, buffer.length * 2));
      grown.set(buffer);
      buffer = grown;
    }
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/** Line statistics in one pass over the decoded text. */
export function analyzeLines(content: string): {
  lineCount: number;
  lineEnding: LineEnding;
  finalNewline: boolean;
} {
  let lf = 0;
  let crlf = 0;
  let index = content.indexOf("\n");
  while (index !== -1) {
    if (index > 0 && content.charCodeAt(index - 1) === 13) crlf++;
    else lf++;
    index = content.indexOf("\n", index + 1);
  }
  const breaks = lf + crlf;
  const finalNewline = content.endsWith("\n");
  const lineCount = content.length === 0 ? 0 : breaks + (finalNewline ? 0 : 1);
  const lineEnding: LineEnding = crlf > 0 && lf > 0 ? "mixed" : crlf > 0 ? "crlf" : "lf";
  return { lineCount, lineEnding, finalNewline };
}

function decodeText(bytes: Uint8Array): { content: string; encoding: TextEncoding; bom: boolean } {
  const bom = detectBom(bytes);
  const encoding = bom?.encoding ?? "utf-8";
  const body = bom ? bytes.subarray(bom.length) : bytes;
  // ignoreBOM: the BOM was already stripped above; a second U+FEFF is content.
  const content = new TextDecoder(encoding, { fatal: false, ignoreBOM: true }).decode(body);
  return { content, encoding, bom: bom !== null };
}

export async function readFileForViewer(
  root: string,
  path: string,
  options: ReadFileForViewerOptions = {},
): Promise<ViewerFile> {
  const limits: ViewerLimits = { ...DEFAULT_VIEWER_LIMITS, ...options.limits };
  const rel = normalizeWorkspacePath(root, path, "existing");
  const abs = joinRelative(root, rel);
  let isSymlink: boolean;
  let real: string;
  let realRoot: string;
  let info: Stats;
  try {
    isSymlink = (await lstat(abs)).isSymbolicLink();
    real = await realpath(abs);
    realRoot = await realpath(root);
    info = await stat(real);
  } catch (error) {
    throw fromFsError(error, rel);
  }
  throwIfAborted(options.signal);
  if (info.isDirectory()) throw new LucyError("INVALID_ARGUMENT", `"${rel}" is a folder, not a file`);
  if (!info.isFile()) {
    throw new LucyError("UNSUPPORTED", `"${rel}" is ${describeSpecial(info)} and cannot be opened`);
  }
  const base = {
    path: rel,
    size: info.size,
    mtimeMs: info.mtimeMs,
    isSymlink,
    outsideWorkspace: !isWithin(realRoot, real),
  };

  let handle: FileHandle;
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
  } catch (error) {
    throw fromFsError(error, rel);
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new LucyError("UNSUPPORTED", `"${rel}" is ${describeSpecial(opened)} and cannot be opened`);
    }
    const size = opened.size;
    if (size > limits.maxTextBytes) {
      const headerLimit = Math.max(limits.headerBytes, SNIFF_BYTES);
      const header = await readUpTo(handle, headerLimit, headerLimit);
      if (looksBinary(header, false)) {
        return {
          kind: "binary",
          ...base,
          size,
          mime: guessMime(header, nameOf(rel)),
          image: imageSize(header),
        };
      }
      return { kind: "too-large", ...base, size, limit: limits.maxTextBytes };
    }
    // One byte more than allowed tells us whether the file grew past the limit meanwhile.
    const bytes = await readUpTo(handle, limits.maxTextBytes + 1, size);
    throwIfAborted(options.signal);
    if (bytes.length > limits.maxTextBytes) {
      return { kind: "too-large", ...base, size: bytes.length, limit: limits.maxTextBytes };
    }
    if (looksBinary(bytes, true)) {
      return {
        kind: "binary",
        ...base,
        size: bytes.length,
        mime: guessMime(bytes, nameOf(rel)),
        image: imageSize(bytes.subarray(0, Math.max(limits.headerBytes, SNIFF_BYTES))),
      };
    }
    const decoded = decodeText(bytes);
    return { kind: "text", ...base, size: bytes.length, ...decoded, ...analyzeLines(decoded.content) };
  } catch (error) {
    throw error instanceof LucyError ? error : fromFsError(error, rel);
  } finally {
    await handle.close().catch(() => {});
  }
}
