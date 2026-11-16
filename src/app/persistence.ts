/**
 * Keeps the per-workspace restore state (`WorkspaceState`) in a store and writes it through
 * `WorkspaceStateStore` (debounced, atomic, outside the project). The workbench feeds it
 * layout, tabs and the command MRU; features keep their own slices in it (explorer expansion,
 * search query, commit draft) with `update()`.
 */
import { errorMessage } from "@/core/errors";
import { type Disposable, DisposableStore } from "@/core/events";
import type { Logger } from "@/core/log";
import { Store } from "@/core/store";
import {
  defaultWorkspaceState,
  STATE_LIMITS,
  type WorkspaceState,
  type WorkspaceStateStore,
} from "@/core/workspace";

export class PersistedState implements Disposable {
  readonly store = new Store<WorkspaceState>(defaultWorkspaceState());
  private readonly subscriptions = new DisposableStore();
  private enabled = false;
  private failureReported = false;

  constructor(
    private readonly file: WorkspaceStateStore,
    private readonly log: Logger,
    private readonly onFailure: (message: string) => void,
  ) {
    this.subscriptions.add(
      file.onDidFailSave((error) => {
        this.log.warn("Saving workspace state failed", { error });
        if (!this.failureReported) {
          this.failureReported = true;
          this.onFailure(errorMessage(error));
        }
      }),
    );
  }

  get state(): WorkspaceState {
    return this.store.get();
  }

  /** Replaces the in-memory state (after loading) without writing it back. */
  load(state: WorkspaceState): void {
    this.store.set(state);
  }

  /** Starts writing changes to disk. Nothing is written before the restore finished. */
  enable(): void {
    this.enabled = true;
  }

  /** Merges a patch and schedules a save. */
  update(patch: Partial<WorkspaceState>): void {
    this.store.set((state) => ({ ...state, ...patch }));
    if (this.enabled) this.file.save(this.store.get());
  }

  /** Records a file in the recently-opened list (Quick Open shows these first). */
  noteRecentFile(path: string): void {
    const recent = [path, ...this.state.recentFiles.filter((p) => p !== path)].slice(
      0,
      STATE_LIMITS.recentFiles,
    );
    this.update({ recentFiles: recent });
  }

  /** Writes pending changes now. Never throws: shutdown must continue. */
  async flush(): Promise<void> {
    if (!this.enabled) return;
    try {
      this.file.save(this.store.get());
      await this.file.flush();
    } catch (error) {
      this.log.warn("Flushing workspace state failed", { error });
    }
  }

  dispose(): void {
    this.subscriptions.dispose();
  }
}
