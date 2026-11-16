/**
 * Safe, undoable mutations of the workspace.
 *
 * Every path is validated (`normalizeWorkspacePath`) and resolved through the real parent
 * directory (`realpathWithin`), so `../x`, absolute paths and symlinked parents pointing
 * outside fail with `OUTSIDE_WORKSPACE`. Nothing is ever overwritten. Deletes go to Lucy's
 * undo trash. Operations run one at a time so the undo journal always matches the disk.
 *
 * The journal is in memory (one per session); trashed entries survive on disk until
 * `pruneTrash`.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fromFsError, isLucyError, LucyError } from "@/core/errors";
import { isWithin, realpathWithin, toRelativePosix } from "@/core/paths";
import { sanitizeForDisplay } from "@/core/text";
import {
  type PruneOptions,
  type PruneResult,
  type RenameFn,
  type TrashedKind,
  UndoTrash,
} from "./undo-trash";
import { nameOf, normalizeWorkspacePath, resolveEntryPath, resolveTargetPath } from "./workspace-path";

export interface FileOpsOptions {
  /** Absolute workspace root. */
  root: string;
  /** Lucy's undo-trash directory (under the state dir), outside the workspace. */
  trashDir: string;
  /** See `UndoTrashOptions.maxCrossDeviceBytes`. */
  maxCrossDeviceBytes?: number;
  /** Undo journal length. Default 100. */
  maxUndoEntries?: number;
  /** Replaces `fs.rename` for trash moves (tests). */
  trashRename?: RenameFn;
}

type JournalEntry =
  | {
      kind: "create";
      path: string;
      entryKind: "file" | "directory";
      /** Parent folders this operation created, outermost first. */
      createdDirs: string[];
      ino: number;
      mtimeMs: number;
      size: number;
    }
  | { kind: "rename"; from: string; to: string; createdDirs: string[] }
  | { kind: "delete"; path: string; trashId: string; entryKind: TrashedKind };

export interface UndoResult {
  /** What was undone, for a toast ("Restored deleted file “a.ts”"). */
  readonly description: string;
  /** Workspace-relative paths whose parents should be refreshed. */
  readonly changedPaths: readonly string[];
}

function quote(path: string): string {
  return `“${sanitizeForDisplay(path)}”`;
}

function describe(entry: JournalEntry): string {
  switch (entry.kind) {
    case "create":
      return `Remove the ${entry.entryKind === "directory" ? "folder" : "file"} ${quote(entry.path)} created just now`;
    case "rename":
      return `Rename ${quote(entry.to)} back to ${quote(entry.from)}`;
    case "delete": {
      const noun =
        entry.entryKind === "directory" ? "folder" : entry.entryKind === "symlink" ? "link" : "file";
      return `Restore the deleted ${noun} ${quote(entry.path)}`;
    }
  }
}

function isCaseVariant(a: string, b: string): boolean {
  return a !== b && a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();
}

async function exists(abs: string): Promise<boolean> {
  try {
    await lstat(abs);
    return true;
  } catch {
    return false;
  }
}

export class FileOps {
  readonly root: string;
  private readonly trash: UndoTrash;
  private readonly maxUndoEntries: number;
  private journal: JournalEntry[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private realRootCache: string | null = null;

  constructor(options: FileOpsOptions) {
    this.root = resolve(options.root);
    const trashDir = resolve(options.trashDir);
    if (isWithin(this.root, trashDir)) {
      throw new LucyError("INVALID_ARGUMENT", "The undo trash must live outside the workspace");
    }
    this.trash = new UndoTrash({
      dir: trashDir,
      maxCrossDeviceBytes: options.maxCrossDeviceBytes,
      rename: options.trashRename,
    });
    this.maxUndoEntries = Math.max(1, options.maxUndoEntries ?? 100);
  }

  get canUndo(): boolean {
    return this.journal.length > 0;
  }

  /** What `undo()` would do, as a short sentence, or `null` when there is nothing to undo. */
  describeUndo(): string | null {
    const last = this.journal[this.journal.length - 1];
    return last ? describe(last) : null;
  }

  /** Creates an empty (or `contents`) file; missing parent folders are created. Returns the normalized path. */
  createFile(path: string, contents: string | Uint8Array = ""): Promise<string> {
    return this.exclusive(async () => {
      const rel = normalizeWorkspacePath(this.root, path, "new");
      const target = await resolveTargetPath(this.root, rel);
      const createdDirs = await this.ensureParents(target, rel);
      try {
        // "wx" = O_CREAT|O_EXCL: fails on any existing entry, including a dangling symlink,
        // and never follows a symlink planted at the target.
        await writeFile(target, contents, { flag: "wx" });
      } catch (error) {
        await this.removeEmptyDirs(createdDirs);
        throw fromFsError(error, rel);
      }
      const info = await lstat(target);
      this.record({
        kind: "create",
        path: rel,
        entryKind: "file",
        createdDirs,
        ino: info.ino,
        mtimeMs: info.mtimeMs,
        size: info.size,
      });
      return rel;
    });
  }

  /** Creates a folder (and missing parents). Returns the normalized path. */
  createDirectory(path: string): Promise<string> {
    return this.exclusive(async () => {
      const rel = normalizeWorkspacePath(this.root, path, "new");
      const target = await resolveTargetPath(this.root, rel);
      const createdDirs = await this.ensureParents(target, rel);
      try {
        await mkdir(target);
      } catch (error) {
        await this.removeEmptyDirs(createdDirs);
        throw fromFsError(error, rel);
      }
      const info = await lstat(target);
      this.record({
        kind: "create",
        path: rel,
        entryKind: "directory",
        createdDirs,
        ino: info.ino,
        mtimeMs: info.mtimeMs,
        size: info.size,
      });
      return rel;
    });
  }

  /**
   * Renames or moves an entry. Never overwrites (`ALREADY_EXISTS`), except that a case-only
   * (or Unicode-normalization-only) rename of the same entry works on case-insensitive
   * filesystems. Missing parent folders of the destination are created. A symlink is
   * renamed as a link. Returns the normalized destination.
   */
  rename(from: string, to: string): Promise<string> {
    return this.exclusive(async () => {
      const fromRel = normalizeWorkspacePath(this.root, from, "existing");
      const toRel = normalizeWorkspacePath(this.root, to, "new");
      if (fromRel === toRel) return toRel;
      if (toRel.startsWith(`${fromRel}/`)) {
        throw new LucyError("INVALID_ARGUMENT", "A folder cannot be moved into itself");
      }
      const fromAbs = await resolveEntryPath(this.root, fromRel);
      if (!(await exists(fromAbs))) throw new LucyError("NOT_FOUND", `Not found: ${fromRel}`);
      const toAbs = await resolveEntryPath(this.root, toRel);
      const caseOnly = await this.isSameEntryRename(fromAbs, toAbs);
      if (!caseOnly && (await exists(toAbs))) {
        throw new LucyError("ALREADY_EXISTS", `Already exists: ${toRel}`);
      }
      const createdDirs = caseOnly ? [] : await this.ensureParents(toAbs, toRel);
      try {
        await this.moveEntry(fromAbs, toAbs, caseOnly);
      } catch (error) {
        await this.removeEmptyDirs(createdDirs);
        throw isLucyError(error) ? error : fromFsError(error, fromRel);
      }
      this.record({ kind: "rename", from: fromRel, to: toRel, createdDirs });
      return toRel;
    });
  }

  /**
   * Moves an entry to Lucy's undo trash (or, with `permanent`, removes it for good; that is
   * not undoable). A symlink is removed as a link; its target is never touched.
   */
  delete(path: string, options: { permanent?: boolean } = {}): Promise<void> {
    return this.exclusive(async () => {
      const rel = normalizeWorkspacePath(this.root, path, "existing");
      const abs = await resolveEntryPath(this.root, rel);
      if (!(await exists(abs))) throw new LucyError("NOT_FOUND", `Not found: ${rel}`);
      if (options.permanent) {
        await rm(abs, { recursive: true }).catch((error: unknown) => {
          throw fromFsError(error, rel);
        });
        return;
      }
      const item = await this.trash.put(abs, { originalPath: rel, root: this.root });
      this.record({ kind: "delete", path: rel, trashId: item.id, entryKind: item.kind });
    });
  }

  /**
   * Reverts the most recent operation. Conservative by design: a created entry is removed
   * only if unchanged since creation; a rename or delete is reversed only if the original
   * path is free. When the original path is occupied the entry stays on the journal (the
   * user can move the blocker and retry); when undo became impossible it is dropped.
   */
  undo(): Promise<UndoResult> {
    return this.exclusive(async () => {
      const entry = this.journal[this.journal.length - 1];
      if (!entry) throw new LucyError("NOT_FOUND", "Nothing to undo");
      const description = describe(entry);
      try {
        const changedPaths = await this.revert(entry);
        this.journal.pop();
        return { description, changedPaths };
      } catch (error) {
        // Gone or modified: this step can never be undone, so let earlier steps through.
        // Anything else (occupied path, permissions) may be fixable: keep it for a retry.
        if (isLucyError(error, "NOT_FOUND") || isLucyError(error, "UNSUPPORTED")) this.journal.pop();
        throw error;
      }
    });
  }

  /** Forgets the undo history (trashed entries stay until pruned). */
  clearUndo(): void {
    this.journal = [];
  }

  /** Removes old trash items. Items still reachable through `undo()` are never pruned. */
  pruneTrash(options: PruneOptions): Promise<PruneResult> {
    return this.exclusive(() => {
      const keep = new Set<string>();
      for (const entry of this.journal) if (entry.kind === "delete") keep.add(entry.trashId);
      return this.trash.prune({ ...options, keep });
    });
  }

  // ---------------------------------------------------------------------------------------

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private record(entry: JournalEntry): void {
    this.journal.push(entry);
    if (this.journal.length > this.maxUndoEntries)
      this.journal.splice(0, this.journal.length - this.maxUndoEntries);
  }

  private async realRoot(): Promise<string> {
    this.realRootCache ??= await realpath(this.root);
    return this.realRootCache;
  }

  /**
   * Creates missing parent folders of `targetAbs` (already resolved inside the root) and
   * returns them workspace-relative, outermost first. Re-checks containment afterwards so a
   * symlink swapped in meanwhile cannot redirect the final write.
   */
  private async ensureParents(targetAbs: string, rel: string): Promise<string[]> {
    const parent = dirname(targetAbs);
    let first: string | undefined;
    try {
      first = await mkdir(parent, { recursive: true });
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === "EEXIST" || code === "ENOTDIR") {
        throw new LucyError("ALREADY_EXISTS", `A file is in the way of the folders for ${rel}`, {
          cause: error,
        });
      }
      throw fromFsError(error, rel);
    }
    const realRoot = await this.realRoot();
    const created: string[] = [];
    if (first) {
      for (let dir = parent; isWithin(first, dir); dir = dirname(dir)) {
        created.unshift(toRelativePosix(realRoot, dir));
        if (dir === first) break;
      }
    }
    const check = await realpathWithin(this.root, parent);
    if (check === null || check !== parent) {
      await this.removeEmptyDirs(created);
      throw new LucyError("OUTSIDE_WORKSPACE", "The path is outside the workspace", {
        details: { path: rel },
      });
    }
    return created;
  }

  /** Removes the given folders (deepest first) if they are still empty. */
  private async removeEmptyDirs(dirs: readonly string[]): Promise<void> {
    const realRoot = await this.realRoot();
    for (let i = dirs.length - 1; i >= 0; i--) {
      try {
        await rmdir(join(realRoot, ...(dirs[i] as string).split("/")));
      } catch {
        return; // Not empty (or gone): leave it and everything above it.
      }
    }
  }

  /**
   * True when `toAbs` names the same directory entry as `fromAbs` under a different case or
   * normalization (a case-insensitive filesystem). Hard links share an inode too, so the
   * directory listing must also not contain the destination name as a separate entry.
   */
  private async isSameEntryRename(fromAbs: string, toAbs: string): Promise<boolean> {
    if (dirname(fromAbs) !== dirname(toAbs) || !isCaseVariant(nameOf(fromAbs), nameOf(toAbs))) return false;
    try {
      const [a, b] = await Promise.all([lstat(fromAbs), lstat(toAbs)]);
      if (a.dev !== b.dev || a.ino !== b.ino) return false;
      const names = await readdir(dirname(fromAbs));
      return !names.includes(nameOf(toAbs));
    } catch {
      return false;
    }
  }

  private async moveEntry(fromAbs: string, toAbs: string, caseOnly: boolean): Promise<void> {
    if (!caseOnly) {
      await rename(fromAbs, toAbs);
      return;
    }
    // Some case-insensitive filesystems ignore a direct case-only rename; go through a
    // temporary name in the same folder.
    const temp = join(dirname(fromAbs), `.lucy-rename-${randomUUID().slice(0, 8)}`);
    await rename(fromAbs, temp);
    try {
      await rename(temp, toAbs);
    } catch (error) {
      await rename(temp, fromAbs).catch(() => {});
      throw error;
    }
  }

  private async revert(entry: JournalEntry): Promise<string[]> {
    switch (entry.kind) {
      case "create":
        return this.revertCreate(entry);
      case "rename":
        return this.revertRename(entry);
      case "delete":
        return this.revertDelete(entry);
    }
  }

  private async revertCreate(entry: Extract<JournalEntry, { kind: "create" }>): Promise<string[]> {
    const abs = await resolveEntryPath(this.root, entry.path);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(abs);
    } catch {
      throw new LucyError("NOT_FOUND", `${quote(entry.path)} no longer exists`);
    }
    if (entry.entryKind === "file") {
      if (
        !info.isFile() ||
        info.ino !== entry.ino ||
        info.size !== entry.size ||
        info.mtimeMs !== entry.mtimeMs
      ) {
        throw new LucyError(
          "UNSUPPORTED",
          `${quote(entry.path)} was changed after it was created; it was kept`,
          {
            details: { reason: "modified" },
          },
        );
      }
      await rm(abs).catch((error: unknown) => {
        throw fromFsError(error, entry.path);
      });
    } else {
      if (!info.isDirectory() || info.ino !== entry.ino) {
        throw new LucyError(
          "UNSUPPORTED",
          `${quote(entry.path)} was replaced after it was created; it was kept`,
          {
            details: { reason: "modified" },
          },
        );
      }
      try {
        await rmdir(abs);
      } catch (error) {
        const code = (error as { code?: string } | null)?.code;
        if (code === "ENOTEMPTY" || code === "EEXIST") {
          throw new LucyError("UNSUPPORTED", `${quote(entry.path)} is no longer empty; it was kept`, {
            details: { reason: "modified" },
          });
        }
        throw fromFsError(error, entry.path);
      }
    }
    await this.removeEmptyDirs(entry.createdDirs);
    return [entry.path, ...entry.createdDirs];
  }

  private async revertRename(entry: Extract<JournalEntry, { kind: "rename" }>): Promise<string[]> {
    const currentAbs = await resolveEntryPath(this.root, entry.to);
    if (!(await exists(currentAbs))) throw new LucyError("NOT_FOUND", `${quote(entry.to)} no longer exists`);
    const originalAbs = await resolveEntryPath(this.root, entry.from);
    const caseOnly = await this.isSameEntryRename(currentAbs, originalAbs);
    if (!caseOnly && (await exists(originalAbs))) {
      throw new LucyError(
        "ALREADY_EXISTS",
        `${quote(entry.from)} is taken by another item; nothing was renamed`,
      );
    }
    if (!caseOnly) await this.ensureParents(originalAbs, entry.from);
    await this.moveEntry(currentAbs, originalAbs, caseOnly).catch((error: unknown) => {
      throw fromFsError(error, entry.to);
    });
    await this.removeEmptyDirs(entry.createdDirs);
    return [entry.to, entry.from, ...entry.createdDirs];
  }

  private async revertDelete(entry: Extract<JournalEntry, { kind: "delete" }>): Promise<string[]> {
    const dest = await resolveEntryPath(this.root, entry.path);
    if (await exists(dest)) {
      throw new LucyError(
        "ALREADY_EXISTS",
        `${quote(entry.path)} exists again; the deleted copy was not restored`,
      );
    }
    const created = await this.ensureParents(dest, entry.path);
    try {
      await this.trash.restore(entry.trashId, dest, entry.path);
    } catch (error) {
      await this.removeEmptyDirs(created);
      throw error;
    }
    return [entry.path, ...created];
  }
}
