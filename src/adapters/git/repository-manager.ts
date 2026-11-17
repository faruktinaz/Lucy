/**
 * The Git repositories of a workspace: the one that contains the workspace root (the primary
 * `GitService`, which existed before multi-repository support) plus the repositories found
 * below the workspace by `scanForRepositories`, one `GitService` each.
 *
 * Kept cheap on purpose: the scan runs once after first paint (and again on refresh or when a
 * watcher batch touches a folder outside every known repository), new services are refreshed
 * one after another with a small gap instead of all at once, and a watcher batch only
 * refreshes the repositories its paths belong to.
 */
import { join, sep } from "node:path";
import { isLucyError } from "@/core/errors";
import type { Disposable } from "@/core/events";
import { isWithin } from "@/core/paths";
import { Store } from "@/core/store";
import { fromAbsolutePath } from "./paths";
import { DEFAULT_MAX_REPOSITORIES, scanForRepositories } from "./repository-scan";
import type { GitService } from "./service";

export interface RepositoryEntry {
  /** Absolute folder the service was opened on (the scanned folder, or the workspace root). */
  readonly root: string;
  readonly service: GitService;
  /** The workspace's own service (`DomainServices.git`). */
  readonly primary: boolean;
}

export interface RepositoryManagerState {
  /** The primary entry first, then scanned repositories by path. */
  readonly entries: readonly RepositoryEntry[];
  readonly scanning: boolean;
  /** The scan stopped at a limit; more repositories may exist below the workspace. */
  readonly truncated: boolean;
  readonly maxRepositories: number;
}

export interface RepositoryManagerOptions {
  workspaceRoot: string;
  primary: GitService;
  createService: (root: string) => GitService;
  /** Read on every scan, so a settings change applies on the next refresh. */
  depth: () => number;
  maxRepositories?: number;
  /** Gap between the first refreshes of newly found repositories. Default 120 ms. */
  staggerMs?: number;
  /** Debounce for rescans triggered by file events. Default 2 s. */
  rescanDelayMs?: number;
}

export class GitRepositoryManager implements Disposable {
  readonly store: Store<RepositoryManagerState>;
  private scanAbort: AbortController | null = null;
  private rescanTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;
  private readonly maxRepositories: number;

  constructor(private readonly options: RepositoryManagerOptions) {
    this.maxRepositories = options.maxRepositories ?? DEFAULT_MAX_REPOSITORIES;
    this.store = new Store<RepositoryManagerState>({
      entries: [{ root: options.workspaceRoot, service: options.primary, primary: true }],
      scanning: false,
      truncated: false,
      maxRepositories: this.maxRepositories,
    });
  }

  get state(): RepositoryManagerState {
    return this.store.get();
  }

  get entries(): readonly RepositoryEntry[] {
    return this.store.get().entries;
  }

  /** Entries that are usable repositories right now (the primary only when it found one). */
  get repositories(): readonly RepositoryEntry[] {
    return this.entries.filter((entry) => entry.service.state.repo !== null);
  }

  /** Searches below the workspace again; cancels a scan in progress. Never rejects. */
  async scan(): Promise<void> {
    if (this.disposed) return;
    this.scanAbort?.abort();
    const abort = new AbortController();
    this.scanAbort = abort;
    this.store.update({ scanning: true });
    try {
      const result = await scanForRepositories(this.options.workspaceRoot, {
        depth: this.options.depth(),
        maxRepositories: this.maxRepositories,
        signal: abort.signal,
      });
      if (abort.signal.aborted || this.disposed) return;
      this.apply(result.roots, result.truncated);
    } catch (error) {
      if (!isLucyError(error, "CANCELLED")) this.store.update({ scanning: false });
      return;
    } finally {
      if (this.scanAbort === abort) {
        this.scanAbort = null;
        if (!this.disposed) this.store.update({ scanning: false });
      }
    }
  }

  private apply(roots: readonly string[], truncated: boolean): void {
    const current = this.entries;
    const primary = current[0] as RepositoryEntry;
    const primaryRoot = primary.service.state.repo?.root;
    const kept = new Map(current.filter((entry) => !entry.primary).map((entry) => [entry.root, entry]));
    const next: RepositoryEntry[] = [primary];
    const added: RepositoryEntry[] = [];
    for (const root of roots) {
      // The workspace's own repository is already the primary entry.
      if (primaryRoot && (root === primaryRoot || root === this.options.workspaceRoot)) continue;
      const existing = kept.get(root);
      if (existing) {
        next.push(existing);
        kept.delete(root);
        continue;
      }
      const entry: RepositoryEntry = { root, service: this.options.createService(root), primary: false };
      next.push(entry);
      added.push(entry);
    }
    for (const gone of kept.values()) gone.service.dispose();
    this.store.update({ entries: next, truncated });
    this.staggerRefresh(added.map((entry) => entry.service));
  }

  private staggerRefresh(services: readonly GitService[]): void {
    const gap = this.options.staggerMs ?? 120;
    services.forEach((service, index) => {
      if (index === 0) {
        void service.refresh();
        return;
      }
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (!this.disposed) void service.refresh();
      }, index * gap);
      timer.unref?.();
      this.timers.add(timer);
    });
  }

  /** Refreshes every repository (staggered) and rescans for new or removed ones. */
  async refreshAll(): Promise<void> {
    await this.options.primary.refresh();
    await this.scan();
    this.staggerRefresh(this.entries.filter((entry) => !entry.primary).map((entry) => entry.service));
  }

  /** The deepest repository containing an absolute path. */
  entryForPath(absolutePath: string): RepositoryEntry | undefined {
    let best: RepositoryEntry | undefined;
    let bestLength = -1;
    for (const entry of this.entries) {
      const repo = entry.service.state.repo;
      if (!repo) continue;
      const inside =
        isWithin(entry.root, absolutePath) ||
        (fromAbsolutePath(repo, absolutePath) !== null && entry.primary);
      if (!inside) continue;
      const length = entry.primary ? 0 : entry.root.length;
      if (length > bestLength) {
        best = entry;
        bestLength = length;
      }
    }
    return best;
  }

  /**
   * Routes a watcher batch (workspace-relative paths) to the repositories it touches. Paths
   * outside every scanned repository go to the primary service (as before); when such a path
   * could be a new repository below the workspace, a rescan is scheduled.
   */
  routeBatch(
    paths: readonly string[],
    options: { overflow?: boolean; primaryMetaChanged?: boolean } = {},
  ): void {
    if (this.disposed) return;
    if (options.primaryMetaChanged) this.options.primary.scheduleRefresh();
    if (options.overflow) {
      for (const entry of this.entries) entry.service.scheduleRefresh();
      this.scheduleRescan();
      return;
    }
    const touched = new Set<GitService>();
    let outside = false;
    for (const path of paths) {
      const absolute = join(this.options.workspaceRoot, ...path.split("/"));
      const entry = this.entries.find(
        (candidate) => !candidate.primary && isWithin(candidate.root, absolute),
      );
      if (entry) touched.add(entry.service);
      else {
        touched.add(this.options.primary);
        outside = true;
      }
    }
    for (const service of touched) service.scheduleRefresh();
    if (outside && this.options.depth() > 0) this.scheduleRescan();
  }

  private scheduleRescan(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      void this.scan();
    }, this.options.rescanDelayMs ?? 2000);
    this.rescanTimer.unref?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scanAbort?.abort();
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const entry of this.entries) if (!entry.primary) entry.service.dispose();
  }
}

/** Path separator-safe display path of a repository root relative to the workspace. */
export function repositoryLabelPath(workspaceRoot: string, root: string): string {
  if (root === workspaceRoot) return "";
  const prefix = workspaceRoot.endsWith(sep) ? workspaceRoot : workspaceRoot + sep;
  const rel = root.startsWith(prefix) ? root.slice(prefix.length) : root;
  return sep === "/" ? rel : rel.split(sep).join("/");
}
