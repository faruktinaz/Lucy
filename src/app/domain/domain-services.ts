/**
 * Shared domain services, created lazily from the adapters. Nothing here runs a process,
 * starts a watcher, spawns a PTY or starts a Tree-sitter worker before first paint:
 * constructing a service is cheap and side-effect free, and `startBackground()` (called right
 * after the first frame) starts Git status and the file watcher.
 */
import { join } from "node:path";
import { type AgentProvider, AgentSessionManager, createClaudeProvider } from "@/adapters/agents";
import { FileOps, type WatchBatch, Watcher, type WatchFactory } from "@/adapters/filesystem";
import {
  createGitAdapterFactory,
  type GitAdapterFactory,
  GitRepositoryManager,
  GitService,
} from "@/adapters/git";
import { type PtyProcess, PtyRegistry, type PtySpawnOptions, spawnPty } from "@/adapters/pty";
import { ContentSearch, FileIndex } from "@/adapters/search";
import { SyntaxService } from "@/adapters/syntax";
import type { ConfigService } from "@/core/config";
import { type Disposable, DisposableStore, Emitter } from "@/core/events";
import type { Logger } from "@/core/log";
import type { AppDirs } from "@/core/paths";
import type { Workspace } from "@/core/workspace";

/** Retention of the undo trash (deleted files kept for undo), applied after first paint. */
export const TRASH_LIMITS = { maxAgeDays: 30, maxBytes: 512 * 1024 * 1024 } as const;

export interface DomainServiceOverrides {
  /** Replaces the Git CLI adapter (tests use `MockGitAdapter`). */
  gitAdapterFactory?: GitAdapterFactory;
  /** Extra environment for every Git, ripgrep and file-index command (demo mode isolates Git config). */
  toolEnv?: Record<string, string | undefined>;
  /** Replaces PTY spawning (tests must never start a real shell). */
  ptySpawn?: (options: PtySpawnOptions) => PtyProcess;
  /** Agent providers; default: Claude Code from the `ai.*` settings. */
  agentProviders?: readonly AgentProvider[];
  /** Replaces `fs.watch` for the workspace watcher (tests). */
  watchFactory?: WatchFactory;
}

export interface DomainServicesOptions {
  workspace: Workspace;
  dirs: AppDirs;
  config: ConfigService;
  log: Logger;
  overrides?: DomainServiceOverrides;
  /** Reports background failures to the user (watcher stopped, ...). */
  onBackgroundError?: (title: string, message: string) => void;
}

export type DomainServiceName =
  | "git"
  | "gitRepositories"
  | "fileIndex"
  | "contentSearch"
  | "syntax"
  | "fileOps"
  | "pty"
  | "agents"
  | "watcher";

export class DomainServices implements Disposable {
  private readonly created = new Map<DomainServiceName, { value: unknown; dispose: () => void }>();
  private readonly fileChanges = new Emitter<WatchBatch>();
  private readonly background = new DisposableStore();
  private watcher: Watcher | null = null;
  private started = false;
  private disposed = false;

  constructor(private readonly options: DomainServicesOptions) {}

  private lazy<T>(name: DomainServiceName, create: () => T, dispose?: (value: T) => void): T {
    const existing = this.created.get(name);
    if (existing) return existing.value as T;
    const value = create();
    this.created.set(name, {
      value,
      dispose: () => {
        if (dispose) dispose(value);
        else (value as Partial<Disposable>).dispose?.();
      },
    });
    return value;
  }

  private peek<T>(name: DomainServiceName): T | undefined {
    return this.created.get(name)?.value as T | undefined;
  }

  /** Which services exist so far (tests assert that nothing heavy starts before first paint). */
  get createdServices(): readonly DomainServiceName[] {
    return [...this.created.keys()];
  }

  get git(): GitService {
    return this.lazy(
      "git",
      () =>
        new GitService(
          this.options.overrides?.gitAdapterFactory ??
            createGitAdapterFactory(this.options.workspace.root, { env: this.options.overrides?.toolEnv }),
        ),
    );
  }

  /**
   * Every Git repository of the workspace: the primary `git` service plus repositories found
   * below the workspace (`git.repositoryScanDepth`), one service each. Scanned after first paint.
   */
  get gitRepositories(): GitRepositoryManager {
    return this.lazy("gitRepositories", () => {
      const { config, workspace, overrides } = this.options;
      return new GitRepositoryManager({
        workspaceRoot: workspace.root,
        primary: this.git,
        createService: (root) => new GitService(createGitAdapterFactory(root, { env: overrides?.toolEnv })),
        depth: () => config.get("git.repositoryScanDepth"),
      });
    });
  }

  /**
   * Extra environment for tools a feature runs itself through the adapters (the explorer's
   * `git check-ignore`), so demo mode stays isolated from the user's Git configuration.
   */
  get toolEnv(): Readonly<Record<string, string | undefined>> | undefined {
    return this.options.overrides?.toolEnv;
  }

  get fileIndex(): FileIndex {
    return this.lazy(
      "fileIndex",
      () => new FileIndex({ root: this.options.workspace.root, env: this.options.overrides?.toolEnv }),
      () => {},
    );
  }

  get contentSearch(): ContentSearch {
    return this.lazy(
      "contentSearch",
      () =>
        new ContentSearch({
          root: this.options.workspace.root,
          fileIndex: this.fileIndex,
          env: this.options.overrides?.toolEnv,
        }),
      () => {},
    );
  }

  get syntax(): SyntaxService {
    return this.lazy(
      "syntax",
      () => new SyntaxService({ dataPath: join(this.options.dirs.cache, "tree-sitter") }),
    );
  }

  get fileOps(): FileOps {
    return this.lazy(
      "fileOps",
      () =>
        new FileOps({
          root: this.options.workspace.root,
          trashDir: join(this.options.dirs.state, "trash", this.options.workspace.id),
        }),
      () => {},
    );
  }

  get pty(): PtyRegistry {
    return this.lazy("pty", () => new PtyRegistry(this.options.overrides?.ptySpawn ?? spawnPty));
  }

  get agents(): AgentSessionManager {
    return this.lazy("agents", () => {
      const { config } = this.options;
      const providers = this.options.overrides?.agentProviders ?? [
        // Getters: the start screen and launches see `ai.executable`/`ai.args` changes live.
        createClaudeProvider({
          executable: () => config.get("ai.executable") || undefined,
          extraArgs: () => config.get("ai.args"),
        }),
      ];
      return new AgentSessionManager({ providers, spawn: this.pty.spawn });
    });
  }

  /** Workspace file changes (batched, deduplicated). Fires only once the watcher runs. */
  onDidChangeFiles(listener: (batch: WatchBatch) => void): Disposable {
    return this.fileChanges.on(listener);
  }

  /**
   * Starts Git status and the file watcher. Called once, right after the first frame, so
   * neither competes with startup.
   */
  startBackground(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const { config, log } = this.options;
    // The undo trash would otherwise grow without bound: keep a month, at most 512 MiB.
    this.fileOps.pruneTrash(TRASH_LIMITS).then(
      (result) => {
        if (result.removed > 0) log.info("Pruned the undo trash", { ...result });
      },
      (error: unknown) => log.warn("Pruning the undo trash failed", { error }),
    );
    const gitEnabled = config.get("git.enabled");
    // Created before the first refresh so listeners of the workspace's Git state find it; the
    // repositories below the workspace are searched once the workspace's own status is in.
    const repositories =
      gitEnabled && config.get("git.repositoryScanDepth") > 0 ? this.gitRepositories : undefined;
    const gitReady = gitEnabled ? this.git.refresh() : Promise.resolve(null);
    if (repositories) void gitReady.then(() => (this.disposed ? undefined : repositories.scan()));
    if (!config.get("workspace.watch")) return;
    void gitReady.then((state) => {
      if (this.disposed) return;
      const repo = state?.repo;
      const gitDir = repo && repo.root !== this.options.workspace.root ? repo.gitDir : undefined;
      this.startWatcher(gitDir);
    });
    log.debug("Background services started", { git: gitEnabled });
  }

  private startWatcher(gitDir: string | undefined): void {
    const watcher = new Watcher({
      root: this.options.workspace.root,
      gitDir,
      watchFactory: this.options.overrides?.watchFactory,
    });
    this.watcher = watcher;
    this.created.set("watcher", { value: watcher, dispose: () => watcher.dispose() });
    this.background.add(
      watcher.onDidFail((error) => {
        this.options.log.warn("File watcher stopped", { error });
        this.options.onBackgroundError?.(
          "File watching stopped",
          "Changes made outside Lucy may not appear until you reopen the workspace. See the log for details.",
        );
      }),
    );
    this.background.add(
      watcher.onDidChange((batch) => {
        const index = this.peek<FileIndex>("fileIndex");
        if (batch.overflow || batch.paths.length > 0) index?.invalidate();
        const { config } = this.options;
        if (this.created.has("git") && config.get("git.enabled") && config.get("git.autoRefresh")) {
          // Only the repositories a batch touches refresh; without nested repositories this is
          // the primary service, exactly as before.
          const repositories = this.peek<GitRepositoryManager>("gitRepositories");
          if (repositories) {
            // A nested repository's own Git metadata changed: route its root like a path in it.
            repositories.routeBatch([...batch.paths, ...(batch.nestedGitMeta ?? [])], {
              overflow: batch.overflow,
              primaryMetaChanged: batch.gitMetaChanged,
            });
          } else this.git.scheduleRefresh();
        }
        this.fileChanges.emit(batch);
      }),
    );
  }

  /** Kills every PTY tree synchronously; safe from exit handlers. */
  killAllTerminals(): void {
    const registry = this.peek<PtyRegistry>("pty");
    registry?.disposeAll();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.background.dispose();
    this.fileChanges.dispose();
    // Reverse creation order: agents before the PTY registry they spawn through.
    const services = [...this.created.entries()].reverse();
    this.created.clear();
    for (const [name, service] of services) {
      try {
        service.dispose();
      } catch (error) {
        this.options.log.warn("Disposing a service failed", { name, error });
      }
    }
    this.watcher = null;
  }

  /** The running watcher, if any (diagnostics). */
  get watcherState(): string {
    return this.watcher?.state ?? "not started";
  }
}
