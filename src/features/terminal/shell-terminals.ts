/**
 * The shell sessions of the bottom Terminal panel: created on demand (never before the user
 * opens the panel), several at once, killed with confirmation, restartable after they exit.
 * Every session is spawned through the app's `PtyRegistry`, so quitting Lucy kills its tree.
 */
import { basename } from "node:path";
import { type PtyExitInfo, TerminalSession } from "@/adapters/pty";
import type { AppContext } from "@/app/app-context";
import type { Disposable } from "@/core/events";
import { Store } from "@/core/store";
import { sanitizeForDisplay, truncateEnd } from "@/core/text";
import { sessionPersistence } from "./persistence";

export interface ShellTerminal {
  readonly id: string;
  /** 1, 2, 3... in creation order; used to tell equal shells apart. */
  readonly number: number;
  /** Base name of the shell executable: "zsh". */
  readonly shellName: string;
  readonly session: TerminalSession;
  /** Where it started (the shell may have moved since; OSC 7 reports that). */
  readonly cwd: string;
}

export interface ShellTerminalsState {
  readonly terminals: readonly ShellTerminal[];
  readonly activeId: string | null;
}

/** The shell to start: `terminal.shell`, else `$SHELL`, else `/bin/sh`. */
export function resolveShell(
  configured: string,
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
): { argv: string[]; name: string } {
  const shell = configured.trim() || env.SHELL?.trim() || "/bin/sh";
  return { argv: [shell, ...args], name: basename(shell) || shell };
}

/** Tab title: the program's own title (OSC 0/2) when it sets one, else the shell name. */
export function terminalTitle(terminal: ShellTerminal, all: readonly ShellTerminal[]): string {
  const own = terminal.session.state.get().title;
  if (own) return truncateEnd(sanitizeForDisplay(own), 40);
  const same = all.filter((other) => other.shellName === terminal.shellName);
  return same.length > 1 && same[0] !== terminal
    ? `${terminal.shellName} ${terminal.number}`
    : terminal.shellName;
}

export class ShellTerminals implements Disposable {
  readonly store = new Store<ShellTerminalsState>({ terminals: [], activeId: null });
  /** Increases when any terminal's title or running state changes (tab labels follow it). */
  readonly revision = new Store(0);
  private readonly watchers = new Map<string, () => void>();
  private nextNumber = 1;
  private disposed = false;
  /** The last size a pane reported; new terminals start at it, avoiding an early resize. */
  private lastSize = { cols: 80, rows: 12 };

  constructor(private readonly ctx: AppContext) {}

  get state(): ShellTerminalsState {
    return this.store.get();
  }

  get active(): ShellTerminal | undefined {
    const { terminals, activeId } = this.state;
    return terminals.find((terminal) => terminal.id === activeId) ?? terminals[0];
  }

  noteSize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.lastSize = { cols, rows };
  }

  /**
   * Creates a shell session. The pane that displays it starts the process once its emulator
   * is connected; a spawn failure shows in the pane with a Restart action. With persistence the
   * shell runs in its own tmux session (`restore` reattaches to it, or recreates it).
   */
  create(restore?: { number: number; cwd: string; ended?: PtyExitInfo }): ShellTerminal {
    const { config, workspace, env } = this.ctx;
    const shell = resolveShell(config.get("terminal.shell"), config.get("terminal.args"));
    const number = restore?.number ?? this.nextNumber;
    this.nextNumber = Math.max(this.nextNumber, number + 1);
    const cwd = restore?.cwd ?? workspace.root;
    const persistence = sessionPersistence(this.ctx);
    const backend = persistence.backend();
    const spawn = backend
      ? backend.spawner({
          name: persistence.sessionName("t", number),
          argv: shell.argv,
          cwd,
          meta: { kind: "terminal", number: String(number) },
        })
      : this.ctx.services.pty.spawn;
    const session = new TerminalSession({
      argv: shell.argv,
      cwd,
      env: { TERM_PROGRAM_VERSION: env.version },
      cols: this.lastSize.cols,
      rows: this.lastSize.rows,
      spawn,
      autoStart: false,
      persistent: backend !== null,
      ended: restore?.ended ? { exit: restore.ended } : undefined,
    });
    const terminal: ShellTerminal = { id: `terminal-${number}`, number, shellName: shell.name, session, cwd };
    let last = "";
    this.watchers.set(
      terminal.id,
      session.state.subscribe(() => {
        const { title, status, cwd: reported } = session.state.get();
        const key = `${status}\u0000${title}\u0000${reported ?? ""}`;
        if (key === last) return;
        last = key;
        this.revision.set((value) => value + 1);
        this.save();
      }),
    );
    this.store.set((state) => ({ terminals: [...state.terminals, terminal], activeId: terminal.id }));
    this.save();
    return terminal;
  }

  /**
   * Brings back this workspace's terminals: reattaches the tmux sessions that still exist,
   * shows ended ones as ended, and recreates lost ones (after a reboot) as fresh shells in
   * their last directory. Runs only when something was saved, so a plain start runs no tmux.
   */
  async restore(): Promise<number> {
    const persistence = sessionPersistence(this.ctx);
    const saved = persistence.saved().terminals;
    if (saved.length === 0 || !persistence.backend()) return 0;
    const live = (await persistence.list()).filter((session) => session.meta.kind === "terminal");
    const numbers = new Map<number, { cwd: string; ended?: PtyExitInfo }>();
    for (const entry of saved) numbers.set(entry.number, { cwd: persistence.restoredCwd(entry.cwd) });
    for (const session of live) {
      const number = Number(session.meta.number);
      if (!Number.isInteger(number) || number < 1) continue;
      numbers.set(number, {
        cwd: session.currentPath ?? numbers.get(number)?.cwd ?? this.ctx.workspace.root,
        ended: session.dead ? (session.exit ?? undefined) : undefined,
      });
    }
    const ordered = [...numbers.entries()].sort(([a], [b]) => a - b);
    for (const [number, entry] of ordered) {
      if (this.disposed || this.state.terminals.some((terminal) => terminal.number === number)) continue;
      this.create({ number, cwd: entry.cwd, ended: entry.ended });
    }
    const first = this.state.terminals[0];
    if (first) this.activate(first.id);
    return ordered.length;
  }

  /** Running terminals that keep running in the background when Lucy quits. */
  runningPersistent(): number {
    return this.state.terminals.filter(
      (terminal) => terminal.session.persistent && terminal.session.isRunning,
    ).length;
  }

  /** Forgets every terminal without ending anything (their tmux sessions are already gone). */
  forgetAll(): void {
    for (const terminal of [...this.state.terminals]) this.remove(terminal);
  }

  /** The list that comes back after a restart (only persistent terminals). */
  private save(): void {
    if (this.disposed) return;
    const persistence = sessionPersistence(this.ctx);
    const terminals = this.state.terminals
      .filter((terminal) => terminal.session.persistent)
      .map((terminal) => ({
        name: persistence.sessionName("t", terminal.number),
        number: terminal.number,
        cwd: persistence.storedCwd(terminal.session.state.get().cwd ?? terminal.cwd),
      }));
    const before = persistence.saved().terminals;
    if (JSON.stringify(before) !== JSON.stringify(terminals)) persistence.save({ terminals });
  }

  activate(id: string): void {
    if (this.state.terminals.some((terminal) => terminal.id === id)) this.store.update({ activeId: id });
  }

  /** Activates the next (or previous) terminal, wrapping around. */
  cycle(step: 1 | -1): void {
    const { terminals } = this.state;
    if (terminals.length < 2) return;
    const index = terminals.findIndex((terminal) => terminal.id === this.active?.id);
    const next = terminals[(index + step + terminals.length) % terminals.length];
    if (next) this.activate(next.id);
  }

  async restart(id: string): Promise<void> {
    await this.find(id)?.session.restart();
  }

  /**
   * Kills a terminal's process tree and removes it. A running shell asks first: it may have
   * jobs or an editor open in it.
   */
  async kill(id: string, options: { confirm?: boolean } = {}): Promise<boolean> {
    const terminal = this.find(id);
    if (!terminal) return false;
    const running = terminal.session.isRunning;
    if (running && (options.confirm ?? true)) {
      const title = terminalTitle(terminal, this.state.terminals);
      const confirmed = await this.ctx.dialogs.confirm({
        title: `Kill ${title}?`,
        message: "The shell and every program started in it will be stopped. Scrollback is lost.",
        confirmLabel: "Kill Terminal",
        danger: true,
      });
      if (!confirmed) return false;
    }
    this.remove(terminal);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.watchers.values()) unsubscribe();
    this.watchers.clear();
    // Quitting: persistent shells keep running in tmux (the client is only detached); the
    // others are killed as before.
    for (const terminal of this.state.terminals) {
      terminal.session.dispose({ kill: !terminal.session.persistent });
    }
    this.store.set({ terminals: [], activeId: null });
  }

  private find(id: string): ShellTerminal | undefined {
    return this.state.terminals.find((terminal) => terminal.id === id);
  }

  private remove(terminal: ShellTerminal): void {
    this.watchers.get(terminal.id)?.();
    this.watchers.delete(terminal.id);
    terminal.session.dispose();
    this.store.set((state) => {
      const index = state.terminals.indexOf(terminal);
      const terminals = state.terminals.filter((other) => other !== terminal);
      const neighbour = terminals[Math.min(index, terminals.length - 1)];
      const activeId = state.activeId === terminal.id ? (neighbour?.id ?? null) : state.activeId;
      return { terminals, activeId };
    });
    this.save();
  }
}
