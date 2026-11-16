/**
 * Lucy's own undo trash: deleted entries are moved here instead of being unlinked, so a
 * delete can be undone. Lives under Lucy's state directory (the path is injected).
 *
 * Layout: `<dir>/<id>/meta.json` and `<dir>/<id>/payload` (the entry itself, whatever its
 * kind). A symlink is moved as a link: its target is never touched.
 */
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fromFsError, LucyError } from "@/core/errors";
import { log } from "@/core/log";

const logger = log.child("fs:trash");

export type TrashedKind = "file" | "directory" | "symlink";

export interface TrashItem {
  readonly id: string;
  /** Workspace-relative path the entry was deleted from. */
  readonly originalPath: string;
  /** Absolute workspace root at deletion time. */
  readonly root: string;
  readonly deletedAt: number;
  readonly kind: TrashedKind;
}

export interface PruneOptions {
  /** Remove items deleted more than this many days ago. */
  maxAgeDays?: number;
  /** Then remove the oldest items until the trash holds at most this many bytes. */
  maxBytes?: number;
}

export interface PruneResult {
  readonly removed: number;
  readonly freedBytes: number;
}

export type RenameFn = (from: string, to: string) => Promise<void>;

export interface UndoTrashOptions {
  dir: string;
  /** Largest entry moved by copy-then-remove when the trash is on another device. Default 1 GiB. */
  maxCrossDeviceBytes?: number;
  /** Replaces `fs.rename` (tests simulate EXDEV with it). */
  rename?: RenameFn;
}

const META = "meta.json";
const PAYLOAD = "payload";
const ID_PATTERN = /^[0-9a-z]+-[0-9a-f]{8}$/;

/** Total size of an entry without following symlinks. Stops early (returns > limit) once over `limit`. */
export async function measureSize(abs: string, limit = Number.POSITIVE_INFINITY): Promise<number> {
  let total = 0;
  const stack = [abs];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch {
      continue;
    }
    total += Number(info.size);
    if (total > limit) return total;
    if (info.isDirectory()) {
      for (const name of await readdir(current)) stack.push(join(current, name));
    }
  }
  return total;
}

export class UndoTrash {
  readonly dir: string;
  private readonly maxCrossDeviceBytes: number;
  private readonly renameFn: RenameFn;

  constructor(options: UndoTrashOptions) {
    this.dir = options.dir;
    this.maxCrossDeviceBytes = options.maxCrossDeviceBytes ?? 1024 * 1024 * 1024;
    this.renameFn = options.rename ?? rename;
  }

  /** Moves `abs` into the trash. `abs` must already be validated by the caller. */
  async put(abs: string, info: { originalPath: string; root: string }): Promise<TrashItem> {
    const entry = await lstat(abs).catch((error: unknown) => {
      throw fromFsError(error, info.originalPath);
    });
    const kind: TrashedKind = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file";
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const itemDir = join(this.dir, id);
    await mkdir(itemDir, { mode: 0o700 });
    const item: TrashItem = {
      id,
      originalPath: info.originalPath,
      root: info.root,
      deletedAt: Date.now(),
      kind,
    };
    try {
      await writeFile(join(itemDir, META), JSON.stringify({ version: 1, ...item }), { mode: 0o600 });
      await this.move(abs, join(itemDir, PAYLOAD), info.originalPath);
    } catch (error) {
      await rm(itemDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return item;
  }

  /** Moves a trashed entry back to `destAbs` (which the caller checked is free). */
  async restore(id: string, destAbs: string, displayPath: string): Promise<void> {
    const payload = join(this.itemDir(id), PAYLOAD);
    try {
      await lstat(payload);
    } catch {
      throw new LucyError("NOT_FOUND", `The deleted copy of "${displayPath}" is no longer in Lucy's trash`);
    }
    await this.move(payload, destAbs, displayPath);
    await rm(this.itemDir(id), { recursive: true, force: true }).catch(() => {});
  }

  async discard(id: string): Promise<void> {
    await rm(this.itemDir(id), { recursive: true, force: true });
  }

  async list(): Promise<TrashItem[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const items: TrashItem[] = [];
    for (const name of names) {
      if (!ID_PATTERN.test(name)) continue;
      items.push(await this.readItem(name));
    }
    return items.sort((a, b) => a.deletedAt - b.deletedAt);
  }

  async prune(options: PruneOptions & { keep?: ReadonlySet<string>; now?: number }): Promise<PruneResult> {
    const now = options.now ?? Date.now();
    const keep = options.keep ?? new Set<string>();
    let removed = 0;
    let freedBytes = 0;
    const survivors: { item: TrashItem; size: number }[] = [];
    for (const item of await this.list()) {
      if (keep.has(item.id)) continue;
      const size = await measureSize(this.itemDir(item.id));
      if (options.maxAgeDays !== undefined && now - item.deletedAt > options.maxAgeDays * 86_400_000) {
        await this.discard(item.id);
        removed++;
        freedBytes += size;
      } else {
        survivors.push({ item, size });
      }
    }
    if (options.maxBytes !== undefined) {
      let total = survivors.reduce((sum, entry) => sum + entry.size, 0);
      for (const entry of survivors) {
        if (total <= options.maxBytes) break;
        await this.discard(entry.item.id);
        removed++;
        freedBytes += entry.size;
        total -= entry.size;
      }
    }
    return { removed, freedBytes };
  }

  private itemDir(id: string): string {
    if (!ID_PATTERN.test(id)) throw new LucyError("INVALID_ARGUMENT", "Invalid trash item id");
    return join(this.dir, id);
  }

  private async readItem(id: string): Promise<TrashItem> {
    try {
      const raw: unknown = JSON.parse(await readFile(join(this.dir, id, META), "utf8"));
      if (raw && typeof raw === "object") {
        const meta = raw as Record<string, unknown>;
        if (typeof meta.originalPath === "string" && typeof meta.deletedAt === "number") {
          return {
            id,
            originalPath: meta.originalPath,
            root: typeof meta.root === "string" ? meta.root : "",
            deletedAt: meta.deletedAt,
            kind: meta.kind === "directory" || meta.kind === "symlink" ? meta.kind : "file",
          };
        }
      }
    } catch {
      // Damaged or half-written item: fall back to the directory's own timestamp.
    }
    const info = await stat(join(this.dir, id)).catch(() => null);
    return { id, originalPath: "", root: "", deletedAt: info?.mtimeMs ?? 0, kind: "file" };
  }

  /** `rename`, or copy-then-remove across devices (bounded by `maxCrossDeviceBytes`). */
  private async move(from: string, to: string, displayPath: string): Promise<void> {
    try {
      await this.renameFn(from, to);
      return;
    } catch (error) {
      if ((error as { code?: string } | null)?.code !== "EXDEV") throw fromFsError(error, displayPath);
    }
    const size = await measureSize(from, this.maxCrossDeviceBytes);
    if (size > this.maxCrossDeviceBytes) {
      throw new LucyError(
        "TOO_LARGE",
        `"${displayPath}" is too large to move to Lucy's trash on another disk; delete it permanently instead`,
        { details: { size, limit: this.maxCrossDeviceBytes } },
      );
    }
    try {
      await cp(from, to, {
        recursive: true,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
    } catch (error) {
      await rm(to, { recursive: true, force: true }).catch(() => {});
      throw fromFsError(error, displayPath);
    }
    try {
      await rm(from, { recursive: true });
    } catch (error) {
      // The copy is complete; a partial removal leaves the original partly in place, which
      // is safer than losing the copy. Report it.
      logger.warn("cross-device move left the source behind", { error });
      throw fromFsError(error, displayPath);
    }
  }
}
