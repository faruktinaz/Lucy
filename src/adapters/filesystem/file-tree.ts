/**
 * The model behind the explorer: a lazily loaded directory tree flattened into rows for a
 * virtualized list.
 *
 * Design notes:
 * - Lazy: a directory is read only when it is effectively expanded (it and all ancestors
 *   are expanded). Collapsing keeps the loaded children, so re-expanding is instant;
 *   refreshes mark hidden directories dirty and re-read them on the next expand.
 * - Rows are an immutable array replaced on change. Expanding or collapsing splices only the
 *   affected subtree; other changes rebuild lazily on the next `getVisibleRows()`. Each
 *   directory renders at most `maxChildrenRendered` children followed by a "more" row.
 * - Node objects survive refreshes as long as the name and kind are unchanged, so expansion
 *   state and row keys (paths) are stable for selection.
 * - Symlinked directories are never entered automatically; expanding one explicitly is
 *   allowed, and a realpath check against the ancestors stops cycles.
 * - Ignore flags come from `git check-ignore` (one batch per directory read, cached per
 *   entry); children of an ignored directory inherit the flag without asking Git.
 */
import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fromFsError, isLucyError, LucyError } from "@/core/errors";
import { type Disposable, Emitter } from "@/core/events";
import { log } from "@/core/log";
import { forEachConcurrent, sortAsync, TimeSlicer } from "./async-util";
import { foldQuery, foldString } from "./case-fold";
import type {
  EntryKind,
  FileTreeFilterState,
  FileTreeViewOptions,
  SymlinkTarget,
  TreeEntry,
  TreeEntryError,
  TreeEntryRow,
  TreeRow,
} from "./file-tree-types";
import { GitIgnoreOracle } from "./git-ignore";
import type { GitEnv } from "./git-probe";
import { createGlobMatcher, type GlobMatcher } from "./glob-matcher";
import { listDirectory, type RawEntry } from "./list-directory";
import { compareEntries, createNameComparator, type NameComparator } from "./natural-sort";
import type { WatchBatch } from "./watcher";
import { joinRelative, nameOf, parentOf } from "./workspace-path";

const logger = log.child("fs:tree");

export interface FileTreeOptions extends Partial<FileTreeViewOptions> {
  /** Absolute path of the workspace root. */
  root: string;
  /** Children rendered per directory before a "more" row. Default 1000. */
  maxChildrenRendered?: number;
  /**
   * Every file in the workspace (workspace-relative), used by `setFilter` to find files in
   * directories that were never expanded. Plug in `FileIndex`. Without it, the filter only
   * sees loaded directories.
   */
  listAllFiles?: (signal?: AbortSignal) => Promise<readonly string[]>;
  /** Files shown at most while filtering. Default 10 000. */
  maxFilterMatches?: number;
  /** Collation locale for sorting. Default: the system locale. */
  locale?: string;
  /** Ask Git for ignore status. Default true. */
  detectIgnored?: boolean;
  /** Extra environment for Git child processes (tests isolate the global config). */
  gitEnv?: GitEnv;
}

interface TreeNode {
  readonly path: string;
  readonly name: string;
  readonly kind: EntryKind;
  readonly isSymlink: boolean;
  symlinkTarget: SymlinkTarget | null;
  isIgnored: boolean;
  readonly isHidden: boolean;
  isExcluded: boolean;
  readonly isExternal: boolean;
  readonly depth: number;
  parent: TreeNode | null;
  expanded: boolean;
  children: TreeNode[] | null;
  childIndex: Map<string, TreeNode> | null;
  /** Children include a `.git` entry: this directory is a repository root. */
  hasGitEntry: boolean;
  realPath: string | null;
  error: TreeEntryError | null;
  loading: Promise<void> | null;
  /** Bumped whenever the listing is known to be outdated. */
  dirtySeq: number;
  /** `dirtySeq` observed at the start of the last completed read (-1: never read). */
  loadedSeq: number;
  /** `FileTree.ignoreEpoch` the children's ignore flags were computed in. */
  ignoreEpoch: number;
  showLimit: number;
  snapshot: TreeEntry | null;
}

interface FilterNode {
  readonly path: string;
  readonly name: string;
  readonly kind: EntryKind;
  readonly depth: number;
  children: FilterNode[];
}

interface FilterView {
  readonly root: FilterNode;
  readonly dirs: readonly string[];
}

const EMPTY_FILTER: FileTreeFilterState = { text: "", pending: false, matchCount: 0, truncated: false };
const DEFAULT_EXCLUDE = [".git", ".DS_Store"];

function toEntryError(error: unknown, path: string): TreeEntryError {
  const lucy = isLucyError(error) ? error : fromFsError(error, path === "" ? "." : path);
  return { code: lucy.code, message: lucy.message };
}

export class FileTree implements Disposable {
  /** Absolute workspace root, as given (not resolved through symlinks). */
  readonly root: string;
  private options: FileTreeViewOptions;
  private excludeMatcher: GlobMatcher;
  private readonly compareNames: NameComparator;
  private readonly maxChildrenRendered: number;
  private readonly maxFilterMatches: number;
  private readonly listAllFiles?: (signal?: AbortSignal) => Promise<readonly string[]>;
  private readonly detectIgnored: boolean;
  private readonly oracle: GitIgnoreOracle;
  private readonly abort = new AbortController();
  private readonly changeEmitter = new Emitter<void>();
  private readonly rootNode: TreeNode;
  private disposed = false;
  private initPromise: Promise<void> | null = null;
  private ignoreEpoch = 0;
  private pendingExpanded = new Set<string>();

  private rows: readonly TreeRow[] = [];
  private rowsDirty = true;
  private rowIndex: Map<string, number> | null = null;
  private changeScheduled = false;

  private filterView: FilterView | null = null;
  private filterState: FileTreeFilterState = EMPTY_FILTER;
  private filterCollapsed = new Set<string>();
  private filterFiles: readonly string[] | null = null;
  private filterGeneration = 0;

  constructor(options: FileTreeOptions) {
    this.root = resolve(options.root);
    this.options = {
      showHidden: options.showHidden ?? true,
      showIgnored: options.showIgnored ?? true,
      exclude: options.exclude ?? DEFAULT_EXCLUDE,
    };
    this.excludeMatcher = createGlobMatcher(this.options.exclude);
    this.compareNames = createNameComparator(options.locale);
    this.maxChildrenRendered = Math.max(1, options.maxChildrenRendered ?? 1000);
    this.maxFilterMatches = Math.max(1, options.maxFilterMatches ?? 10_000);
    this.listAllFiles = options.listAllFiles;
    this.detectIgnored = options.detectIgnored ?? true;
    this.oracle = new GitIgnoreOracle(options.gitEnv);
    this.rootNode = {
      path: "",
      name: basename(this.root),
      kind: "directory",
      isSymlink: false,
      symlinkTarget: null,
      isIgnored: false,
      isHidden: false,
      isExcluded: false,
      isExternal: false,
      depth: -1,
      parent: null,
      expanded: true,
      children: null,
      childIndex: null,
      hasGitEntry: false,
      realPath: null,
      error: null,
      loading: null,
      dirtySeq: 0,
      loadedSeq: -1,
      ignoreEpoch: -1,
      showLimit: this.maxChildrenRendered,
      snapshot: null,
    };
  }

  // ---------------------------------------------------------------------------------------
  // Queries

  /** One coalesced notification per burst of changes; read `getVisibleRows()` afterwards. */
  onDidChange(listener: () => void): Disposable {
    return this.changeEmitter.on(listener);
  }

  /** Reads the root. Idempotent; every other operation calls it implicitly. */
  initialize(): Promise<void> {
    this.initPromise ??= this.ensureLoaded(this.rootNode);
    return this.initPromise;
  }

  /** Flattened visible rows. The same array is returned until something changes. */
  getVisibleRows(): readonly TreeRow[] {
    if (this.rowsDirty) {
      this.rows = this.filterView ? this.buildFilterRows(this.filterView) : this.buildRows();
      this.rowsDirty = false;
      this.rowIndex = null;
    }
    return this.rows;
  }

  /** Row index of a path in `getVisibleRows()`, or -1. */
  indexOfPath(path: string): number {
    const rows = this.getVisibleRows();
    if (!this.rowIndex) {
      this.rowIndex = new Map();
      for (let i = 0; i < rows.length; i++) this.rowIndex.set((rows[i] as TreeRow).key, i);
    }
    return this.rowIndex.get(path) ?? -1;
  }

  /** Snapshot of a loaded entry ("" is the root, whose `error` reports an unreadable workspace). */
  getEntry(path: string): TreeEntry | undefined {
    const node = this.findNode(path);
    return node ? this.snapshotOf(node) : undefined;
  }

  getOptions(): FileTreeViewOptions {
    return this.options;
  }

  getFilterState(): FileTreeFilterState {
    return this.filterState;
  }

  /** Every expanded directory, including ones under collapsed parents (for workspace restore). */
  getExpandedPaths(): string[] {
    const out: string[] = [];
    const visit = (node: TreeNode): void => {
      for (const child of node.children ?? []) {
        if (child.kind !== "directory") continue;
        if (child.expanded) out.push(child.path);
        visit(child);
      }
    };
    visit(this.rootNode);
    for (const pending of this.pendingExpanded) out.push(pending);
    return out;
  }

  // ---------------------------------------------------------------------------------------
  // Expansion

  async expand(path: string): Promise<void> {
    if (this.filterView) {
      if (this.filterCollapsed.delete(path)) this.invalidateRows();
      return;
    }
    await this.initialize();
    const node = this.findNode(path);
    if (node?.kind !== "directory" || node === this.rootNode) return;
    // An explicit expand retries a directory that failed before (permissions may have changed).
    if (node.error) node.dirtySeq++;
    if (!node.expanded) {
      node.expanded = true;
      this.touch(node);
      this.updateNodeRows(node);
    }
    await this.ensureLoaded(node);
    await this.loadExpandedDescendants(node);
  }

  collapse(path: string): void {
    if (this.filterView) {
      if (this.findFilterDir(path) && !this.filterCollapsed.has(path)) {
        this.filterCollapsed.add(path);
        this.invalidateRows();
      }
      return;
    }
    const node = this.findNode(path);
    if (!node || node === this.rootNode || !node.expanded) return;
    node.expanded = false;
    this.touch(node);
    this.updateNodeRows(node);
  }

  async toggle(path: string): Promise<void> {
    const expanded = this.filterView
      ? this.findFilterDir(path) !== undefined && !this.filterCollapsed.has(path)
      : this.findNode(path)?.expanded === true;
    if (expanded) this.collapse(path);
    else await this.expand(path);
  }

  /**
   * Reveals an entry: reads and expands every ancestor directory, raises the render cap of
   * the parent if needed, and returns the row index of the entry (-1 if it does not exist or
   * is hidden by the visibility options). While filtering, only the current rows are searched.
   */
  async expandTo(path: string): Promise<number> {
    await this.initialize();
    if (this.filterView || path === "") return this.indexOfPath(path);
    const segments = path.split("/");
    let node = this.rootNode;
    for (let i = 0; i < segments.length; i++) {
      await this.ensureLoaded(node);
      const child = this.findChild(node, segments[i] as string);
      if (!child) return -1;
      if (i === segments.length - 1) {
        this.revealInParent(node, child);
        break;
      }
      if (child.kind !== "directory") return -1;
      if (!child.expanded) {
        child.expanded = true;
        this.touch(child);
        this.updateNodeRows(child);
      }
      node = child;
    }
    return this.indexOfPath(path);
  }

  collapseAll(): void {
    if (this.filterView) {
      for (const dir of this.filterView.dirs) this.filterCollapsed.add(dir);
      this.invalidateRows();
      return;
    }
    const visit = (node: TreeNode): void => {
      for (const child of node.children ?? []) {
        if (child.kind !== "directory") continue;
        if (child.expanded) {
          child.expanded = false;
          this.touch(child);
        }
        visit(child);
      }
    };
    visit(this.rootNode);
    this.pendingExpanded.clear();
    this.invalidateRows();
  }

  /** Renders more children of a capped directory (the "more" row's action). */
  showMore(path: string, count = this.maxChildrenRendered): void {
    const node = this.findNode(path);
    if (node?.kind !== "directory") return;
    node.showLimit += Math.max(1, count);
    this.updateNodeRows(node);
  }

  /**
   * Re-applies a saved expansion set. Directories under collapsed parents are remembered and
   * applied when the parent is first read, so restoring stays lazy.
   */
  async restoreExpanded(paths: readonly string[]): Promise<void> {
    await this.initialize();
    for (const path of paths) {
      if (path === "") continue;
      const node = this.findNode(path);
      if (node) {
        if (node.kind === "directory" && !node.expanded) {
          node.expanded = true;
          this.touch(node);
        }
      } else {
        this.pendingExpanded.add(path);
      }
    }
    this.invalidateRows();
    await this.loadExpandedDescendants(this.rootNode);
  }

  // ---------------------------------------------------------------------------------------
  // Refresh

  /**
   * Re-reads loaded directories under `path` (default: everything) while preserving
   * expansion and node identity. Visible directories are read now, collapsed ones on their
   * next expand. A full refresh also re-asks Git for every ignore flag.
   */
  async refresh(path = ""): Promise<void> {
    await this.initialize();
    let node = this.findNode(path);
    if (!node) return;
    if (node.kind !== "directory") node = node.parent ?? this.rootNode;
    if (node === this.rootNode) {
      this.ignoreEpoch++;
      this.oracle.reset();
    }
    await this.refreshSubtree(node);
  }

  /**
   * Applies a watcher batch: re-reads the loaded parents of the changed paths. Because a
   * rename reports only its source path on macOS, a path that vanished triggers a re-read
   * of every visible directory (the destination could be anywhere). Overflow or a
   * `.gitignore` change triggers a full refresh.
   */
  async handleWatchBatch(batch: WatchBatch): Promise<void> {
    if (this.disposed) return;
    await this.initialize();
    this.filterFiles = null;
    if (batch.overflow || batch.paths.some((path) => nameOf(path) === ".gitignore")) {
      await this.refresh();
      return;
    }
    if (batch.paths.length === 0) return;
    const dirs = new Set<TreeNode>();
    const known: string[] = [];
    for (const path of batch.paths) {
      const node = this.findNode(path);
      if (node) {
        known.push(path);
        if (node.kind === "directory" && this.wasRead(node)) dirs.add(node);
      }
      const parent = this.findNode(parentOf(path));
      if (parent && parent.kind === "directory" && this.wasRead(parent)) dirs.add(parent);
    }
    const visible: TreeNode[] = [];
    for (const dir of dirs) {
      dir.dirtySeq++;
      if (this.isEffectivelyExpanded(dir)) visible.push(dir);
    }
    await this.reloadInOrder(visible);
    if (known.some((path) => this.findNode(path) === undefined)) {
      await this.refreshSubtree(this.rootNode);
      return;
    }
    if (this.filterView) await this.setFilter(this.filterState.text);
  }

  // ---------------------------------------------------------------------------------------
  // Options and filter

  setOptions(next: Partial<FileTreeViewOptions>): void {
    this.options = { ...this.options, ...next };
    if (next.exclude) {
      this.excludeMatcher = createGlobMatcher(next.exclude);
      const visit = (node: TreeNode): void => {
        for (const child of node.children ?? []) {
          child.isExcluded = this.excludeMatcher.matches(child.path, child.name);
          visit(child);
        }
      };
      visit(this.rootNode);
    }
    this.invalidateRows();
    if (this.filterView || this.filterState.pending) void this.setFilter(this.filterState.text);
  }

  /**
   * Narrows the tree to files whose name contains `text` (case- and accent-insensitive; when
   * `text` contains "/", the whole relative path is matched) plus their ancestors. Uses
   * `listAllFiles` so files in never-expanded directories are found. Superseded calls
   * resolve without effect. An empty string leaves filter mode, restoring the expansion state.
   */
  async setFilter(text: string): Promise<void> {
    const generation = ++this.filterGeneration;
    const trimmed = text.trim();
    if (trimmed === "") {
      const wasFiltering = this.filterView !== null || this.filterState.text !== "";
      this.filterView = null;
      this.filterFiles = null;
      this.filterCollapsed.clear();
      this.filterState = EMPTY_FILTER;
      if (wasFiltering) this.invalidateRows();
      return;
    }
    this.filterState = { ...this.filterState, text: trimmed, pending: true };
    this.scheduleChange();
    try {
      await this.initialize();
      const files = await this.filterCandidates();
      if (generation !== this.filterGeneration) return;
      const result = await this.buildFilterView(trimmed, files, generation);
      if (!result || generation !== this.filterGeneration) return;
      if (this.filterState.text !== trimmed || this.filterView === null) this.filterCollapsed.clear();
      this.filterView = result.view;
      this.filterState = {
        text: trimmed,
        pending: false,
        matchCount: result.matchCount,
        truncated: result.truncated,
      };
      this.invalidateRows();
    } catch (error) {
      if (generation !== this.filterGeneration) return;
      if (!isLucyError(error, "CANCELLED")) logger.warn("filter failed", { error });
      this.filterState = { ...this.filterState, pending: false };
      this.scheduleChange();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.filterGeneration++;
    this.abort.abort();
    this.changeEmitter.dispose();
  }

  // ---------------------------------------------------------------------------------------
  // Loading

  private absPath(path: string): string {
    return joinRelative(this.root, path);
  }

  private get realRoot(): string {
    return this.rootNode.realPath ?? this.root;
  }

  private wasRead(node: TreeNode): boolean {
    return node.children !== null || node.error !== null;
  }

  private isAttached(node: TreeNode): boolean {
    let current: TreeNode = node;
    while (current.parent) current = current.parent;
    return current === this.rootNode;
  }

  private isEffectivelyExpanded(node: TreeNode): boolean {
    for (let current: TreeNode | null = node; current; current = current.parent) {
      if (current !== this.rootNode && !current.expanded) return false;
    }
    return true;
  }

  private async ensureLoaded(node: TreeNode): Promise<void> {
    while (
      !this.disposed &&
      node.kind === "directory" &&
      node.loadedSeq !== node.dirtySeq &&
      this.isAttached(node)
    ) {
      if (!node.loading) {
        const promise: Promise<void> = this.readDirectory(node).finally(() => {
          if (node.loading === promise) node.loading = null;
          this.touch(node);
          this.updateNodeRows(node);
        });
        node.loading = promise;
        this.touch(node);
        this.updateNodeRows(node);
      }
      await node.loading;
    }
  }

  private async readDirectory(node: TreeNode): Promise<void> {
    const seq = node.dirtySeq;
    const signal = this.abort.signal;
    try {
      const abs = this.absPath(node.path);
      const real = await realpath(abs);
      for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
        if (ancestor.realPath === real) {
          throw new LucyError("UNSUPPORTED", "Symbolic link loop: this folder contains itself", {
            details: { path: node.path },
          });
        }
      }
      const entries = await listDirectory(abs, {
        realRoot: node === this.rootNode ? real : this.realRoot,
        compare: this.compareNames,
        signal,
      });
      const ignored = await this.classifyIgnored(node, entries, signal);
      if (this.disposed) return;
      await this.mergeChildren(node, entries, ignored, signal);
      node.realPath = real;
      node.error = null;
    } catch (error) {
      if (this.disposed || isLucyError(error, "CANCELLED")) return;
      node.error = toEntryError(error, node.path);
      for (const child of node.children ?? []) child.parent = null;
      node.children = null;
      node.childIndex = null;
    } finally {
      node.loadedSeq = seq;
    }
  }

  private async mergeChildren(
    node: TreeNode,
    entries: readonly RawEntry[],
    ignored: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<void> {
    const slicer = new TimeSlicer(8, signal);
    const previous = node.childIndex;
    const children: TreeNode[] = new Array(entries.length);
    const index = new Map<string, TreeNode>();
    let hasGitEntry = false;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i] as RawEntry;
      if (entry.name === ".git") hasGitEntry = true;
      const isIgnored = node.isIgnored || ignored.has(entry.name);
      const existing = previous?.get(entry.name);
      let child: TreeNode;
      if (existing && existing.kind === entry.kind && existing.isSymlink === entry.isSymlink) {
        child = existing;
        if (existing.symlinkTarget !== entry.symlinkTarget || existing.isIgnored !== isIgnored) {
          existing.symlinkTarget = entry.symlinkTarget;
          existing.isIgnored = isIgnored;
          this.touch(existing);
        }
      } else {
        child = this.createNode(entry, node, isIgnored);
      }
      children[i] = child;
      index.set(entry.name, child);
      if ((i & 2047) === 2047) await slicer.maybeYield();
    }
    if (previous) {
      for (const [name, old] of previous) if (index.get(name) !== old) old.parent = null;
    }
    node.children = children;
    node.childIndex = index;
    node.hasGitEntry = hasGitEntry;
    node.ignoreEpoch = this.ignoreEpoch;
  }

  private createNode(entry: RawEntry, parent: TreeNode, isIgnored: boolean): TreeNode {
    const path = parent.path === "" ? entry.name : `${parent.path}/${entry.name}`;
    return {
      path,
      name: entry.name,
      kind: entry.kind,
      isSymlink: entry.isSymlink,
      symlinkTarget: entry.symlinkTarget,
      isIgnored,
      isHidden: entry.name.startsWith("."),
      isExcluded: this.excludeMatcher.matches(path, entry.name),
      isExternal: parent.isExternal || (parent.isSymlink && parent.symlinkTarget === "outside"),
      depth: parent.depth + 1,
      parent,
      expanded: entry.kind === "directory" && this.pendingExpanded.delete(path),
      children: null,
      childIndex: null,
      hasGitEntry: false,
      realPath: null,
      error: null,
      loading: null,
      dirtySeq: 0,
      loadedSeq: -1,
      ignoreEpoch: -1,
      showLimit: this.maxChildrenRendered,
      snapshot: null,
    };
  }

  private async classifyIgnored(
    node: TreeNode,
    entries: readonly RawEntry[],
    signal: AbortSignal,
  ): Promise<Set<string>> {
    const ignored = new Set<string>();
    if (!this.detectIgnored || entries.length === 0) return ignored;
    if (node.isIgnored) {
      for (const entry of entries) ignored.add(entry.name);
      return ignored;
    }
    // Git refuses paths "beyond a symbolic link"; children of a symlinked folder stay unflagged.
    for (let current: TreeNode | null = node; current; current = current.parent) {
      if (current.isSymlink) return ignored;
    }
    const reuse = node.ignoreEpoch === this.ignoreEpoch ? node.childIndex : null;
    const ask: RawEntry[] = [];
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const known = reuse?.get(entry.name);
      if (known && known.kind === entry.kind && known.isSymlink === entry.isSymlink) {
        if (known.isIgnored) ignored.add(entry.name);
      } else {
        ask.push(entry);
      }
    }
    if (ask.length === 0) return ignored;
    const context = await this.repoContext(node, entries);
    if (!context) return ignored;
    const paths = ask.map(
      (entry) => `${context.prefix}${entry.name}${entry.kind === "directory" && !entry.isSymlink ? "/" : ""}`,
    );
    const answer = await this.oracle.checkIgnored(context.cwd, paths, signal);
    for (let i = 0; i < ask.length; i++) {
      if (answer.has(paths[i] as string)) ignored.add((ask[i] as RawEntry).name);
    }
    return ignored;
  }

  /** Which repository answers for `node`'s children, and the path prefix relative to it. */
  private async repoContext(
    node: TreeNode,
    entries: readonly RawEntry[],
  ): Promise<{ cwd: string; prefix: string } | null> {
    let owner: TreeNode | null = entries.some((entry) => entry.name === ".git") ? node : null;
    for (let ancestor = node.parent; !owner && ancestor; ancestor = ancestor.parent) {
      if (ancestor.hasGitEntry) owner = ancestor;
    }
    if (owner && owner !== this.rootNode) {
      // A nested repository (or submodule) answers for its own subtree.
      const prefix = owner === node ? "" : `${node.path.slice(owner.path.length + 1)}/`;
      return { cwd: this.absPath(owner.path), prefix };
    }
    if (!(await this.oracle.isInWorkTree(this.root))) return null;
    return { cwd: this.root, prefix: node.path === "" ? "" : `${node.path}/` };
  }

  private async reloadInOrder(nodes: TreeNode[]): Promise<void> {
    // Parents first: a parent's re-read may drop a child, which then needs no read at all.
    const sorted = [...nodes].sort((a, b) => a.depth - b.depth);
    let i = 0;
    while (i < sorted.length) {
      const depth = (sorted[i] as TreeNode).depth;
      const level: TreeNode[] = [];
      while (i < sorted.length && (sorted[i] as TreeNode).depth === depth)
        level.push(sorted[i++] as TreeNode);
      await forEachConcurrent(level, 8, (node) => this.ensureLoaded(node));
    }
  }

  private async refreshSubtree(node: TreeNode): Promise<void> {
    this.filterFiles = null;
    const visible: TreeNode[] = [];
    const stack: TreeNode[] = [node];
    while (stack.length > 0) {
      const current = stack.pop() as TreeNode;
      if (current.kind !== "directory" || !this.wasRead(current)) continue;
      current.dirtySeq++;
      if (this.isEffectivelyExpanded(current)) visible.push(current);
      for (const child of current.children ?? []) stack.push(child);
    }
    await this.reloadInOrder(visible);
    await this.loadExpandedDescendants(node);
    if (this.filterView) await this.setFilter(this.filterState.text);
  }

  /** Reads expanded directories below `node` that are visible but not (or no longer) loaded. */
  private async loadExpandedDescendants(node: TreeNode): Promise<void> {
    for (let round = 0; round < 256 && !this.disposed; round++) {
      const pending: TreeNode[] = [];
      const visit = (current: TreeNode): void => {
        for (const child of current.children ?? []) {
          if (child.kind !== "directory" || !child.expanded) continue;
          if (child.loadedSeq !== child.dirtySeq) pending.push(child);
          else visit(child);
        }
      };
      if (this.isEffectivelyExpanded(node)) visit(node);
      if (pending.length === 0) return;
      await this.reloadInOrder(pending);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Lookup

  private findChild(dir: TreeNode, name: string): TreeNode | undefined {
    const index = dir.childIndex;
    if (!index) return undefined;
    const exact = index.get(name);
    if (exact) return exact;
    // Watchers and users may hand us the other Unicode normalization of a name (NFD on
    // macOS); compare normalized forms only for lookup, never for IO.
    const wanted = name.normalize("NFC");
    if (wanted === name && /^[\x20-\x7e]*$/.test(name)) return undefined;
    for (const child of dir.children ?? []) if (child.name.normalize("NFC") === wanted) return child;
    return undefined;
  }

  private findNode(path: string): TreeNode | undefined {
    if (path === "") return this.rootNode;
    let node: TreeNode | undefined = this.rootNode;
    for (const segment of path.split("/")) {
      node = this.findChild(node, segment);
      if (!node) return undefined;
    }
    return node;
  }

  private revealInParent(parent: TreeNode, child: TreeNode): void {
    const visible = (parent.children ?? []).filter((node) => this.isVisible(node));
    const position = visible.indexOf(child);
    if (position >= parent.showLimit) {
      parent.showLimit = position + 1;
      this.updateNodeRows(parent);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Rows

  private touch(node: TreeNode): void {
    node.snapshot = null;
  }

  private snapshotOf(node: TreeNode): TreeEntry {
    if (node.snapshot) return node.snapshot;
    const snapshot: TreeEntry = {
      path: node.path,
      name: node.name,
      kind: node.kind,
      isSymlink: node.isSymlink,
      symlinkTarget: node.symlinkTarget,
      isIgnored: node.isIgnored,
      isHidden: node.isHidden,
      isExternal: node.isExternal,
      depth: node.depth,
      expanded: node.expanded,
      loaded: node.children !== null,
      loading: node.loading !== null,
      error: node.error,
    };
    node.snapshot = snapshot;
    return snapshot;
  }

  private isVisible(node: TreeNode): boolean {
    if (node.isExcluded) return false;
    if (!this.options.showHidden && node.isHidden) return false;
    if (!this.options.showIgnored && node.isIgnored) return false;
    return true;
  }

  private scheduleChange(): void {
    if (this.changeScheduled || this.disposed) return;
    this.changeScheduled = true;
    queueMicrotask(() => {
      this.changeScheduled = false;
      if (!this.disposed) this.changeEmitter.emit();
    });
  }

  private invalidateRows(): void {
    this.rowsDirty = true;
    this.scheduleChange();
  }

  private buildRows(): TreeRow[] {
    const out: TreeRow[] = [];
    if (this.rootNode.children) this.appendChildRows(this.rootNode, [], out);
    return out;
  }

  private appendChildRows(dir: TreeNode, guides: readonly boolean[], out: TreeRow[]): void {
    const children = dir.children;
    if (!children) return;
    const visible = children.filter((child) => this.isVisible(child));
    const shown = Math.min(visible.length, dir.showLimit);
    const hidden = visible.length - shown;
    for (let i = 0; i < shown; i++) {
      const child = visible[i] as TreeNode;
      const isLast = i === shown - 1 && hidden === 0;
      out.push({
        type: "entry",
        key: child.path,
        depth: child.depth,
        guides,
        isLast,
        entry: this.snapshotOf(child),
      });
      if (child.kind === "directory" && child.expanded && child.children) {
        this.appendChildRows(child, [...guides, !isLast], out);
      }
    }
    if (hidden > 0) {
      out.push({
        type: "more",
        key: `${dir.path}\0more`,
        depth: dir.depth + 1,
        guides,
        isLast: true,
        parentPath: dir.path,
        hiddenCount: hidden,
      });
    }
  }

  /** Splices the rows of one directory (its own row plus its visible subtree). */
  private updateNodeRows(node: TreeNode): void {
    this.scheduleChange();
    if (this.rowsDirty) return;
    if (this.filterView || node === this.rootNode) {
      this.rowsDirty = true;
      return;
    }
    const rows = this.rows;
    const index = rows.findIndex((row) => row.key === node.path);
    if (index === -1) return;
    const row = rows[index] as TreeEntryRow;
    let end = index + 1;
    while (end < rows.length && (rows[end] as TreeRow).depth > row.depth) end++;
    const replacement: TreeRow[] = [{ ...row, entry: this.snapshotOf(node) }];
    if (node.expanded && node.children) this.appendChildRows(node, [...row.guides, !row.isLast], replacement);
    this.rows = [...rows.slice(0, index), ...replacement, ...rows.slice(end)];
    this.rowIndex = null;
  }

  // ---------------------------------------------------------------------------------------
  // Filter

  private async filterCandidates(): Promise<readonly string[]> {
    if (this.filterFiles) return this.filterFiles;
    let indexed: readonly string[] = [];
    if (this.listAllFiles) {
      try {
        indexed = await this.listAllFiles(this.abort.signal);
      } catch (error) {
        if (isLucyError(error, "CANCELLED")) throw error;
        logger.warn("listAllFiles failed; filtering loaded folders only", { error });
      }
    }
    const all = new Set(indexed);
    // Loaded folders can hold files the index leaves out (ignored files, expanded symlinks).
    const visit = (node: TreeNode): void => {
      for (const child of node.children ?? []) {
        if (child.kind === "file") all.add(child.path);
        else visit(child);
      }
    };
    visit(this.rootNode);
    this.filterFiles = [...all];
    return this.filterFiles;
  }

  private isPathVisible(path: string): boolean {
    let node: TreeNode | undefined = this.rootNode;
    let rel = "";
    for (const segment of path.split("/")) {
      rel = rel === "" ? segment : `${rel}/${segment}`;
      if (this.excludeMatcher.matches(rel, segment)) return false;
      if (!this.options.showHidden && segment.startsWith(".")) return false;
      node = node ? this.findChild(node, segment) : undefined;
      if (node && !this.options.showIgnored && node.isIgnored) return false;
    }
    return true;
  }

  private async buildFilterView(
    text: string,
    files: readonly string[],
    generation: number,
  ): Promise<{ view: FilterView; matchCount: number; truncated: boolean } | null> {
    const byPath = text.includes("/");
    const needle = foldQuery(text);
    const slicer = new TimeSlicer(8, this.abort.signal);
    const matches: string[] = [];
    let truncated = false;
    for (let i = 0; i < files.length; i++) {
      if ((i & 1023) === 1023 && slicer.shouldYield) {
        await slicer.yieldNow();
        if (generation !== this.filterGeneration) return null;
      }
      const path = files[i] as string;
      if (!foldString(byPath ? path : nameOf(path)).includes(needle)) continue;
      if (!this.isPathVisible(path)) continue;
      if (matches.length >= this.maxFilterMatches) {
        truncated = true;
        break;
      }
      matches.push(path);
    }
    const root: FilterNode = { path: "", name: "", kind: "directory", depth: -1, children: [] };
    const dirs = new Map<string, FilterNode>([["", root]]);
    const fileNodes = new Set<string>();
    for (const path of matches) {
      const segments = path.split("/");
      let parent = root;
      let rel = "";
      for (let i = 0; i < segments.length - 1; i++) {
        rel = rel === "" ? (segments[i] as string) : `${rel}/${segments[i]}`;
        let dir = dirs.get(rel);
        if (!dir) {
          dir = { path: rel, name: segments[i] as string, kind: "directory", depth: i, children: [] };
          dirs.set(rel, dir);
          parent.children.push(dir);
        }
        parent = dir;
      }
      // A stale index entry could name a file where a folder now is (or vice versa).
      if (dirs.has(path) || fileNodes.has(path)) continue;
      fileNodes.add(path);
      parent.children.push({
        path,
        name: segments[segments.length - 1] as string,
        kind: "file",
        depth: segments.length - 1,
        children: [],
      });
    }
    let matchCount = 0;
    for (const dir of dirs.values()) {
      dir.children = dir.children.filter((child) => child.kind === "directory" || !dirs.has(child.path));
      matchCount += dir.children.filter((child) => child.kind === "file").length;
      dir.children = await sortAsync(dir.children, (a, b) => compareEntries(this.compareNames, a, b), {
        signal: this.abort.signal,
      });
      if (slicer.shouldYield) await slicer.yieldNow();
    }
    return { view: { root, dirs: [...dirs.keys()].filter((key) => key !== "") }, matchCount, truncated };
  }

  private findFilterDir(path: string): FilterNode | undefined {
    if (!this.filterView || path === "") return undefined;
    let node: FilterNode | undefined = this.filterView.root;
    for (const segment of path.split("/")) {
      node = node.children.find((child) => child.name === segment && child.kind === "directory");
      if (!node) return undefined;
    }
    return node;
  }

  private buildFilterRows(view: FilterView): TreeRow[] {
    const out: TreeRow[] = [];
    const walk = (dir: FilterNode, guides: readonly boolean[]): void => {
      const children = dir.children;
      for (let i = 0; i < children.length; i++) {
        const child = children[i] as FilterNode;
        const isLast = i === children.length - 1;
        const expanded = child.kind === "directory" && !this.filterCollapsed.has(child.path);
        out.push({
          type: "entry",
          key: child.path,
          depth: child.depth,
          guides,
          isLast,
          entry: this.filterEntry(child, expanded),
        });
        if (expanded) walk(child, [...guides, !isLast]);
      }
    };
    walk(view.root, []);
    return out;
  }

  private filterEntry(node: FilterNode, expanded: boolean): TreeEntry {
    const real = this.findNode(node.path);
    if (real) {
      const snapshot = this.snapshotOf(real);
      return node.kind === "directory" ? { ...snapshot, expanded, loaded: true, loading: false } : snapshot;
    }
    let ignored = false;
    let current: TreeNode | undefined = this.rootNode;
    for (const segment of node.path.split("/")) {
      current = current ? this.findChild(current, segment) : undefined;
      if (!current) break;
      ignored = current.isIgnored;
    }
    return {
      path: node.path,
      name: node.name,
      kind: node.kind,
      isSymlink: false,
      symlinkTarget: null,
      isIgnored: ignored,
      isHidden: node.name.startsWith("."),
      isExternal: false,
      depth: node.depth,
      expanded,
      loaded: node.kind === "directory",
      loading: false,
      error: null,
    };
  }
}
