/**
 * Reload decisions for a read-only viewer.
 *
 * The viewer never holds unsaved changes, so any change on disk is simply reloaded; there is
 * no "file changed, keep yours?" conflict. Size plus mtime is the stamp: a rewrite that keeps
 * both identical is practically impossible with nanosecond mtimes (APFS, ext4), and on coarse
 * filesystems the watcher still fires and a reload of identical content is harmless.
 */
import { stat } from "node:fs/promises";
import { joinRelative } from "@/adapters/filesystem/workspace-path";
import type { FileStamp } from "./document-types";

export type ReloadDecision = "unchanged" | "reload" | "deleted";

/**
 * A fresh observation of the file: its stamp, `null` when it does not exist, or `"unreadable"`
 * when stat failed for another reason (permissions changed, IO error).
 */
export type FileObservation = FileStamp | null | "unreadable";

/**
 * `current`: the stamp of what the tab shows, or `null` when it shows a failure state.
 * An unreadable file is a reload, so the loader can explain the new failure.
 */
export function decideReload(current: FileStamp | null, next: FileObservation): ReloadDecision {
  if (next === "unreadable") return "reload";
  if (next === null) return current === null ? "unchanged" : "deleted";
  if (current === null) return "reload";
  return current.size === next.size && current.mtimeMs === next.mtimeMs ? "unchanged" : "reload";
}

/**
 * Observes a workspace-relative path that the loader has already validated (following
 * symlinks, as the loader does).
 */
export async function observeFile(root: string, path: string): Promise<FileObservation> {
  try {
    const info = await stat(joinRelative(root, path));
    if (!info.isFile()) return "unreadable";
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? null : "unreadable";
  }
}
