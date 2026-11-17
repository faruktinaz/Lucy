/**
 * Finds Git repositories below a folder (for a workspace such as ~/Documents that holds several
 * projects). Plain filesystem reads, no Git process.
 *
 * Rules, all deliberate:
 * - Breadth first, down to `depth` folder levels below the root; shallower repositories first.
 * - A folder is a repository when it contains `.git` (a directory, or a file for linked
 *   worktrees and submodules). The search does not descend into a repository: its nested
 *   repositories are its own business (submodules show up in its status).
 * - Symbolic links are never followed (no cycles, no escaping the workspace).
 * - Hidden folders and well-known heavy or generated folders are skipped.
 * - At most `maxRepositories` repositories and `maxDirectories` folders: a huge tree must not
 *   delay the first useful screen. The result says when a limit was hit.
 * - Cancellable through `signal` (a newer scan replaces an older one).
 */
import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { LucyError } from "@/core/errors";

export const DEFAULT_MAX_REPOSITORIES = 32;
export const DEFAULT_MAX_SCANNED_DIRECTORIES = 10_000;

/** Folder names that never contain a project worth showing, or are too big to walk. */
export const SKIPPED_FOLDERS: ReadonlySet<string> = new Set([
  "node_modules",
  "bower_components",
  "jspm_packages",
  "vendor",
  "Pods",
  "Carthage",
  "DerivedData",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "venv",
  "__pycache__",
  "site-packages",
]);

export interface RepositoryScanOptions {
  /** Folder levels below the root to search (1 = direct children). 0 finds nothing. */
  depth: number;
  maxRepositories?: number;
  maxDirectories?: number;
  signal?: AbortSignal;
}

export interface RepositoryScanResult {
  /** Absolute repository roots, sorted by path. Never includes the root itself. */
  readonly roots: readonly string[];
  /** A limit stopped the search early; more repositories may exist. */
  readonly truncated: boolean;
  readonly limitedBy?: "repositories" | "directories";
  readonly directoriesVisited: number;
}

async function hasGitEntry(dir: string): Promise<boolean> {
  try {
    const info = await lstat(join(dir, ".git"));
    return info.isDirectory() || info.isFile();
  } catch {
    return false;
  }
}

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new LucyError("CANCELLED", "The repository scan was cancelled.");
}

export async function scanForRepositories(
  root: string,
  options: RepositoryScanOptions,
): Promise<RepositoryScanResult> {
  const maxRepositories = options.maxRepositories ?? DEFAULT_MAX_REPOSITORIES;
  const maxDirectories = options.maxDirectories ?? DEFAULT_MAX_SCANNED_DIRECTORIES;
  const roots: string[] = [];
  let visited = 0;
  let limitedBy: RepositoryScanResult["limitedBy"];
  if (options.depth <= 0) return { roots, truncated: false, directoriesVisited: 0 };

  let level: string[] = [root];
  outer: for (let depth = 1; depth <= options.depth && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      checkCancelled(options.signal);
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue; // Unreadable folders (permissions, races) are simply not searched.
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        // `isDirectory()` is false for a symlink to a directory: links are never followed.
        if (!entry.isDirectory() || entry.name.startsWith(".") || SKIPPED_FOLDERS.has(entry.name)) continue;
        if (visited >= maxDirectories) {
          limitedBy = "directories";
          break outer;
        }
        visited++;
        const child = join(dir, entry.name);
        if (await hasGitEntry(child)) {
          roots.push(child);
          if (roots.length >= maxRepositories) {
            limitedBy = "repositories";
            break outer;
          }
        } else if (depth < options.depth) {
          next.push(child);
        }
      }
    }
    level = next;
  }
  checkCancelled(options.signal);
  roots.sort();
  return {
    roots,
    truncated: limitedBy !== undefined,
    directoriesVisited: visited,
    ...(limitedBy ? { limitedBy } : {}),
  };
}
