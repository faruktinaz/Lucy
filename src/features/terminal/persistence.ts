/**
 * Session persistence for terminals and agents (`terminal.persistence`): one private tmux
 * server per Lucy installation, one tmux session per Lucy session, named after the workspace
 * so a restart finds them (docs/dev/PTY_NOTES.md §13). Shared by the Terminal and AI features.
 *
 * Nothing runs until a session is created or restored: resolving the backend runs `tmux -V`
 * once and writes Lucy's own tmux configuration under the state directory.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { detectTmux, type TmuxAvailability, TmuxBackend, type TmuxSessionInfo } from "@/adapters/pty";
import type { AppContext } from "@/app/app-context";
import { type Disposable, Emitter, toDisposable } from "@/core/events";
import type { WorkspaceSessionsState } from "@/core/workspace";
import { isWorkspaceRelativePath } from "@/core/workspace";

export interface SessionPersistence {
  /** The tmux backend, or null when sessions end with Lucy (setting off, tmux unusable). */
  backend(): TmuxBackend | null;
  /** `lucy-<workspace>-t3` for terminal 3, `...-a2` for agent session 2. */
  sessionName(kind: "t" | "a", number: number): string;
  /** This workspace's sessions on the server (empty without persistence). */
  list(): Promise<TmuxSessionInfo[]>;
  /** Ends every background session of this workspace, then tells the features; returns how many. */
  endAll(): Promise<number>;
  onDidEndAll(listener: () => void): Disposable;
  /** Features report their running persistent sessions (for the quit message). */
  registerCounter(count: () => number): Disposable;
  running(): number;
  saved(): WorkspaceSessionsState;
  save(patch: Partial<WorkspaceSessionsState>): void;
  /** Stored form of a working directory: relative to the workspace, null for the root or outside. */
  storedCwd(cwd: string | null | undefined): string | null;
  /** The directory a stored cwd points to (the workspace root when it no longer applies). */
  restoredCwd(stored: string | null): string;
}

const instances = new WeakMap<AppContext, SessionPersistence>();

function notice(
  ctx: AppContext,
  availability: Exclude<TmuxAvailability, { ok: true }>,
  required: boolean,
): void {
  // Once per installation: a calm note, not a nag on every start.
  const marker = join(ctx.dirs.state, "notices", "tmux-unavailable");
  if (existsSync(marker)) return;
  try {
    mkdirSync(join(ctx.dirs.state, "notices"), { recursive: true });
    writeFileSync(marker, `${new Date().toISOString()} ${availability.reason}\n`);
  } catch {
    // Without the marker the note may show again; nothing else depends on it.
  }
  const why =
    availability.reason === "missing"
      ? "tmux is not installed"
      : availability.reason === "old"
        ? `tmux ${availability.version ?? ""} is older than 3.3`
        : "tmux could not be started";
  ctx.notifications.show({
    severity: required ? "warning" : "info",
    title: "Sessions end when Lucy quits",
    message: `${why}, so terminals and Claude Code sessions cannot keep running in the background. Install tmux 3.3 or newer to keep them.`,
  });
}

export function sessionPersistence(ctx: AppContext): SessionPersistence {
  const existing = instances.get(ctx);
  if (existing) return existing;
  let resolved: TmuxBackend | null | undefined;
  const slug = ctx.workspace.id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 120);
  const prefix = `lucy-${slug}-`;
  const root = resolve(ctx.workspace.root);

  const backend = (): TmuxBackend | null => {
    if (resolved !== undefined) return resolved;
    const mode = ctx.config.get("terminal.persistence");
    // Under the test and screenshot harness (LUCY_TEST_ROOT), "auto" never starts a background
    // tmux server implicitly; tests that want persistence ask for "tmux" and clean up.
    if (mode === "off" || (mode === "auto" && process.env.LUCY_TEST_ROOT)) {
      resolved = null;
      return resolved;
    }
    const availability = detectTmux();
    if (!availability.ok) {
      notice(ctx, availability, mode === "tmux");
      resolved = null;
      return resolved;
    }
    // One server per installation (state directory), never the user's default server.
    const socketName = `lucy-${Bun.hash(resolve(ctx.dirs.state)).toString(16).slice(0, 10)}`;
    resolved = new TmuxBackend({
      executable: availability.executable,
      socketName,
      configPath: join(ctx.dirs.state, "tmux", "lucy.conf"),
      spawn: ctx.services.pty.spawn,
    });
    // Writes the configuration synchronously before the first client can start a server.
    void resolved.prepare();
    return resolved;
  };

  const ended = new Emitter<void>();
  const counters = new Set<() => number>();
  const instance: SessionPersistence = {
    backend,
    sessionName: (kind, number) => `${prefix}${kind}${number}`,
    list: async () => (await backend()?.list(prefix)) ?? [],
    endAll: async () => {
      const count = (await backend()?.killSessions(prefix)) ?? 0;
      ended.emit();
      instance.save({ terminals: [], agents: [] });
      return count;
    },
    onDidEndAll: (listener) => ended.on(listener),
    registerCounter: (count) => {
      counters.add(count);
      return toDisposable(() => counters.delete(count));
    },
    running: () => [...counters].reduce((sum, count) => sum + count(), 0),
    saved: () => ctx.persisted.state.sessions,
    save: (patch) => ctx.persisted.update({ sessions: { ...ctx.persisted.state.sessions, ...patch } }),
    storedCwd: (cwd) => {
      if (!cwd) return null;
      const rel = relative(root, resolve(cwd)).split("\\").join("/");
      return isWorkspaceRelativePath(rel) ? rel : null;
    },
    restoredCwd: (stored) => {
      const target = stored ? join(root, stored) : root;
      return existsSync(target) ? target : root;
    },
  };
  instances.set(ctx, instance);
  return instance;
}
