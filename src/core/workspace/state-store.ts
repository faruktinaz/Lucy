/**
 * Persistence of `WorkspaceState` at `<stateDir>/workspaces/<id>.json`, never inside the
 * project. Saves are debounced (layout changes arrive in bursts while resizing) and atomic;
 * `flush()` writes immediately and must be awaited on shutdown. A corrupt file is moved
 * aside (`<id>.json.corrupt-<timestamp>`), never deleted, and the session starts fresh.
 */
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../config/atomic-write";
import { errorMessage, fromFsError } from "../errors";
import { type Disposable, Emitter } from "../events";
import type { AppDirs } from "../paths";
import type { Workspace } from "./resolve";
import {
  defaultWorkspaceState,
  normalizeWorkspaceState,
  WORKSPACE_STATE_VERSION,
  type WorkspaceState,
} from "./state";

export interface WorkspaceStateStoreOptions {
  /** Delay before a `save` reaches the disk. Default 500 ms. */
  debounceMs?: number;
  now?: () => Date;
}

export interface WorkspaceStateLoadResult {
  state: WorkspaceState;
  /** `defaults`: no file. `file`: loaded. `recovered`: the file was corrupt and moved aside. */
  source: "defaults" | "file" | "recovered";
  corruptBackupPath?: string;
  message?: string;
}

export function workspaceStatePath(dirs: Pick<AppDirs, "state">, workspaceId: string): string {
  return join(dirs.state, "workspaces", `${workspaceId}.json`);
}

export class WorkspaceStateStore implements Disposable {
  readonly path: string;
  private readonly debounceMs: number;
  private readonly now: () => Date;
  private pending: WorkspaceState | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private readonly failures = new Emitter<unknown>();

  constructor(
    dirs: Pick<AppDirs, "state">,
    private readonly workspace: Pick<Workspace, "id" | "root">,
    options: WorkspaceStateStoreOptions = {},
  ) {
    this.path = workspaceStatePath(dirs, workspace.id);
    this.debounceMs = options.debounceMs ?? 500;
    this.now = options.now ?? (() => new Date());
  }

  /** Reads the state. Missing gives defaults; corrupt is moved aside and gives defaults. */
  async load(): Promise<WorkspaceStateLoadResult> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as { code?: string } | null)?.code === "ENOENT") {
        return { state: defaultWorkspaceState(), source: "defaults" };
      }
      throw fromFsError(error, this.path);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      return this.recover(`not valid JSON (${errorMessage(error)})`);
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return this.recover("not a JSON object");
    }
    return { state: normalizeWorkspaceState(data), source: "file" };
  }

  private async recover(reason: string): Promise<WorkspaceStateLoadResult> {
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    const backup = `${this.path}.corrupt-${stamp}`;
    try {
      await rename(this.path, backup);
    } catch (error) {
      throw fromFsError(error, this.path);
    }
    return {
      state: defaultWorkspaceState(),
      source: "recovered",
      corruptBackupPath: backup,
      message: `Saved workspace state was ${reason}; it was moved to ${backup} and the workspace starts fresh.`,
    };
  }

  /** Schedules a save. Later calls within the debounce window replace earlier ones. */
  save(state: WorkspaceState): void {
    this.pending = state;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.writePending().catch((error) => this.failures.emit(error));
    }, this.debounceMs);
  }

  /** Writes any pending state now and waits for all writes. Rejects if that write fails. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.writePending();
  }

  /** Background (debounced) save failures; `flush` failures reject instead. */
  onDidFailSave(listener: (error: unknown) => void): Disposable {
    return this.failures.on(listener);
  }

  /** Normalizes (caps, path validation) and stamps the state exactly as it will be stored. */
  serialize(state: WorkspaceState): string {
    const normalized = normalizeWorkspaceState(state);
    const stored = {
      ...normalized,
      version: WORKSPACE_STATE_VERSION,
      updatedAt: this.now().toISOString(),
      // Informational only, so a human browsing the state folder knows which project this is.
      root: this.workspace.root,
    };
    return `${JSON.stringify(stored, null, 2)}\n`;
  }

  private writePending(): Promise<void> {
    const state = this.pending;
    this.pending = undefined;
    const run = this.writing
      .catch(() => {})
      .then(async () => {
        if (state === undefined) return;
        // Commit drafts and paths are private: owner-only permissions.
        await writeFileAtomic(this.path, this.serialize(state), { mode: 0o600 });
      });
    this.writing = run;
    return run;
  }

  /** Cancels a pending debounced save. Call `flush()` first to keep it. */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
    this.failures.dispose();
  }
}
