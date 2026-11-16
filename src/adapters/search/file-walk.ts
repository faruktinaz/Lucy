/**
 * Bounded asynchronous directory walk: the last-resort file lister when neither Git nor
 * ripgrep can be used. Never follows symlinked directories (a symlink to a regular file is
 * listed), skips always-excluded names, and stops at the file, depth and time limits
 * (reporting `truncated`). Unreadable directories are skipped.
 */
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { cancelledError, TimeSlicer } from "@/adapters/filesystem/async-util";

export interface WalkOptions {
  maxFiles: number;
  maxDepth: number;
  timeBudgetMs: number;
  /** Entry names skipped wherever they appear (files and folders). */
  excludeNames: ReadonlySet<string>;
  signal?: AbortSignal;
  /** Parallel `readdir` calls. Default 8. */
  concurrency?: number;
}

export interface WalkResult {
  readonly files: string[];
  readonly truncated: boolean;
}

export const DEFAULT_WALK_EXCLUDES: readonly string[] = [".git", ".hg", ".svn", "node_modules", ".DS_Store"];

export async function walkFiles(root: string, options: WalkOptions): Promise<WalkResult> {
  const files: string[] = [];
  const queue: { rel: string; depth: number }[] = [{ rel: "", depth: 0 }];
  const deadline = performance.now() + options.timeBudgetMs;
  const slicer = new TimeSlicer(8, options.signal);
  const concurrency = Math.max(1, options.concurrency ?? 8);
  let truncated = false;
  let stop = false;

  const visit = async (rel: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(rel === "" ? root : join(root, rel), { withFileTypes: true });
    } catch {
      return; // Permission denied or vanished: skip, like `find` would.
    }
    for (let i = 0; i < entries.length && !stop; i++) {
      if ((i & 1023) === 1023) await slicer.maybeYield();
      const entry = entries[i] as Dirent;
      const name = String(entry.name);
      if (options.excludeNames.has(name)) continue;
      const path = rel === "" ? name : `${rel}/${name}`;
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        isFile = await stat(join(root, path)).then(
          (info) => info.isFile(),
          () => false,
        );
      } else if (entry.isDirectory()) {
        if (depth + 1 > options.maxDepth) truncated = true;
        else queue.push({ rel: path, depth: depth + 1 });
        continue;
      }
      if (!isFile) continue;
      if (files.length >= options.maxFiles) {
        truncated = true;
        stop = true;
        return;
      }
      files.push(path);
    }
    if (performance.now() > deadline) {
      truncated = true;
      stop = true;
    }
  };

  await new Promise<void>((resolve, reject) => {
    let active = 0;
    let failed = false;
    const pump = (): void => {
      if (failed) return;
      if (options.signal?.aborted) {
        failed = true;
        reject(cancelledError());
        return;
      }
      while (!stop && active < concurrency && queue.length > 0) {
        const next = queue.shift() as { rel: string; depth: number };
        active++;
        visit(next.rel, next.depth).then(
          () => {
            active--;
            pump();
          },
          (error: unknown) => {
            failed = true;
            reject(error);
          },
        );
      }
      if (active === 0 && (stop || queue.length === 0)) resolve();
    };
    pump();
  });
  if (stop && queue.length > 0) truncated = true;
  return { files, truncated };
}
