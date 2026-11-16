/**
 * Crash-safe file replacement: write a temp file in the same directory, flush it to disk,
 * then rename it over the target. Readers see either the old or the new file, never a torn
 * one. Shared by the config and workspace-state stores.
 *
 * If the target is a symlink (dotfile managers link `~/.config/lucy/config.toml` into a
 * repository) the link is followed and its destination is replaced, so the link survives.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fromFsError } from "../errors";

export interface AtomicWriteOptions {
  /**
   * File mode for a new file (for example 0o600 for private state). An existing file keeps
   * its mode unless `enforceMode` is set. Without it, a new file gets 0o666 minus the user's
   * umask, like any editor save.
   */
  mode?: number;
  /** Apply `mode` even when the file already exists (for files only Lucy writes, such as backups). */
  enforceMode?: boolean;
  /**
   * Mode for directories this call has to create (the parent and any missing ancestors).
   * Default 0o700, as the XDG Base Directory specification asks for. Existing directories are
   * never changed, so `~/.config` or a directory the user created keeps its permissions.
   */
  directoryMode?: number;
}

async function resolveTarget(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

export async function writeFileAtomic(
  path: string,
  data: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const target = await resolveTarget(path);
  const directory = dirname(target);
  let mode = options.mode;
  if (!(options.enforceMode && mode !== undefined)) {
    try {
      mode = (await stat(target)).mode & 0o777;
    } catch {
      // New file: use the requested mode, if any.
    }
  }
  const temp = join(directory, `.${basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await mkdir(directory, { recursive: true, mode: options.directoryMode ?? 0o700 });
    const handle = await open(temp, "wx", mode ?? 0o666);
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // `open` applies the umask; an explicit or inherited mode must survive it exactly.
    if (mode !== undefined) await chmod(temp, mode);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw fromFsError(error, target);
  }
}
