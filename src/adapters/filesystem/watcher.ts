/**
 * Workspace file watcher: one recursive `fs.watch` on the root (FSEvents on macOS, inotify
 * on Linux), debounced into coalesced batches.
 *
 * Observed behavior of Bun 1.3.14 on macOS (verified in tests/filesystem/watcher.test.ts):
 * - every event is reported as "rename"; the event type carries no information, so it is
 *   ignored and consumers re-read whatever a reported path touches;
 * - a rename reports only the SOURCE path, never the destination; consumers must treat a
 *   vanished path as "something may have appeared elsewhere" (FileTree does this);
 * - bursts are coalesced by FSEvents (3000 creates arrive as a few dozen events, usually
 *   including the parent directory);
 * - Git's atomic writes (`index.lock` renamed over `index`) surface only as the `.lock`
 *   path, so lock events are checked against the target file's identity at flush time:
 *   real updates set `gitMetaChanged`, pure lock churn does not.
 *
 * Failure (EMFILE, ENOSPC, recursive watching unsupported) emits one failure event, stops
 * watching and leaves consumers on manual refresh.
 */
import { type FSWatcher, watch as fsWatch } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { errorMessage, LucyError } from "@/core/errors";
import { type Disposable, Emitter } from "@/core/events";
import { log } from "@/core/log";
import { isWithin, toRelativePosix } from "@/core/paths";

const logger = log.child("fs:watcher");

export interface WatchBatch {
  /** Workspace-relative POSIX paths, deduplicated, never under `.git/`. Empty on overflow. */
  readonly paths: readonly string[];
  /** HEAD, the index, refs, merge/rebase state or the repository itself changed. */
  readonly gitMetaChanged: boolean;
  /** Too many changes to list: consumers should do one full refresh. */
  readonly overflow: boolean;
  /**
   * Workspace-relative roots of nested repositories (a `.git` below the workspace root) whose
   * HEAD, index, refs or state changed: a commit made in a terminal inside one of them.
   */
  readonly nestedGitMeta?: readonly string[];
}

export type WatcherState = "idle" | "watching" | "failed" | "disposed";

/** The subset of `fs.FSWatcher` the watcher relies on (lets tests inject failures). */
export interface WatchHandle {
  close(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type WatchFactory = (
  path: string,
  listener: (event: string, filename: string | null) => void,
) => WatchHandle;

export interface WatcherOptions {
  root: string;
  /** Quiet period before a batch is emitted. Default 150 ms. */
  debounceMs?: number;
  /** Upper bound on how long a busy stream can delay a batch. Default 1000 ms. */
  maxWaitMs?: number;
  /** More distinct paths than this in one batch becomes an overflow. Default 2000. */
  maxBatchPaths?: number;
  /**
   * Absolute Git directory when it is not `<root>/.git` (root is a subdirectory of the
   * repository, or a linked worktree). It is watched separately for `gitMetaChanged`.
   */
  gitDir?: string;
  /** Replaces `fs.watch` (tests). Must watch recursively. */
  watchFactory?: WatchFactory;
}

const META_FILES = new Set([
  "HEAD",
  "ORIG_HEAD",
  "FETCH_HEAD",
  "MERGE_HEAD",
  "MERGE_MODE",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "BISECT_LOG",
  "index",
  "packed-refs",
  "config",
  "shallow",
  "info/exclude",
]);
const META_DIRS = ["refs/", "rebase-merge/", "rebase-apply/", "sequencer/"];

type GitPathKind = "meta" | "lock" | "noise";

/** Classifies a path relative to the Git directory ("" is the directory itself). */
export function classifyGitPath(sub: string): GitPathKind {
  if (sub === "") return "meta";
  if (sub.endsWith(".lock")) return isMetaPath(sub.slice(0, -5)) ? "lock" : "noise";
  return isMetaPath(sub) ? "meta" : "noise";
}

function isMetaPath(sub: string): boolean {
  if (META_FILES.has(sub)) return true;
  for (const dir of META_DIRS) if (sub.startsWith(dir) || `${sub}/` === dir) return true;
  return false;
}

function hasGitSegment(rel: string): boolean {
  return rel === ".git" || rel.startsWith(".git/") || rel.includes("/.git/") || rel.endsWith("/.git");
}

const defaultFactory: WatchFactory = (path, listener) =>
  fsWatch(path, { recursive: true, persistent: true, encoding: "utf8" }, (event, filename) =>
    listener(event, typeof filename === "string" ? filename : null),
  ) as FSWatcher;

interface Fingerprint {
  ino: number;
  mtimeMs: number;
  size: number;
}

export class Watcher implements Disposable {
  private readonly root: string;
  private readonly gitDir: string;
  private readonly watchesGitDirSeparately: boolean;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly maxBatchPaths: number;
  private readonly factory: WatchFactory;
  private readonly changeEmitter = new Emitter<WatchBatch>();
  private readonly failEmitter = new Emitter<LucyError>();
  private readonly handles: WatchHandle[] = [];
  private currentState: WatcherState = "idle";
  private failureError: LucyError | null = null;

  private pending = new Set<string>();
  private pendingOverflow = false;
  private pendingMeta = false;
  private pendingLocks = new Set<string>();
  private pendingNestedMeta = new Set<string>();
  private firstPendingAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private readonly fingerprints = new Map<string, Fingerprint | null>();

  constructor(options: WatcherOptions) {
    this.root = resolve(options.root);
    this.gitDir = options.gitDir ? resolve(options.gitDir) : join(this.root, ".git");
    this.watchesGitDirSeparately = options.gitDir !== undefined && !isWithin(this.root, this.gitDir);
    this.debounceMs = options.debounceMs ?? 150;
    this.maxWaitMs = Math.max(options.maxWaitMs ?? 1000, this.debounceMs);
    this.maxBatchPaths = options.maxBatchPaths ?? 2000;
    this.factory = options.watchFactory ?? defaultFactory;
  }

  get state(): WatcherState {
    return this.currentState;
  }

  /** The error that stopped the watcher, if any. */
  get failure(): LucyError | null {
    return this.failureError;
  }

  /** Subscribing starts the watcher (lazy start). */
  onDidChange(listener: (batch: WatchBatch) => void): Disposable {
    const subscription = this.changeEmitter.on(listener);
    this.start();
    return subscription;
  }

  /** Fires at most once. Check `failure` for a failure that happened before subscribing. */
  onDidFail(listener: (error: LucyError) => void): Disposable {
    return this.failEmitter.on(listener);
  }

  /** Idempotent. Failures are reported through `onDidFail`, never thrown. */
  start(): void {
    if (this.currentState !== "idle") return;
    this.currentState = "watching";
    try {
      this.handles.push(this.open(this.root, (rel) => this.onRootEvent(rel)));
      if (this.watchesGitDirSeparately) {
        this.handles.push(this.open(this.gitDir, (rel) => this.onGitEvent(rel ?? "")));
      }
    } catch (error) {
      this.fail(error);
      return;
    }
    void this.primeFingerprints();
  }

  /** Emits whatever is pending right away. */
  flush(): Promise<void> {
    this.clearTimer();
    this.flushChain = this.flushChain.then(() => this.emitPending());
    return this.flushChain;
  }

  dispose(): void {
    if (this.currentState === "disposed") return;
    this.currentState = "disposed";
    this.clearTimer();
    this.closeHandles();
    this.changeEmitter.dispose();
    this.failEmitter.dispose();
  }

  private open(path: string, onPath: (rel: string | null) => void): WatchHandle {
    const handle = this.factory(path, (_event, filename) => {
      if (this.currentState !== "watching") return;
      onPath(filename);
    });
    handle.on("error", (error) => this.fail(error));
    return handle;
  }

  private fail(error: unknown): void {
    if (this.currentState !== "watching") return;
    this.currentState = "failed";
    this.clearTimer();
    this.closeHandles();
    const code = (error as { code?: string } | null)?.code;
    const unsupported = code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" || code === "ENOSYS";
    this.failureError = new LucyError(
      unsupported ? "UNSUPPORTED" : "IO_ERROR",
      code === "EMFILE" || code === "ENOSPC"
        ? "Too many files to watch; changes on disk will not refresh automatically"
        : `File watching is unavailable: ${errorMessage(error)}`,
      { cause: error, details: { code } },
    );
    logger.warn("watcher failed", { code, message: errorMessage(error) });
    const failure = this.failureError;
    // Deferred so listeners attached in the same tick as `start()` still hear about it.
    queueMicrotask(() => this.failEmitter.emit(failure));
  }

  private closeHandles(): void {
    for (const handle of this.handles.splice(0)) {
      try {
        handle.close();
      } catch {
        // Already closed.
      }
    }
  }

  private onRootEvent(filename: string | null): void {
    if (filename === null) {
      // The OS could not say what changed: only a full refresh is correct.
      this.pendingOverflow = true;
      this.schedule();
      return;
    }
    let rel = filename.startsWith("./") ? filename.slice(2) : filename;
    if (rel.startsWith("/")) rel = toRelativePosix(this.root, rel);
    if (rel === "" || rel === ".") return;
    if (!this.watchesGitDirSeparately && (rel === ".git" || rel.startsWith(".git/"))) {
      this.onGitEvent(rel === ".git" ? "" : rel.slice(5));
      return;
    }
    if (hasGitSegment(rel)) {
      this.onNestedGitEvent(rel);
      return;
    }
    if (!this.pendingOverflow) {
      this.pending.add(rel);
      if (this.pending.size > this.maxBatchPaths) {
        this.pendingOverflow = true;
        this.pending.clear();
      }
    }
    this.schedule();
  }

  /**
   * A path inside a nested repository's `.git`: its contents never reach `paths`, but a change
   * to its HEAD, index or refs names the repository so that one refreshes. Lock files count
   * too: unlike the workspace's own repository there is no fingerprint to compare, and a
   * spare refresh is cheap.
   */
  private onNestedGitEvent(rel: string): void {
    // The first real `.git` segment (not `.github`).
    const at = /\/\.git(?:\/|$)/.exec(rel)?.index ?? -1;
    if (at <= 0) return;
    const repository = rel.slice(0, at);
    const sub = rel.slice(at + "/.git".length).replace(/^\//, "");
    if (classifyGitPath(sub) === "noise") return;
    this.pendingNestedMeta.add(repository);
    this.schedule();
  }

  private onGitEvent(sub: string): void {
    const kind = classifyGitPath(sub);
    if (kind === "noise") return;
    if (kind === "meta") this.pendingMeta = true;
    else this.pendingLocks.add(sub.slice(0, -5));
    this.schedule();
  }

  private schedule(): void {
    const now = performance.now();
    if (this.timer === null) this.firstPendingAt = now;
    else clearTimeout(this.timer);
    const remaining = this.maxWaitMs - (now - this.firstPendingAt);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.flushChain = this.flushChain.then(() => this.emitPending());
      },
      Math.max(0, Math.min(this.debounceMs, remaining)),
    );
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async emitPending(): Promise<void> {
    const overflow = this.pendingOverflow;
    const paths = overflow ? [] : [...this.pending];
    let gitMetaChanged = this.pendingMeta;
    const locks = [...this.pendingLocks];
    this.pending = new Set();
    this.pendingOverflow = false;
    this.pendingMeta = false;
    this.pendingLocks = new Set();
    const nestedGitMeta = [...this.pendingNestedMeta];
    this.pendingNestedMeta = new Set();
    if (locks.length > 0 && (await this.locksChangedTargets(locks))) gitMetaChanged = true;
    if (this.currentState !== "watching") return;
    if (!overflow && paths.length === 0 && !gitMetaChanged && nestedGitMeta.length === 0) return;
    this.changeEmitter.emit({
      paths,
      gitMetaChanged,
      overflow,
      ...(nestedGitMeta.length > 0 ? { nestedGitMeta } : {}),
    });
  }

  /** A lock file only matters if the file it guards was actually replaced. */
  private async locksChangedTargets(targets: readonly string[]): Promise<boolean> {
    let changed = false;
    for (const target of targets) {
      const next = await this.fingerprint(target);
      const previous = this.fingerprints.get(target);
      this.fingerprints.set(target, next);
      if (
        previous === undefined ||
        previous?.ino !== next?.ino ||
        previous?.mtimeMs !== next?.mtimeMs ||
        previous?.size !== next?.size
      ) {
        changed = true;
      }
    }
    return changed;
  }

  private async fingerprint(sub: string): Promise<Fingerprint | null> {
    try {
      const info = await stat(join(this.gitDir, ...sub.split("/")));
      return { ino: info.ino, mtimeMs: info.mtimeMs, size: info.size };
    } catch {
      return null;
    }
  }

  private async primeFingerprints(): Promise<void> {
    for (const target of ["index", "HEAD"]) {
      const current = await this.fingerprint(target);
      // A flush may have recorded a newer value meanwhile; never overwrite it.
      if (!this.fingerprints.has(target)) this.fingerprints.set(target, current);
    }
  }
}
