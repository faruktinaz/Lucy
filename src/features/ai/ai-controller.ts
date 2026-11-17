/**
 * The AI feature's state and actions, independent of React: which coding agent runs, whether
 * its CLI is available, launching sessions (with the permission-warning confirmation), the
 * session actions, what happens when the panel is hidden, the quit guard, the history of
 * previous sessions and prompt templates.
 *
 * Hard rules (shared with the agent adapter): Lucy never adds permission-bypass flags and
 * never submits a prompt. Templates are pasted; the user presses Enter.
 *
 * Nothing here touches `ctx.services.agents` until the user acts (opens the panel, starts a
 * session): creating the service at startup would break "nothing heavy before first paint".
 */
import {
  type AgentDetection,
  type AgentLaunch,
  type AgentLaunchMode,
  type AgentLaunchWarning,
  type AgentProvider,
  type AgentSession,
  type AgentSessionListing,
  type AgentSessionManager,
  buildPrompt,
  type PromptTemplateId,
} from "@/adapters/agents";
import type { PtySpawner } from "@/adapters/pty";
import type { AppContext } from "@/app/app-context";
import { errorMessage } from "@/core/errors";
import { type Disposable, DisposableStore, toDisposable } from "@/core/events";
import { Store } from "@/core/store";
import { sessionPersistence } from "@/features/terminal";
import { promptContextFrom, templateItems } from "./prompt-context";

export const AI_VIEW_ID = "claude";
export const AI_SESSIONS_VIEW_ID = "aiSessions";

export type DetectionState =
  | { readonly kind: "unchecked" }
  | { readonly kind: "checking" }
  /** No agent provider is registered at all. */
  | { readonly kind: "no-provider" }
  | {
      readonly kind: "done";
      readonly detection: AgentDetection;
      /** Warnings for the configured extra arguments (a permission bypass, a prompt). */
      readonly warnings: readonly AgentLaunchWarning[];
      readonly checkedAt: number;
    };

export interface AiState {
  readonly detection: DetectionState;
  /** The session shown in the panel. */
  readonly activeId: string | null;
}

export interface HistoryState {
  readonly loading: boolean;
  readonly listing: AgentSessionListing | null;
  readonly loadedAt: number | null;
}

export type PanelClosePolicy = "keep-running" | "terminate" | "ask";

const NO_SESSIONS: readonly AgentSession[] = [];
/** Detection results are reused this long by launches (settings changes re-check at once). */
const DETECTION_TTL_MS = 60_000;
const HISTORY_TTL_MS = 15_000;

export class AiController implements Disposable {
  readonly store = new Store<AiState>({ detection: { kind: "unchecked" }, activeId: null });
  readonly history = new Store<HistoryState>({ loading: false, listing: null, loadedAt: null });
  /** Mirrors the session manager's sessions once it exists (empty until then). */
  readonly sessions = new Store<readonly AgentSession[]>(NO_SESSIONS);
  private manager: AgentSessionManager | null = null;
  private readonly subscriptions = new DisposableStore();
  private area = { cols: 0, rows: 0 };
  private detecting: Promise<DetectionState> | null = null;
  private launching = false;

  constructor(private readonly ctx: AppContext) {
    this.subscriptions.add(
      ctx.config.onDidChange((event) => {
        // A changed executable or argument list changes what will run: check again at once.
        const touchesAi = event.changed.some((path) => path.startsWith("ai."));
        if (touchesAi && this.store.get().detection.kind === "done") void this.refreshDetection();
      }),
    );
  }

  get state(): AiState {
    return this.store.get();
  }

  /** The session manager, created on first use. */
  sessionManager(): AgentSessionManager {
    if (this.manager) return this.manager;
    const manager = this.ctx.services.agents;
    this.manager = manager;
    const sync = () => {
      const sessions = manager.state.get().sessions;
      this.sessions.set(sessions);
      const { activeId } = this.store.get();
      if (activeId !== null && !sessions.some((session) => session.id === activeId)) {
        this.store.update({ activeId: sessions.at(-1)?.id ?? null });
      }
      this.ctx.contextKeys.setMany({
        aiHasSession: sessions.length > 0,
        aiSessionRunning: sessions.some((session) => session.terminal.isRunning),
      });
    };
    this.subscriptions.add(toDisposable(manager.state.subscribe(sync)));
    this.subscriptions.add(toDisposable(manager.state.subscribe(() => this.saveSessions())));
    sync();
    return manager;
  }

  /** The configured provider (`ai.provider`), else the first registered one. */
  provider(): AgentProvider | undefined {
    const all = this.sessionManager().allProviders();
    const preferred = this.ctx.config.get("ai.provider");
    return all.find((provider) => provider.id === preferred) ?? all[0];
  }

  /** Display name without creating anything: used in labels before the first launch. */
  providerName(): string {
    if (!this.manager) return "Claude Code";
    return this.provider()?.displayName ?? "Claude Code";
  }

  active(): AgentSession | undefined {
    const sessions = this.sessions.get();
    return sessions.find((session) => session.id === this.store.get().activeId) ?? sessions.at(-1);
  }

  get(id: string | undefined): AgentSession | undefined {
    return id === undefined ? this.active() : this.sessions.get().find((session) => session.id === id);
  }

  runningSessions(): AgentSession[] {
    return this.sessions.get().filter((session) => session.terminal.isRunning);
  }

  /** The panel's terminal area, so new sessions start at the size they will be shown at. */
  noteArea(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.area = { cols, rows };
  }

  /** Runs the provider's detection (`claude --version`) and previews launch warnings. */
  refreshDetection(): Promise<DetectionState> {
    this.detecting ??= this.detect().finally(() => {
      this.detecting = null;
    });
    return this.detecting;
  }

  /**
   * Detects once; later calls reuse the result. Waits for the first paint: the agent panel is
   * open by default, and detection creates the agent services and runs `claude --version`,
   * which must not delay or compete with the first frame.
   */
  async ensureDetection(): Promise<DetectionState> {
    await this.ctx.lifecycle.firstPaint;
    const current = this.store.get().detection;
    if (current.kind === "done" || current.kind === "no-provider") return current;
    return this.refreshDetection();
  }

  private async detect(): Promise<DetectionState> {
    const provider = this.provider();
    if (!provider) {
      const state: DetectionState = { kind: "no-provider" };
      this.store.update({ detection: state });
      return state;
    }
    this.store.update({ detection: { kind: "checking" } });
    let detection: AgentDetection;
    try {
      detection = await provider.detect();
    } catch (error) {
      detection = { available: false, executable: null, version: null, problem: errorMessage(error) };
    }
    let warnings: readonly AgentLaunchWarning[] = [];
    if (detection.available) {
      try {
        warnings = provider.buildLaunch({ kind: "new" }, { cwd: this.ctx.workspace.root }).warnings;
      } catch {
        // buildLaunch reports the same problem detect() already described.
      }
    }
    const state: DetectionState = { kind: "done", detection, warnings, checkedAt: Date.now() };
    this.store.update({ detection: state });
    return state;
  }

  /** Shows the AI panel and gives it focus (the active session's terminal, if any). */
  showPanel(): void {
    this.ctx.layout.showAuxiliaryView(AI_VIEW_ID);
    this.ctx.focus.focus("auxiliary");
  }

  /**
   * Starts a session. Checks the CLI first (the start screen explains a missing one), and asks
   * for an explicit confirmation when the configured arguments carry warnings.
   */
  async launch(mode: AgentLaunchMode): Promise<AgentSession | undefined> {
    if (this.launching) return undefined;
    this.launching = true;
    try {
      const provider = this.provider();
      if (!provider) {
        this.ctx.notifications.error("No AI provider is available", "Lucy has no coding agent configured.");
        return undefined;
      }
      const current = this.store.get().detection;
      const fresh =
        current.kind === "done" &&
        current.detection.available &&
        Date.now() - current.checkedAt < DETECTION_TTL_MS;
      const state = fresh ? current : await this.refreshDetection();
      if (state.kind !== "done" || !state.detection.available) {
        // The start screen says what is missing and how to fix it.
        this.showPanel();
        return undefined;
      }
      const cwd = this.ctx.workspace.root;
      let launch: AgentLaunch;
      try {
        launch = provider.buildLaunch(mode, { cwd });
      } catch (error) {
        this.ctx.notifications.error(`Could not start ${provider.displayName}`, errorMessage(error));
        return undefined;
      }
      if (launch.warnings.length > 0) {
        const confirmed = await this.ctx.dialogs.confirm({
          title: `Start ${provider.displayName} with these arguments?`,
          message: launch.warnings.map((warning) => warning.message).join(" "),
          confirmLabel: "Start Anyway",
          danger: true,
        });
        if (!confirmed) return undefined;
      }
      let session: AgentSession;
      try {
        session = this.sessionManager().create({
          providerId: provider.id,
          mode,
          cwd,
          cols: this.area.cols || undefined,
          rows: this.area.rows || undefined,
          // The panel's terminal starts the process once its emulator is connected.
          autoStart: false,
          launch,
          ...this.persistentSpawn(provider.id, launch, this.nextAgentNumber()),
        });
      } catch (error) {
        this.ctx.notifications.error(`Could not start ${provider.displayName}`, errorMessage(error));
        return undefined;
      }
      this.store.update({ activeId: session.id });
      this.showPanel();
      return session;
    } finally {
      this.launching = false;
    }
  }

  activate(id: string): void {
    if (this.get(id)) this.store.update({ activeId: id });
  }

  /** Shows a session in the panel and focuses its terminal. */
  focusSession(id: string): void {
    this.activate(id);
    this.showPanel();
  }

  async restart(id?: string): Promise<void> {
    const session = this.get(id);
    if (!session) return;
    if (session.terminal.isRunning) {
      const confirmed = await this.ctx.dialogs.confirm({
        title: `Restart "${session.title}"?`,
        message: `${this.providerName()} is stopped and started again with the same command.`,
        confirmLabel: "Restart",
        danger: true,
      });
      if (!confirmed) return;
    }
    this.activate(session.id);
    await session.terminal.restart();
  }

  /** Closes a session; a running one is stopped after confirmation (unless `confirm: false`). */
  async close(id?: string, options: { confirm?: boolean } = {}): Promise<boolean> {
    const session = this.get(id);
    if (!session) return false;
    if (session.terminal.isRunning && (options.confirm ?? true)) {
      const confirmed = await this.ctx.dialogs.confirm({
        title: `Stop "${session.title}"?`,
        message: `${this.providerName()} is still running. Its conversation stays in its history, so you can resume it later from AI Sessions.`,
        confirmLabel: "Stop Session",
        danger: true,
      });
      if (!confirmed) return false;
    }
    this.sessionManager().close(session.id);
    return true;
  }

  async rename(id?: string): Promise<void> {
    const session = this.get(id);
    if (!session) return;
    const title = await this.ctx.dialogs.prompt({
      title: "Rename Session",
      value: session.title,
      placeholder: "Session name",
      confirmLabel: "Rename",
      validate: (value) => (value.trim() ? undefined : "Enter a name"),
    });
    if (title === undefined) return;
    this.sessionManager().rename(session.id, title);
  }

  /** What happens to running sessions when the panel is hidden, per `ai.onPanelClose`. */
  policy(): PanelClosePolicy {
    return this.ctx.config.get("ai.onPanelClose");
  }

  /** Applies the panel-close policy; called when the user hides the AI panel. */
  async onPanelHidden(): Promise<void> {
    const running = this.runningSessions();
    if (running.length === 0) return;
    const name = this.providerName();
    const policy = this.policy();
    if (policy === "keep-running") {
      this.ctx.hints.flash({
        text: `${name} keeps running in the background`,
        keys: this.ctx.keybindingFor("view.focusAiPanel"),
      });
      return;
    }
    if (policy === "ask") {
      const confirmed = await this.ctx.dialogs.confirm({
        title:
          running.length === 1
            ? `Stop the running ${name} session?`
            : `Stop ${running.length} running sessions?`,
        message: "The AI panel is hidden. Stopped sessions can be resumed later from AI Sessions.",
        confirmLabel: running.length === 1 ? "Stop Session" : "Stop Sessions",
        cancelLabel: "Keep Running",
        danger: true,
      });
      if (!confirmed) return;
    }
    for (const session of running) this.sessionManager().close(session.id);
    this.ctx.hints.flash({
      text: running.length === 1 ? `Stopped the ${name} session` : `Stopped ${running.length} sessions`,
    });
  }

  /**
   * With persistence: the tmux spawner and stable id for a session (`lucy-<ws>-a<n>`).
   * Without: nothing, and the manager's own spawner is used.
   */
  private persistentSpawn(
    providerId: string,
    launch: AgentLaunch,
    number: number,
  ): { id?: string; spawn?: PtySpawner; persistent?: boolean } {
    const persistence = sessionPersistence(this.ctx);
    const backend = persistence.backend();
    if (!backend) return {};
    const name = persistence.sessionName("a", number);
    return {
      id: name,
      persistent: true,
      spawn: backend.spawner({
        name,
        argv: launch.argv,
        cwd: launch.cwd,
        meta: { kind: "agent", number: String(number), provider: providerId },
      }),
    };
  }

  private nextAgentNumber(): number {
    const persistence = sessionPersistence(this.ctx);
    const used = [
      ...this.sessions.get().map((session) => session.id),
      ...persistence.saved().agents.map((agent) => agent.name),
    ]
      .map((id) => /-a(\d+)$/.exec(id)?.[1])
      .map(Number)
      .filter(Number.isFinite);
    return Math.max(0, ...used) + 1;
  }

  /** Persistent sessions are saved so they come back after a restart (even a reboot). */
  private saveSessions(): void {
    const persistence = sessionPersistence(this.ctx);
    const agents = this.sessions
      .get()
      .filter((session) => session.terminal.persistent)
      .map((session) => ({
        name: session.id,
        title: session.title,
        providerId: session.providerId,
        createdAt: session.createdAt,
      }));
    if (JSON.stringify(persistence.saved().agents) !== JSON.stringify(agents)) persistence.save({ agents });
  }

  /**
   * Brings back the agent sessions of the last run: still running ones are reattached, ended
   * ones show how they ended, and ones lost with the tmux server (a reboot) come back as ended
   * entries whose Restart continues the last conversation (`--continue`).
   */
  async restore(): Promise<number> {
    const persistence = sessionPersistence(this.ctx);
    const saved = persistence.saved().agents;
    if (saved.length === 0) return 0;
    const backend = persistence.backend();
    if (!backend) return 0;
    const live = (await persistence.list()).filter((session) => session.meta.kind === "agent");
    const manager = this.sessionManager();
    const cwd = this.ctx.workspace.root;
    const names = [...new Set([...saved.map((entry) => entry.name), ...live.map((session) => session.name)])];
    let restored = 0;
    for (const name of names) {
      if (this.get(name)) continue;
      const entry = saved.find((candidate) => candidate.name === name);
      const info = live.find((session) => session.name === name);
      const provider = manager.provider(entry?.providerId ?? info?.meta.provider ?? "") ?? this.provider();
      if (!provider) continue;
      let launch: AgentLaunch;
      try {
        launch = provider.buildLaunch({ kind: "continue" }, { cwd });
      } catch {
        continue; // The CLI is gone; the saved entry stays until it can be restored.
      }
      const number = Number(/-a(\d+)$/.exec(name)?.[1] ?? Number.NaN);
      const ended = !info
        ? {
            exit: { code: null, signal: null },
            reason:
              "It stopped while Lucy was closed, for example after a restart. Continue picks up its last conversation.",
          }
        : info.dead
          ? { exit: info.exit ?? { code: null, signal: null } }
          : undefined;
      manager.create({
        providerId: provider.id,
        mode: { kind: "continue" },
        cwd,
        title: entry?.title,
        createdAt: entry?.createdAt,
        launch,
        autoStart: false,
        ended,
        ...this.persistentSpawn(
          provider.id,
          launch,
          Number.isFinite(number) ? number : this.nextAgentNumber(),
        ),
        id: name,
      });
      restored++;
    }
    const first = this.sessions.get()[0];
    if (first) this.store.update({ activeId: first.id });
    return restored;
  }

  /** Persistent sessions that keep running in the background when Lucy quits. */
  runningPersistent(): number {
    return this.runningSessions().filter((session) => session.terminal.persistent).length;
  }

  /** Quit guard: says plainly what quitting does to running sessions. */
  async confirmQuit(): Promise<boolean> {
    const running = this.runningSessions();
    if (running.length === 0) return true;
    const name = this.providerName();
    if (running.every((session) => session.terminal.persistent)) {
      const total = sessionPersistence(this.ctx).running();
      return this.ctx.dialogs.confirm({
        title: "Quit Lucy?",
        message: `${total} ${total === 1 ? "session keeps" : "sessions keep"} running in the background; open Lucy again to continue. End them with End Background Sessions.`,
        confirmLabel: "Quit",
      });
    }
    return this.ctx.dialogs.confirm({
      title:
        running.length === 1
          ? `Quit while ${name} is running?`
          : `Quit while ${running.length} sessions are running?`,
      message:
        "Quitting stops them. Their conversations stay in their history; resume them later from AI Sessions.",
      confirmLabel: "Quit",
      danger: true,
    });
  }

  /** Loads previous sessions of this workspace (read-only, best effort). */
  async refreshHistory(options: { force?: boolean } = {}): Promise<void> {
    const current = this.history.get();
    if (current.loading) return;
    if (!options.force && current.loadedAt !== null && Date.now() - current.loadedAt < HISTORY_TTL_MS) return;
    const provider = this.provider();
    if (!provider?.listSessions) {
      this.history.set({
        loading: false,
        loadedAt: Date.now(),
        listing: {
          sessions: [],
          problem: `${provider?.displayName ?? "This agent"} does not provide a session history.`,
        },
      });
      return;
    }
    this.history.update({ loading: true });
    let listing: AgentSessionListing;
    try {
      listing = await provider.listSessions(this.ctx.workspace.root, { limit: 50 });
    } catch (error) {
      listing = { sessions: [], problem: errorMessage(error) };
    }
    this.history.set({ loading: false, listing, loadedAt: Date.now() });
  }

  /**
   * Picks a prompt template and pastes it into the active session's input. Never submits it:
   * the user reviews the text and presses Enter.
   */
  async insertTemplate(): Promise<void> {
    const session = this.active();
    const name = this.providerName();
    if (!session?.terminal.isRunning) {
      this.ctx.notifications.show({
        severity: "info",
        title: `No ${name} session is running`,
        message: "Start a session, then insert a prompt template.",
        actions: [{ label: "Start Session", run: () => void this.launch({ kind: "new" }) }],
      });
      return;
    }
    const context = promptContextFrom(this.ctx.editors.active);
    const git = this.ctx.services.createdServices.includes("git") ? this.ctx.services.git.store.get() : null;
    const item = await this.ctx.quickPick.pick({
      items: templateItems(context, git),
      title: "Insert Prompt Template",
      placeholder: `Pasted into ${name}; nothing is sent until you press Enter`,
      matchOnDescription: true,
    });
    if (!item || item.disabled) return;
    const text = buildPrompt(item.id as PromptTemplateId, context);
    const result = this.sessionManager().pastePrompt(session.id, text);
    if (!result.sent) {
      this.ctx.notifications.warn("The prompt was not pasted", `${name} is no longer running.`);
      return;
    }
    this.focusSession(session.id);
  }

  dispose(): void {
    // Quitting detaches persistent sessions (they keep running in tmux) before the session
    // manager, disposed later with the domain services, would end them.
    for (const session of this.sessions.get()) {
      if (session.terminal.persistent) session.terminal.dispose({ kill: false });
    }
    this.subscriptions.dispose();
  }
}
