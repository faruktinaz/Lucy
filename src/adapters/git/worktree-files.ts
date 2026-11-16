/**
 * Bounded reads of working-tree files for the "right side" of a diff and for discard previews.
 * Symlinks are reported as their target text (as Git stores them) and never followed, and the
 * parent directory is resolved inside the repository so a symlinked folder cannot leak content
 * from outside it.
 */
import type { Stats } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { realpathWithin } from "@/core/paths";
import type { GitFileContent } from "./types";

/** Git's own heuristic: a NUL byte in the first 8000 bytes means binary. */
const BINARY_SNIFF_BYTES = 8000;

export function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

export function looksBinaryText(text: string): boolean {
  return text.slice(0, BINARY_SNIFF_BYTES).includes("\0");
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return text.endsWith("\n") ? lines : lines + 1;
}

const MISSING: GitFileContent = {
  exists: false,
  content: null,
  isBinary: false,
  isTooLarge: false,
  size: null,
};

/** Absolute path of `repoPath` with its parent resolved inside `root`, or `null` if it escapes. */
async function locate(root: string, repoPath: string): Promise<string | null> {
  const relative = repoPath.endsWith("/") ? repoPath.slice(0, -1) : repoPath;
  const absolute = join(root, ...relative.split("/"));
  const parent = await realpathWithin(root, dirname(absolute));
  return parent ? join(parent, basename(absolute)) : null;
}

export async function readWorktreeFile(
  root: string,
  repoPath: string,
  maxBytes: number,
): Promise<GitFileContent> {
  const target = await locate(root, repoPath);
  if (!target) return MISSING;
  let info: Stats;
  try {
    info = await lstat(target);
  } catch {
    return MISSING;
  }
  if (info.isSymbolicLink()) {
    const link = await readlink(target);
    return { exists: true, content: link, isBinary: false, isTooLarge: false, size: Buffer.byteLength(link) };
  }
  if (!info.isFile()) return MISSING;
  if (info.size > maxBytes) {
    return { exists: true, content: null, isBinary: false, isTooLarge: true, size: info.size };
  }
  const bytes = await Bun.file(target).bytes();
  if (looksBinary(bytes))
    return { exists: true, content: null, isBinary: true, isTooLarge: false, size: bytes.length };
  return {
    exists: true,
    content: Buffer.from(bytes).toString("utf8"),
    isBinary: false,
    isTooLarge: false,
    size: bytes.length,
  };
}

export interface UntrackedFileInfo {
  kind: "file" | "symlink" | "directory" | "missing" | "other";
  size: number | null;
  lines: number | null;
  isBinary: boolean;
}

/** Size, line count and binary flag of an untracked path, for the discard confirmation. */
export async function describeUntrackedFile(
  root: string,
  repoPath: string,
  maxBytes: number,
): Promise<UntrackedFileInfo> {
  const target = await locate(root, repoPath);
  if (!target) return { kind: "missing", size: null, lines: null, isBinary: false };
  let info: Stats;
  try {
    info = await lstat(target);
  } catch {
    return { kind: "missing", size: null, lines: null, isBinary: false };
  }
  if (info.isDirectory()) return { kind: "directory", size: null, lines: null, isBinary: false };
  if (info.isSymbolicLink()) return { kind: "symlink", size: info.size, lines: 1, isBinary: false };
  if (!info.isFile()) return { kind: "other", size: info.size, lines: null, isBinary: false };
  if (info.size > maxBytes) return { kind: "file", size: info.size, lines: null, isBinary: false };
  const bytes = await Bun.file(target).bytes();
  if (looksBinary(bytes)) return { kind: "file", size: bytes.length, lines: null, isBinary: true };
  return {
    kind: "file",
    size: bytes.length,
    lines: countLines(Buffer.from(bytes).toString("utf8")),
    isBinary: false,
  };
}

/** `lstat` kind of a repo path (used to avoid diffing directories and oversized files). */
export async function statWorktreePath(
  root: string,
  repoPath: string,
): Promise<{ kind: "file" | "symlink" | "directory" | "missing" | "other"; size: number }> {
  const target = await locate(root, repoPath);
  if (!target) return { kind: "missing", size: 0 };
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) return { kind: "symlink", size: info.size };
    if (info.isDirectory()) return { kind: "directory", size: 0 };
    if (info.isFile()) return { kind: "file", size: info.size };
    return { kind: "other", size: info.size };
  } catch {
    return { kind: "missing", size: 0 };
  }
}
