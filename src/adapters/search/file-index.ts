/**
 * Candidate files for Quick Open (and the builtin content search and the explorer filter).
 *
 * Strategy chain, first that works wins:
 * 1. "git": inside a work tree, `git ls-files` (tracked plus untracked-not-ignored). Tracked
 *    files deleted from disk and submodule entries (gitlinks) are left out.
 * 2. "ripgrep": a real `rg` on PATH: `rg --files -0 --hidden --glob '!.git'`.
 * 3. "walk": a bounded asynchronous directory walk.
 * The result is cached until `invalidate()`; concurrent callers share one computation, which
 * is aborted only when every waiting caller has aborted.
 */
import { cancelledError, sortAsync, throwIfAborted } from "@/adapters/filesystem/async-util";
import { type GitEnv, isInsideGitWorkTree, runGit, splitNul } from "@/adapters/filesystem/git-probe";
import { isLucyError } from "@/core/errors";
import { log } from "@/core/log";
import { run, which } from "@/core/process";
import { DEFAULT_WALK_EXCLUDES, walkFiles } from "./file-walk";

const logger = log.child("search:index");

export type FileIndexStrategy = "git" | "ripgrep" | "walk";

export interface FileIndexResult {
  /** Workspace-relative POSIX paths, sorted by code unit, no duplicates. */
  readonly files: readonly string[];
  /** A limit (files, depth, time, output size) cut the list short. */
  readonly truncated: boolean;
  readonly strategy: FileIndexStrategy;
  readonly durationMs: number;
}

export interface FileIndexOptions {
  /** Absolute workspace root. */
  root: string;
  /** Strategy order (tests force one). Default `["git", "ripgrep", "walk"]`. */
  strategies?: readonly FileIndexStrategy[];
  /** Default 200 000. */
  maxFiles?: number;
  /** Walk only. Default 64. */
  maxDepth?: number;
  /** Walk only. Default 20 s. */
  timeBudgetMs?: number;
  /** Walk only: names skipped everywhere. Default `.git .hg .svn node_modules .DS_Store`. */
  excludeNames?: readonly string[];
  /** Extra environment for Git and ripgrep (tests isolate the Git config). */
  env?: GitEnv;
  /** Path of `rg`; `null` disables ripgrep; default: looked up on PATH once. */
  ripgrepPath?: string | null;
}

interface Listing {
  files: string[];
  truncated: boolean;
}

interface Flight {
  promise: Promise<FileIndexResult>;
  controller: AbortController;
  waiters: number;
}

const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Splits `-z`/`-0` output; a cut-off final record (output limit hit) is dropped. */
function records(output: string, truncated: boolean): string[] {
  const parts = splitNul(output);
  if (truncated && !output.endsWith("\0")) parts.pop();
  return parts;
}

async function listWithGit(
  root: string,
  env: GitEnv | undefined,
  signal: AbortSignal,
): Promise<Listing | null> {
  if (!(await isInsideGitWorkTree(root, env, signal))) return null;
  const common = { cwd: root, env, signal, timeoutMs: 60_000, maxOutputBytes: MAX_OUTPUT_BYTES };
  const [cached, others, deleted] = await Promise.all([
    runGit(["ls-files", "-z", "--cached", "--stage"], common),
    runGit(["ls-files", "-z", "--others", "--exclude-standard"], common),
    runGit(["ls-files", "-z", "--deleted"], common),
  ]);
  throwIfAborted(signal);
  if (!cached || !others || cached.code !== 0 || others.code !== 0) return null;
  const removed = new Set(deleted?.code === 0 ? records(deleted.stdout, deleted.truncated) : []);
  const seen = new Set<string>();
  const files: string[] = [];
  for (const record of records(cached.stdout, cached.truncated)) {
    // "<mode> <object> <stage>\t<path>"; unmerged paths appear once per stage.
    const tab = record.indexOf("\t");
    if (tab === -1 || record.startsWith("160000 ")) continue; // 160000: submodule gitlink.
    const path = record.slice(tab + 1);
    if (removed.has(path) || seen.has(path)) continue;
    seen.add(path);
    files.push(path);
  }
  for (const path of records(others.stdout, others.truncated)) {
    if (path.endsWith("/") || seen.has(path)) continue; // "dir/" is a nested repository.
    seen.add(path);
    files.push(path);
  }
  return { files, truncated: cached.truncated || others.truncated };
}

async function listWithRipgrep(
  rg: string,
  root: string,
  env: GitEnv | undefined,
  signal: AbortSignal,
): Promise<Listing | null> {
  const result = await run(
    [rg, "--files", "-0", "--hidden", "--no-config", "--no-messages", "--glob", "!.git"],
    {
      cwd: root,
      env,
      signal,
      timeoutMs: 60_000,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    },
  );
  throwIfAborted(signal);
  // 0: files found, 1: none, 2: some paths unreadable (the list is still valid).
  if (result.code === null || result.code > 2) return null;
  const files = records(result.stdout, result.truncated).map((path) =>
    path.startsWith("./") ? path.slice(2) : path,
  );
  return { files, truncated: result.truncated };
}

export class FileIndex {
  readonly root: string;
  private readonly strategies: readonly FileIndexStrategy[];
  private readonly maxFiles: number;
  private readonly maxDepth: number;
  private readonly timeBudgetMs: number;
  private readonly excludeNames: ReadonlySet<string>;
  private readonly env?: GitEnv;
  private readonly ripgrepOverride: string | null | undefined;
  private ripgrepResolved: string | null | undefined;
  private cache: FileIndexResult | null = null;
  private inflight: Flight | null = null;
  private generation = 0;

  constructor(options: FileIndexOptions) {
    this.root = options.root;
    this.strategies = options.strategies ?? ["git", "ripgrep", "walk"];
    this.maxFiles = Math.max(1, options.maxFiles ?? 200_000);
    this.maxDepth = Math.max(1, options.maxDepth ?? 64);
    this.timeBudgetMs = Math.max(1, options.timeBudgetMs ?? 20_000);
    this.excludeNames = new Set(options.excludeNames ?? DEFAULT_WALK_EXCLUDES);
    this.env = options.env;
    this.ripgrepOverride = options.ripgrepPath;
  }

  /** The cached result, if any (never starts work). */
  peek(): FileIndexResult | null {
    return this.cache;
  }

  /** Drops the cache. A computation already running still answers its callers but is not cached. */
  invalidate(): void {
    this.cache = null;
    this.generation++;
    this.inflight = null;
  }

  /** `rg` used by the ripgrep strategy, or `null`. */
  ripgrepPath(): string | null {
    if (this.ripgrepOverride !== undefined) return this.ripgrepOverride;
    if (this.ripgrepResolved === undefined) this.ripgrepResolved = which("rg", this.env);
    return this.ripgrepResolved;
  }

  list(signal?: AbortSignal): Promise<FileIndexResult> {
    if (signal?.aborted) return Promise.reject(cancelledError());
    if (this.cache) return Promise.resolve(this.cache);
    const flight = this.inflight ?? this.startFlight();
    flight.waiters++;
    return new Promise<FileIndexResult>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        flight.waiters--;
        // Nobody wants the result any more: stop the child processes / walk.
        if (flight.waiters === 0) {
          flight.controller.abort();
          if (this.inflight === flight) this.inflight = null;
        }
        reject(cancelledError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      flight.promise.then(
        (result) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          flight.waiters--;
          resolve(result);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          flight.waiters--;
          reject(error);
        },
      );
    });
  }

  private startFlight(): Flight {
    const controller = new AbortController();
    const generation = this.generation;
    const holder: { flight?: Flight } = {};
    const promise = this.compute(controller.signal).then(
      (result) => {
        if (generation === this.generation) this.cache = result;
        if (this.inflight === holder.flight) this.inflight = null;
        return result;
      },
      (error: unknown) => {
        if (this.inflight === holder.flight) this.inflight = null;
        throw error;
      },
    );
    // Every waiter attaches its own handlers; this one keeps an abandoned flight quiet.
    promise.catch(() => {});
    const flight: Flight = { promise, controller, waiters: 0 };
    holder.flight = flight;
    this.inflight = flight;
    return flight;
  }

  private async compute(signal: AbortSignal): Promise<FileIndexResult> {
    const started = performance.now();
    for (const strategy of this.strategies) {
      throwIfAborted(signal);
      let listing: Listing | null = null;
      try {
        if (strategy === "git") {
          listing = await listWithGit(this.root, this.env, signal);
        } else if (strategy === "ripgrep") {
          const rg = this.ripgrepPath();
          if (rg) listing = await listWithRipgrep(rg, this.root, this.env, signal);
        } else {
          listing = await walkFiles(this.root, {
            maxFiles: this.maxFiles,
            maxDepth: this.maxDepth,
            timeBudgetMs: this.timeBudgetMs,
            excludeNames: this.excludeNames,
            signal,
          });
        }
      } catch (error) {
        if (isLucyError(error, "CANCELLED") || signal.aborted) throw cancelledError();
        logger.warn("file listing strategy failed", { strategy, error });
        continue;
      }
      if (!listing) continue;
      let truncated = listing.truncated;
      let files = listing.files;
      if (files.length > this.maxFiles) {
        files = files.slice(0, this.maxFiles);
        truncated = true;
      }
      const sorted = await sortAsync(files, compareCodeUnits, { signal });
      return { files: sorted, truncated, strategy, durationMs: performance.now() - started };
    }
    return { files: [], truncated: false, strategy: "walk", durationMs: performance.now() - started };
  }
}
