/**
 * Human-readable labels for the status bar and the information cards. Kept separate from the
 * loaders so views can reuse them (the explorer's hover card shows the same sizes).
 */
import type { LineEnding } from "@/adapters/filesystem";

const UNITS = ["KB", "MB", "GB", "TB"] as const;

/**
 * `0 B`, `912 B`, `1.5 KB`, `12 KB`, `3.4 MB`. Binary multiples (1 KB = 1024 bytes), as
 * Finder's "Get Info" did for years and as most terminal tools (`ls -lh`, `du -h`) still do.
 * One decimal below 10 units, none above: the card has a narrow column.
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  // 1023.96 KB would print as "1024 KB": promote so the label never shows 1024 of a unit.
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  if (rounded >= 1024 && unit < UNITS.length - 1) return `1 ${UNITS[unit + 1]}`;
  const text = value < 10 ? rounded.toFixed(1).replace(/\.0$/, "") : String(rounded);
  return `${text} ${UNITS[unit]}`;
}

/** `UTF-8`, `UTF-8 with BOM`, `UTF-16 LE`, `UTF-16 BE` (UTF-16 always has a BOM here). */
export function encodingLabel(encoding: "utf-8" | "utf-16le" | "utf-16be", bom: boolean): string {
  switch (encoding) {
    case "utf-16le":
      return "UTF-16 LE";
    case "utf-16be":
      return "UTF-16 BE";
    default:
      return bom ? "UTF-8 with BOM" : "UTF-8";
  }
}

/** `LF`, `CRLF` or `Mixed` (the status bar wording VS Code uses for the first two). */
export function lineEndingLabel(lineEnding: LineEnding): string {
  switch (lineEnding) {
    case "crlf":
      return "CRLF";
    case "mixed":
      return "Mixed";
    default:
      return "LF";
  }
}

/** `PNG image`, `PDF document`, ... from a MIME type, for the binary information card. */
export function describeMime(mime: string): string {
  const known: Record<string, string> = {
    "application/pdf": "PDF document",
    "application/zip": "ZIP archive",
    "application/gzip": "gzip archive",
    "application/x-tar": "tar archive",
    "application/x-bzip2": "bzip2 archive",
    "application/x-xz": "xz archive",
    "application/zstd": "Zstandard archive",
    "application/x-7z-compressed": "7-Zip archive",
    "application/vnd.rar": "RAR archive",
    "application/x-elf": "ELF executable",
    "application/x-mach-binary": "Mach-O executable",
    "application/vnd.microsoft.portable-executable": "Windows executable",
    "application/java-vm": "Java class file",
    "image/vnd.adobe.photoshop": "Photoshop image",
    "application/wasm": "WebAssembly module",
    "application/x-sqlite3": "SQLite database",
    "application/vnd.sqlite3": "SQLite database",
    "application/octet-stream": "Binary file",
    "image/svg+xml": "SVG image",
    "image/x-icon": "Icon image",
    "image/vnd.microsoft.icon": "Icon image",
  };
  const exact = known[mime];
  if (exact) return exact;
  const [type, subtype = ""] = mime.split("/");
  const name = subtype.replace(/^(x-|vnd\.)/, "").toUpperCase();
  switch (type) {
    case "image":
      return `${name} image`;
    case "audio":
      return `${name} audio`;
    case "video":
      return `${name} video`;
    case "font":
      return `${name} font`;
    default:
      return "Binary file";
  }
}
