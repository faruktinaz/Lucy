/**
 * Writing a text file back exactly as the user would expect: same encoding (UTF-8, with the
 * BOM if it had one), same line endings, same final-newline state, same permissions, and
 * atomically (a temp file in the same folder, fsync, rename), so a crash or kill never leaves a
 * half-written file. Symlinks inside the workspace are followed: the link stays a link and its
 * target is written.
 */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { LineEnding } from "@/adapters/filesystem";
import { fromFsError, LucyError } from "@/core/errors";
import type { FileStamp } from "./model";

/** How the file looked on disk, so the edited text can be written back the same way. */
export interface TextFormat {
  readonly bom: boolean;
  readonly lineEnding: LineEnding;
  /** The dominant break of a "mixed" file (written for every line). */
  readonly mixedPrefersCrlf: boolean;
  readonly finalNewline: boolean;
}

const UTF8_BOM = Uint8Array.from([0xef, 0xbb, 0xbf]);

/**
 * Buffer text (lines joined with "\n", no trailing newline) to file text. A "mixed" file is
 * written with its more common break: the editor cannot know which line had which.
 */
export function toFileText(text: string, format: TextFormat): string {
  const crlf = format.lineEnding === "crlf" || (format.lineEnding === "mixed" && format.mixedPrefersCrlf);
  let out = crlf ? text.replace(/\r?\n/g, "\r\n") : text;
  if (format.finalNewline && text !== "") out += crlf ? "\r\n" : "\n";
  return out;
}

/** File text (as decoded, without the BOM) to buffer text: "\n" breaks, final newline removed. */
export function toBufferText(content: string, finalNewline: boolean): string {
  let text = content.replace(/\r\n/g, "\n");
  if (finalNewline && text.endsWith("\n")) text = text.slice(0, -1);
  return text;
}

/** Whether a mixed file has more CRLF than LF breaks. */
export function prefersCrlf(content: string): boolean {
  let crlf = 0;
  let lf = 0;
  for (let i = content.indexOf("\n"); i !== -1; i = content.indexOf("\n", i + 1)) {
    if (i > 0 && content.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return crlf > lf;
}

export function encodeFileText(text: string, format: TextFormat): Uint8Array {
  const body = new TextEncoder().encode(toFileText(text, format));
  if (!format.bom) return body;
  const out = new Uint8Array(UTF8_BOM.length + body.length);
  out.set(UTF8_BOM);
  out.set(body, UTF8_BOM.length);
  return out;
}

/**
 * Writes `bytes` to `path` atomically, keeping the file's permission bits. Returns the new
 * stamp. The temp file lives next to the target so the rename never crosses filesystems.
 */
export async function writeFileAtomic(path: string, bytes: Uint8Array): Promise<FileStamp> {
  let target: string;
  let mode = 0o644;
  try {
    target = await realpath(path);
    mode = (await stat(target)).mode & 0o7777;
  } catch (error) {
    // A file deleted meanwhile is created again with the default mode.
    if ((error as { code?: unknown }).code !== "ENOENT") throw fromFsError(error, path);
    target = path;
  }
  const temp = join(dirname(target), `.${basename(target)}.lucy-${randomBytes(4).toString("hex")}.tmp`);
  try {
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    try {
      await handle.writeFile(bytes);
      // The umask may have narrowed the mode given to open(); set it exactly.
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error instanceof LucyError ? error : fromFsError(error, path);
  }
  const info = await stat(target);
  return { size: info.size, mtimeMs: info.mtimeMs };
}
