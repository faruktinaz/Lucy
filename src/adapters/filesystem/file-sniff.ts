/**
 * Content sniffing: text vs binary, byte-order marks, and a MIME guess. Pure functions.
 */

/** Bytes examined to decide text vs binary (same window as Git and ripgrep use). */
export const SNIFF_BYTES = 8192;

export type TextEncoding = "utf-8" | "utf-16le" | "utf-16be";

export function detectBom(bytes: Uint8Array): { encoding: TextEncoding; length: number } | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { encoding: "utf-8", length: 3 };
  // UTF-32 LE also starts with FF FE; it is rare enough to be reported as binary.
  if (bytes[0] === 0xff && bytes[1] === 0xfe && !(bytes[2] === 0 && bytes[3] === 0)) {
    return { encoding: "utf-16le", length: 2 };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: "utf-16be", length: 2 };
  return null;
}

/**
 * Strict UTF-8 validation (no overlongs, no surrogates, nothing above U+10FFFF). With
 * `allowTruncatedEnd`, a multi-byte sequence cut off by the end of `bytes` is accepted as
 * long as the bytes present are a valid prefix: needed when `bytes` is a sample.
 */
export function isValidUtf8(bytes: Uint8Array, allowTruncatedEnd: boolean): boolean {
  const n = bytes.length;
  let i = 0;
  while (i < n) {
    const lead = bytes[i] as number;
    if (lead < 0x80) {
      i++;
      continue;
    }
    let need: number;
    let secondMin = 0x80;
    let secondMax = 0xbf;
    if (lead >= 0xc2 && lead <= 0xdf) need = 1;
    else if (lead >= 0xe0 && lead <= 0xef) {
      need = 2;
      if (lead === 0xe0) secondMin = 0xa0;
      else if (lead === 0xed) secondMax = 0x9f; // Would encode a UTF-16 surrogate.
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      need = 3;
      if (lead === 0xf0) secondMin = 0x90;
      else if (lead === 0xf4) secondMax = 0x8f;
    } else {
      return false;
    }
    const available = Math.min(need, n - i - 1);
    for (let k = 1; k <= available; k++) {
      const byte = bytes[i + k] as number;
      const min = k === 1 ? secondMin : 0x80;
      const max = k === 1 ? secondMax : 0xbf;
      if (byte < min || byte > max) return false;
    }
    if (available < need) return allowTruncatedEnd;
    i += need + 1;
  }
  return true;
}

/**
 * Binary when the first `SNIFF_BYTES` contain a NUL byte or invalid UTF-8. UTF-16 text with
 * a BOM is text. `isComplete` says whether `sample` is the whole file (otherwise a sequence
 * cut at the end of the sample is not held against it).
 */
export function looksBinary(sample: Uint8Array, isComplete: boolean): boolean {
  const bom = detectBom(sample);
  if (bom && bom.encoding !== "utf-8") return false;
  const window = sample.length > SNIFF_BYTES ? sample.subarray(0, SNIFF_BYTES) : sample;
  if (window.includes(0)) return true;
  return !isValidUtf8(window, !isComplete || sample.length > SNIFF_BYTES);
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) if (bytes[offset + i] !== signature[i]) return false;
  return true;
}

function startsWithText(bytes: Uint8Array, text: string, offset = 0): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  return true;
}

const EXTENSION_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  avif: "image/avif",
  psd: "image/vnd.adobe.photoshop",
  pdf: "application/pdf",
  zip: "application/zip",
  jar: "application/java-archive",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  epub: "application/epub+zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  bz2: "application/x-bzip2",
  xz: "application/x-xz",
  zst: "application/zstd",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  wasm: "application/wasm",
  class: "application/java-vm",
  exe: "application/vnd.microsoft.portable-executable",
  dll: "application/vnd.microsoft.portable-executable",
  so: "application/x-sharedlib",
  dylib: "application/x-mach-binary",
  o: "application/x-object",
  a: "application/x-archive",
  pyc: "application/x-python-code",
  sqlite: "application/vnd.sqlite3",
  db: "application/vnd.sqlite3",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** MIME type from magic bytes, refined or replaced by the file extension. */
export function guessMime(header: Uint8Array, name: string): string {
  const ext = extensionOf(name);
  const byExtension = EXTENSION_MIME[ext];
  if (startsWith(header, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (startsWith(header, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWithText(header, "GIF8")) return "image/gif";
  if (startsWithText(header, "RIFF")) {
    if (startsWithText(header, "WEBP", 8)) return "image/webp";
    if (startsWithText(header, "WAVE", 8)) return "audio/wav";
    if (startsWithText(header, "AVI ", 8)) return "video/x-msvideo";
  }
  if (startsWithText(header, "BM") && [12, 40, 52, 56, 108, 124].includes(header[14] ?? -1))
    return "image/bmp";
  if (startsWith(header, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  if (startsWithText(header, "II*\0") || startsWithText(header, "MM\0*")) return "image/tiff";
  if (startsWithText(header, "8BPS")) return "image/vnd.adobe.photoshop";
  if (startsWithText(header, "%PDF-")) return "application/pdf";
  if (startsWithText(header, "PK\x03\x04") || startsWithText(header, "PK\x05\x06")) {
    return byExtension && /zip|openxml|java-archive|epub/.test(byExtension) ? byExtension : "application/zip";
  }
  if (startsWith(header, [0x1f, 0x8b])) return "application/gzip";
  if (startsWithText(header, "BZh")) return "application/x-bzip2";
  if (startsWith(header, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return "application/x-xz";
  if (startsWith(header, [0x28, 0xb5, 0x2f, 0xfd])) return "application/zstd";
  if (startsWith(header, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "application/x-7z-compressed";
  if (startsWithText(header, "Rar!\x1a\x07")) return "application/vnd.rar";
  if (startsWith(header, [0x7f, 0x45, 0x4c, 0x46])) return "application/x-elf";
  if (startsWith(header, [0x00, 0x61, 0x73, 0x6d])) return "application/wasm";
  if (startsWithText(header, "MZ")) return "application/vnd.microsoft.portable-executable";
  if (startsWith(header, [0xca, 0xfe, 0xba, 0xbe])) {
    // Java class files and universal Mach-O binaries share this magic.
    return ext === "class" ? "application/java-vm" : "application/x-mach-binary";
  }
  for (const magic of [
    [0xfe, 0xed, 0xfa, 0xce],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xcf, 0xfa, 0xed, 0xfe],
  ]) {
    if (startsWith(header, magic)) return "application/x-mach-binary";
  }
  if (startsWithText(header, "SQLite format 3\0")) return "application/vnd.sqlite3";
  if (startsWithText(header, "ID3")) return "audio/mpeg";
  if (startsWithText(header, "OggS")) return "audio/ogg";
  if (startsWithText(header, "fLaC")) return "audio/flac";
  if (startsWithText(header, "ftyp", 4)) {
    if (startsWithText(header, "qt  ", 8)) return "video/quicktime";
    if (["heic", "heix", "mif1", "msf1"].some((brand) => startsWithText(header, brand, 8)))
      return "image/heic";
    if (startsWithText(header, "avif", 8)) return "image/avif";
    if (startsWithText(header, "M4A ", 8)) return "audio/mp4";
    return "video/mp4";
  }
  if (startsWith(header, [0x1a, 0x45, 0xdf, 0xa3])) return ext === "mkv" ? "video/x-matroska" : "video/webm";
  if (startsWithText(header, "wOFF")) return "font/woff";
  if (startsWithText(header, "wOF2")) return "font/woff2";
  if (startsWithText(header, "OTTO")) return "font/otf";
  if (startsWith(header, [0x00, 0x01, 0x00, 0x00, 0x00])) return "font/ttf";
  return byExtension ?? "application/octet-stream";
}
