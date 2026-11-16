/**
 * Image dimensions from file headers: tiny pure parsers, no decoding, no dependencies.
 * Each returns `null` when the bytes are not that format or the header is incomplete.
 * EXIF orientation is not applied (a rotated JPEG reports its stored dimensions).
 */

export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "bmp";

export interface ImageInfo {
  readonly format: ImageFormat;
  readonly width: number;
  readonly height: number;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] as number) << 8) | (bytes[offset + 1] as number);
}

function u16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] as number) | ((bytes[offset + 1] as number) << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return u16le(bytes, offset) | ((bytes[offset + 2] as number) << 16);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return u16be(bytes, offset) * 0x10000 + u16be(bytes, offset + 2);
}

function i32le(bytes: Uint8Array, offset: number): number {
  return u16le(bytes, offset) | ((bytes[offset + 2] as number) << 16) | ((bytes[offset + 3] as number) << 24);
}

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  return true;
}

function valid(format: ImageFormat, width: number, height: number): ImageInfo | null {
  return width > 0 && height > 0 ? { format, width, height } : null;
}

export function pngSize(bytes: Uint8Array): ImageInfo | null {
  if (
    bytes.length < 24 ||
    !ascii(bytes, 1, "PNG\r\n\x1a\n") ||
    bytes[0] !== 0x89 ||
    !ascii(bytes, 12, "IHDR")
  ) {
    return null;
  }
  return valid("png", u32be(bytes, 16), u32be(bytes, 20));
}

export function gifSize(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 10 || !(ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a"))) return null;
  return valid("gif", u16le(bytes, 6), u16le(bytes, 8));
}

/** Walks JPEG segments to the first start-of-frame marker. */
export function jpegSize(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] as number;
    if (marker === 0xff) {
      offset++; // Fill byte.
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // Standalone markers carry no length.
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // End of image / start of scan before a frame.
    const length = u16be(bytes, offset + 2);
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (offset + 9 > bytes.length) return null;
      return valid("jpeg", u16be(bytes, offset + 7), u16be(bytes, offset + 5));
    }
    offset += 2 + length;
  }
  return null;
}

export function webpSize(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 30 || !ascii(bytes, 0, "RIFF") || !ascii(bytes, 8, "WEBP")) return null;
  if (ascii(bytes, 12, "VP8 ")) {
    // Lossy: key frame start code 9d 01 2a, then 14-bit dimensions.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return valid("webp", u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
  }
  if (ascii(bytes, 12, "VP8L")) {
    if (bytes[20] !== 0x2f) return null;
    const b1 = bytes[21] as number;
    const b2 = bytes[22] as number;
    const b3 = bytes[23] as number;
    const b4 = bytes[24] as number;
    const width = 1 + (b1 | ((b2 & 0x3f) << 8));
    const height = 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10));
    return valid("webp", width, height);
  }
  if (ascii(bytes, 12, "VP8X")) {
    return valid("webp", 1 + u24le(bytes, 24), 1 + u24le(bytes, 27));
  }
  return null;
}

export function bmpSize(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 26 || !ascii(bytes, 0, "BM")) return null;
  const headerSize = u16le(bytes, 14);
  if (headerSize === 12) return valid("bmp", u16le(bytes, 18), u16le(bytes, 20));
  if (headerSize < 40) return null;
  // Negative height means a top-down bitmap.
  return valid("bmp", Math.abs(i32le(bytes, 18)), Math.abs(i32le(bytes, 22)));
}

export function imageSize(bytes: Uint8Array): ImageInfo | null {
  return pngSize(bytes) ?? jpegSize(bytes) ?? gifSize(bytes) ?? webpSize(bytes) ?? bmpSize(bytes);
}
