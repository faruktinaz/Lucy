/**
 * One directory listing for the explorer: entry kinds, symlink classification, sorting.
 *
 * Never follows symlinked directories (that is the tree's decision); only `stat`s a symlink
 * to learn what it points at. Work is sliced so a 50k-entry directory never blocks the UI.
 */
import type { Dirent } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { isWithin } from "@/core/paths";
import { forEachConcurrent, sortAsync, TimeSlicer } from "./async-util";
import { compareEntries, type NameComparator } from "./natural-sort";

export type EntryKind = "file" | "directory";

/** Where a symlink points: inside the workspace, outside it, or nowhere (broken or a loop). */
export type SymlinkTarget = "inside" | "outside" | "broken";

export interface RawEntry {
  /** Raw name as returned by the OS: never normalized, may contain control characters. */
  readonly name: string;
  /** For symlinks, the kind of the target ("file" when broken). */
  readonly kind: EntryKind;
  readonly isSymlink: boolean;
  readonly symlinkTarget: SymlinkTarget | null;
}

export interface ListDirectoryOptions {
  /** Real path of the workspace root, for classifying symlink targets. */
  realRoot: string;
  compare: NameComparator;
  signal?: AbortSignal;
}

const STAT_CONCURRENCY = 32;

async function classifySymlink(
  abs: string,
  realRoot: string,
): Promise<{ kind: EntryKind; target: SymlinkTarget }> {
  try {
    const info = await stat(abs);
    const real = await realpath(abs);
    return {
      kind: info.isDirectory() ? "directory" : "file",
      target: isWithin(realRoot, real) ? "inside" : "outside",
    };
  } catch {
    // ENOENT (dangling) or ELOOP (cycle): either way the link leads nowhere usable.
    return { kind: "file", target: "broken" };
  }
}

export async function listDirectory(absDir: string, options: ListDirectoryOptions): Promise<RawEntry[]> {
  const dirents: Dirent[] = await readdir(absDir, { withFileTypes: true });
  const slicer = new TimeSlicer(8, options.signal);
  const entries: RawEntry[] = new Array(dirents.length);
  const needsStat: number[] = [];
  for (let i = 0; i < dirents.length; i++) {
    const dirent = dirents[i] as Dirent;
    const name = String(dirent.name);
    if (dirent.isSymbolicLink()) {
      needsStat.push(i);
      entries[i] = { name, kind: "file", isSymlink: true, symlinkTarget: "broken" };
    } else if (dirent.isDirectory()) {
      entries[i] = { name, kind: "directory", isSymlink: false, symlinkTarget: null };
    } else if (dirent.isFile()) {
      entries[i] = { name, kind: "file", isSymlink: false, symlinkTarget: null };
    } else {
      // FIFOs, sockets, devices, and DT_UNKNOWN on some filesystems: decide via stat.
      needsStat.push(i);
      entries[i] = { name, kind: "file", isSymlink: false, symlinkTarget: null };
    }
    if ((i & 1023) === 1023) await slicer.maybeYield();
  }
  await forEachConcurrent(
    needsStat,
    STAT_CONCURRENCY,
    async (index) => {
      const entry = entries[index] as RawEntry;
      const abs = join(absDir, entry.name);
      if (entry.isSymlink) {
        const { kind, target } = await classifySymlink(abs, options.realRoot);
        entries[index] = { ...entry, kind, symlinkTarget: target };
        return;
      }
      try {
        const info = await lstat(abs);
        if (info.isSymbolicLink()) {
          const { kind, target } = await classifySymlink(abs, options.realRoot);
          entries[index] = { ...entry, kind, isSymlink: true, symlinkTarget: target };
        } else if (info.isDirectory()) {
          entries[index] = { ...entry, kind: "directory" };
        }
      } catch {
        // Vanished between readdir and stat: keep it as a file; the next refresh drops it.
      }
    },
    options.signal,
  );
  return sortAsync(entries, (a, b) => compareEntries(options.compare, a, b), { signal: options.signal });
}
