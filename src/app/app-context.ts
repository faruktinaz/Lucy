/**
 * The service container every feature and component receives. Features get it in
 * `activate(ctx)`; components read it with `useApp()`.
 */
import type { CommandRegistry } from "@/core/commands";
import type { ConfigService } from "@/core/config";
import type { Disposable } from "@/core/events";
import type { ContextKeys, KeybindingRegistry } from "@/core/keybindings";
import type { Logger } from "@/core/log";
import type { AppDirs } from "@/core/paths";
import type { Workspace, WorkspaceStateStore } from "@/core/workspace";
import type { ThemeService } from "../ui/theme/ui-theme";
import type { DomainServices } from "./domain/domain-services";
import type { PersistedState } from "./persistence";
import type { DialogService } from "./workbench/dialogs";
import type { EditorService } from "./workbench/editors";
import type { FocusService } from "./workbench/focus";
import type { HintService } from "./workbench/hints";
import type { LayoutService } from "./workbench/layout";
import type { MenuService } from "./workbench/menus";
import type { NotificationService } from "./workbench/notifications";
import type { OverlayService } from "./workbench/overlays";
import type { QuickPickService } from "./workbench/quick-pick";
import type { StatusBarService } from "./workbench/status-bar";
import type { ViewRegistry } from "./workbench/views";

export interface AppEnvironment {
  readonly version: string;
  /** `--demo`: a throwaway workspace with isolated config and state. */
  readonly demo: boolean;
  /** `--debug`: console overlay and debug logging. */
  readonly debug: boolean;
  readonly platform: string;
}

/** Startup phases with their time since process start, in milliseconds. */
export interface StartupTimings {
  readonly marks: readonly { readonly phase: string; readonly ms: number }[];
}

export interface Lifecycle {
  /** Resolves after the first frame was painted. */
  readonly firstPaint: Promise<void>;
  readonly timings: StartupTimings;
  /** Records a startup phase. */
  mark(phase: string): void;
  /** Quits the app through the single shutdown path, unless a quit guard cancels it. */
  quit(): Promise<void>;
  /**
   * Registers a check that runs before `quit()` (for example "2 agent sessions are running,
   * quit anyway?"). Returning false cancels the quit. Signals and fatal errors never ask.
   */
  addQuitGuard(guard: () => boolean | Promise<boolean>): Disposable;
  /** Suspends to the shell (Ctrl+Z job control). */
  suspend(): Promise<void>;
  /**
   * Hands the terminal to a foreground program (the external editor): stops rendering and
   * input and restores the terminal's normal mode. Always pair with `resumeTerminal()`.
   */
  suspendTerminal(): Promise<void>;
  /** Takes the terminal back after `suspendTerminal()` and repaints. */
  resumeTerminal(): Promise<void>;
}

export interface AppContext {
  readonly workspace: Workspace;
  readonly dirs: AppDirs;
  readonly env: AppEnvironment;
  readonly log: Logger;

  // Core services.
  readonly config: ConfigService;
  readonly themes: ThemeService;
  readonly commands: CommandRegistry;
  readonly keybindings: KeybindingRegistry;
  readonly contextKeys: ContextKeys;
  readonly workspaceState: WorkspaceStateStore;
  /** The workspace's restore state in memory; features keep their slices here. */
  readonly persisted: PersistedState;

  // Workbench services.
  readonly layout: LayoutService;
  readonly focus: FocusService;
  readonly editors: EditorService;
  readonly views: ViewRegistry;
  readonly statusBar: StatusBarService;
  readonly notifications: NotificationService;
  readonly dialogs: DialogService;
  readonly quickPick: QuickPickService;
  readonly menus: MenuService;
  readonly overlays: OverlayService;
  readonly hints: HintService;

  /** Git, search, syntax, file operations, terminals and agents; created on first use. */
  readonly services: DomainServices;
  readonly lifecycle: Lifecycle;

  /** Runs a command and reports a failure as a toast instead of throwing. */
  run(command: string, args?: unknown): Promise<void>;
  /** The formatted primary keybinding of a command for this terminal, e.g. `Ctrl+K E`. */
  keybindingLabel(command: string): string | undefined;
  /** The primary key sequence of a command for this terminal, e.g. `ctrl+k e`. */
  keybindingFor(command: string): string | undefined;
  /** Registers a disposable to be released on shutdown. */
  track(disposable: Disposable): void;
}
