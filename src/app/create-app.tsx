/**
 * The composition root, used by `main.ts` and by tests (`mountApp`). It builds the service
 * container, wires services to each other and to the renderer, activates features, restores
 * the workspace, and returns the React root element.
 *
 * Nothing here starts a process, a watcher, a PTY or a Tree-sitter worker: domain services
 * are lazy, and `markFirstPaint()` starts Git status and the watcher after the first frame.
 */
import { CliRenderEvents, type CliRenderer, EmbeddedTerminalRenderable } from "@opentui/core";
import { extend } from "@opentui/react";
import type { ReactNode } from "react";
import { CommandRegistry } from "@/core/commands";
import type { ConfigService } from "@/core/config";
import { errorMessage } from "@/core/errors";
import { type Disposable, DisposableStore, toDisposable } from "@/core/events";
import {
  type Chord,
  ContextKeys,
  chordToString,
  DEFAULT_KEYBINDINGS,
  formatChord,
  KeybindingRegistry,
  LEADER_KEY,
  parseKeySequence,
  sequenceSupport,
  sequenceToString,
} from "@/core/keybindings";
import { type Logger, log as rootLog } from "@/core/log";
import { type AppDirs, tildify } from "@/core/paths";
import type { ResolvedWorkspace, Workspace, WorkspaceNotice } from "@/core/workspace";
import { WorkspaceStateStore } from "@/core/workspace";
import { ComponentGallery } from "../ui/gallery/component-gallery";
import { Workbench } from "../ui/shell/workbench";
import { ThemeService } from "../ui/theme/ui-theme";
import type { AppContext, AppEnvironment, Lifecycle, StartupTimings } from "./app-context";
import { registerQuickPickProviders } from "./commands/quick-pick-providers";
import { registerWorkbenchCommands } from "./commands/workbench-commands";
import { type DomainServiceOverrides, DomainServices } from "./domain/domain-services";
import type { FeatureModule } from "./feature";
import { FEATURES } from "./features";
import { KeyRouter } from "./input/key-router";
import { PersistedState } from "./persistence";
import { AppProvider } from "./react";
import { DialogService } from "./workbench/dialogs";
import { EditorService } from "./workbench/editors";
import { FocusService, type FocusZone } from "./workbench/focus";
import { HintService } from "./workbench/hints";
import { LayoutService } from "./workbench/layout";
import type { LayoutDefaults } from "./workbench/layout-compute";
import { MenuService } from "./workbench/menus";
import { NotificationService } from "./workbench/notifications";
import { OverlayService } from "./workbench/overlays";
import { QuickPickService } from "./workbench/quick-pick";
import { type Clock, derived, systemClock } from "./workbench/readable";
import { StatusBarService } from "./workbench/status-bar";
import { ViewRegistry } from "./workbench/views";

export interface CreateAppOptions {
  renderer: CliRenderer;
  workspace: Workspace | ResolvedWorkspace;
  dirs: AppDirs;
  config: ConfigService;
  env?: Partial<AppEnvironment>;
  /** Feature modules; default: `FEATURES` from `src/app/features.ts`. */
  features?: readonly FeatureModule[];
  /** Adapter seams: Git adapter factory, PTY spawn, agent providers, watcher, tool env. */
  overrides?: DomainServiceOverrides;
  clock?: Clock;
  /** Restore layout and tabs (also requires the `workspace.restore` setting). Default true. */
  restore?: boolean;
  /** Environment for color-mode and icon detection. Default `process.env`. */
  terminalEnv?: Record<string, string | undefined>;
  /** Debounce of workspace state saves. Default 500 ms. */
  stateSaveDelayMs?: number;
  /** The single shutdown path; default disposes the app. */
  onQuit?: () => void | Promise<void>;
  /** Ctrl+Z job control; default shows that suspending is unavailable. */
  onSuspend?: () => void | Promise<void>;
  /** OpenTUI console overlay toggle for `--debug`. */
  toggleConsole?: () => void;
  /** Startup phase recorder shared with `main.ts`. */
  timings?: { mark(phase: string): void; marks(): StartupTimings["marks"] };
  log?: Logger;
}

export interface CreatedApp {
  readonly context: AppContext;
  /** Mount this with `createRoot(renderer).render(element)`. */
  readonly element: ReactNode;
  /** Call after the first frame: resolves `lifecycle.firstPaint` and starts background services. */
  markFirstPaint(options?: { startBackground?: boolean }): void;
  /** Flushes state and releases everything. Idempotent. Does not destroy the renderer. */
  dispose(): Promise<void>;
}

let customElementsRegistered = false;

/** Registers renderables that are not OpenTUI intrinsics. Idempotent; never at import time. */
export function registerCustomElements(): void {
  if (customElementsRegistered) return;
  customElementsRegistered = true;
  extend({ "embedded-terminal": EmbeddedTerminalRenderable });
}

declare module "@opentui/react" {
  interface OpenTUIComponents {
    "embedded-terminal": typeof EmbeddedTerminalRenderable;
  }
}

function isResolved(workspace: Workspace | ResolvedWorkspace): workspace is ResolvedWorkspace {
  return "workspace" in workspace;
}

/** A small timing recorder (process-relative milliseconds). */
export function createTimings(): { mark(phase: string): void; marks(): StartupTimings["marks"] } {
  const marks: { phase: string; ms: number }[] = [];
  return {
    mark: (phase) => marks.push({ phase, ms: Math.round(performance.now() * 10) / 10 }),
    marks: () => [...marks],
  };
}

const LEADER_FOLLOW_UPS = "P palette · H J K L focus · E F G views · Q quit · again: send to terminal";

export async function createApp(options: CreateAppOptions): Promise<CreatedApp> {
  const { renderer, config } = options;
  const resolved = isResolved(options.workspace) ? options.workspace : null;
  const workspace = resolved ? resolved.workspace : (options.workspace as Workspace);
  const log = options.log ?? rootLog.child("app");
  const clock = options.clock ?? systemClock;
  const timings = options.timings ?? createTimings();
  const disposables = new DisposableStore();
  const features = options.features ?? FEATURES;
  registerCustomElements();

  const env: AppEnvironment = {
    version: options.env?.version ?? "0.0.0",
    demo: options.env?.demo ?? false,
    debug: options.env?.debug ?? false,
    platform: options.env?.platform ?? process.platform,
  };

  // ------------------------------------------------------------ core services
  const contextKeys = disposables.add(new ContextKeys());
  const commands = disposables.add(new CommandRegistry({ context: contextKeys }));
  const keybindings = disposables.add(
    new KeybindingRegistry({
      defaults: [...DEFAULT_KEYBINDINGS, ...features.flatMap((feature) => feature.keybindings ?? [])],
      mode: config.get("keybindings.mode"),
      isKnownCommand: (id) => commands.has(id),
    }),
  );
  const themes = disposables.add(
    new ThemeService({ config, env: options.terminalEnv ?? process.env, styleOwner: renderer.nativeScene }),
  );
  const workspaceState = disposables.add(
    new WorkspaceStateStore(options.dirs, workspace, { debounceMs: options.stateSaveDelayMs }),
  );

  // ------------------------------------------------------- workbench services
  const overlays = disposables.add(new OverlayService(contextKeys));
  const notifications = disposables.add(new NotificationService(clock));
  const hints = disposables.add(new HintService(clock));
  const focus = disposables.add(new FocusService(contextKeys));
  const views = disposables.add(new ViewRegistry());
  const layoutDefaults = derived(
    [config.store] as const,
    (): LayoutDefaults => ({
      sidebarWidth: config.get("layout.sidebarWidth"),
      auxiliaryWidth: config.get("layout.aiPanelWidth"),
      bottomHeight: config.get("layout.bottomPanelHeight"),
      sidebarSide: config.get("layout.sidebarSide"),
      showCommandBar: config.get("layout.showCommandBar"),
      showStatusBar: config.get("layout.showStatusBar"),
      showActivityBar: config.get("layout.showActivityBar"),
    }),
  );
  const layout = disposables.add(
    new LayoutService({
      defaults: layoutDefaults,
      focusedZone: focus.zone,
      hasAuxiliaryView: views.hasAuxiliary,
      viewport: { width: renderer.width, height: renderer.height },
    }),
  );
  const editors = disposables.add(
    new EditorService({
      previewEnabled: () => config.get("editor.previewTabs"),
      titleFor: (input) => views.editorView(input.kind)?.title?.(input),
    }),
  );
  const statusBar = disposables.add(new StatusBarService());
  const dialogs = disposables.add(new DialogService(overlays));
  const quickPick = disposables.add(
    new QuickPickService(overlays, log.child("quick-pick"), (title) => notifications.error(title)),
  );
  const menus = disposables.add(
    new MenuService(overlays, {
      execute: (command, args) => commands.execute(command, args),
      onError: (title) => notifications.error(title),
    }),
  );
  const persisted = disposables.add(
    new PersistedState(workspaceState, log, (message) =>
      notifications.warn(
        "Could not save the workspace layout",
        `${message} Layout and tabs may not be restored next time.`,
      ),
    ),
  );
  const services = new DomainServices({
    workspace,
    dirs: options.dirs,
    config,
    log: log.child("services"),
    overrides: options.overrides,
    onBackgroundError: (title, message) => notifications.warn(title, message),
  });

  // ------------------------------------------------------------ keybindings
  const kitty = () => renderer.capabilities?.kitty_keyboard === true;
  const keybindingFor = (command: string): string | undefined => {
    const support = { kittyKeyboard: kitty(), platform: env.platform };
    const sequences = keybindings.bindingsFor(command, support);
    if (sequences.length === 0) return undefined;
    // Flow control (Ctrl+S, Ctrl+Q) cannot interfere: the renderer puts the tty in raw mode.
    const works = sequences.filter((s) => {
      const result = sequenceSupport(s, support);
      return result.ok || result.code === "flow-control";
    });
    // Prefer a single chord that works here (Ctrl+Shift+E with kitty), then any that works.
    const best = works.find((s) => s.length === 1) ?? works[0] ?? sequences[0];
    return best ? sequenceToString(best) : undefined;
  };
  const keybindingLabel = (command: string): string | undefined => {
    const keys = keybindingFor(command);
    return keys ? formatChord(keys, "text") : undefined;
  };
  const applyUserBindings = () => {
    keybindings.setMode(config.get("keybindings.mode"));
    const problems = keybindings.setUserBindings(config.get("keybindings.bindings"));
    if (problems.length > 0) {
      notifications.warn(
        problems.length === 1
          ? "A custom shortcut was ignored"
          : `${problems.length} custom shortcuts were ignored`,
        problems[0]?.message,
      );
    }
  };

  // --------------------------------------------------------------- lifecycle
  let resolveFirstPaint: () => void = () => {};
  const firstPaint = new Promise<void>((resolve) => {
    resolveFirstPaint = resolve;
  });
  let disposed: Promise<void> | null = null;
  const quitGuards = new Set<() => boolean | Promise<boolean>>();
  let guarding: Promise<boolean> | null = null;
  // Guards run one after another; a second Ctrl+Q while one asks waits for the same answer.
  const quitAllowed = async (): Promise<boolean> => {
    for (const guard of [...quitGuards]) {
      try {
        if (!(await guard())) return false;
      } catch (error) {
        log.warn("A quit guard failed; quitting anyway", { error });
      }
    }
    return true;
  };
  const lifecycle: Lifecycle = {
    firstPaint,
    get timings() {
      return { marks: timings.marks() };
    },
    mark: (phase) => timings.mark(phase),
    quit: async () => {
      guarding ??= quitAllowed().finally(() => {
        guarding = null;
      });
      if (!(await guarding)) return;
      if (options.onQuit) await options.onQuit();
      else await created.dispose();
    },
    addQuitGuard: (guard) => {
      quitGuards.add(guard);
      return toDisposable(() => quitGuards.delete(guard));
    },
    suspend: async () => {
      if (options.onSuspend) await options.onSuspend();
      else hints.flash({ text: "Suspending is not available here", tone: "muted" });
    },
    // A foreground program (the external editor) gets the real terminal; OpenTUI restores
    // the main screen and cooked mode on suspend and redraws everything on resume.
    suspendTerminal: () => renderer.suspend(),
    resumeTerminal: () => renderer.resume(),
  };

  const context: AppContext = {
    workspace,
    dirs: options.dirs,
    env,
    log,
    config,
    themes,
    commands,
    keybindings,
    contextKeys,
    workspaceState,
    persisted,
    layout,
    focus,
    editors,
    views,
    statusBar,
    notifications,
    dialogs,
    quickPick,
    menus,
    overlays,
    hints,
    services,
    lifecycle,
    run: async (command, args) => {
      try {
        await commands.execute(command, args);
      } catch {
        // Reported by the `onDidFail` listener below.
      }
    },
    keybindingLabel,
    keybindingFor,
    track: (disposable) => {
      disposables.add(disposable);
    },
  };

  // ------------------------------------------------------------------ wiring
  disposables.add(
    commands.onDidFail(({ id, error }) => {
      log.error("Command failed", { id, error });
      const title = commands.get(id)?.title ?? id;
      notifications.error(`Could not run "${title}"`, errorMessage(error));
    }),
  );

  focus.setLayout({
    isAvailable: (zone: FocusZone) => {
      const state = layout.state;
      if (state.zen) return zone === "editor";
      if (zone === "sidebar") return state.sidebar.visible && views.state.sidebar.length > 0;
      if (zone === "auxiliary") return state.auxiliary.visible && views.state.auxiliary.length > 0;
      if (zone === "bottom") return state.bottom.visible;
      return true;
    },
    order: () =>
      layout.effective.get().sidebarSide === "left"
        ? ["sidebar", "editor", "bottom", "auxiliary"]
        : ["auxiliary", "editor", "bottom", "sidebar"],
    columns: () =>
      layout.effective.get().sidebarSide === "left"
        ? [["sidebar"], ["editor", "bottom"], ["auxiliary"]]
        : [["auxiliary"], ["editor", "bottom"], ["sidebar"]],
  });
  focus.setRenderableFocusReleaser(() => {
    // Inside an overlay the overlay's own input keeps focus.
    if (overlays.layers.length > 0) return;
    renderer.currentFocusedRenderable?.blur();
  });
  disposables.add(
    focus.onDidChange(({ zone }) => {
      if (zone === "sidebar" || zone === "auxiliary") layout.noteSide(zone);
    }),
  );
  // A zone that disappears (toggled off, zen) hands focus back to the editor.
  disposables.add(
    toDisposable(
      layout.store.subscribe(() => {
        if (!focus.isAvailable(focus.current)) focus.focus("editor");
      }),
    ),
  );
  disposables.add(
    overlays.onDidChange((layers) => {
      if (layers.length === 0) focus.restore();
    }),
  );
  disposables.add(
    toDisposable(
      layout.store.subscribe(() => {
        const state = layout.state;
        contextKeys.setMany({
          sidebarView: state.sidebar.visible ? state.sidebar.view : undefined,
          zenMode: state.zen,
        });
      }),
    ),
  );
  contextKeys.setMany({ sidebarView: layout.state.sidebar.view });

  const syncWidgetFocus = () => {
    contextKeys.set("inputFocus", renderer.currentFocusedEditor != null);
  };
  renderer.on(CliRenderEvents.FOCUSED_EDITOR, syncWidgetFocus);
  disposables.add(toDisposable(() => renderer.off(CliRenderEvents.FOCUSED_EDITOR, syncWidgetFocus)));

  const onResize = (width: number, height: number) => layout.setViewport(width, height);
  renderer.on(CliRenderEvents.RESIZE, onResize);
  disposables.add(toDisposable(() => renderer.off(CliRenderEvents.RESIZE, onResize)));
  layout.setViewport(renderer.width, renderer.height);

  const applyBackground = () => renderer.setBackgroundColor(themes.current.colors.bg.base);
  applyBackground();
  disposables.add(themes.onDidChange(applyBackground));

  const router = disposables
    .add(
      new KeyRouter({
        renderer,
        keybindings,
        contextKeys,
        commands,
        focus,
        overlays,
        hints,
        log: log.child("keys"),
        onSuspend: () => void lifecycle.suspend(),
        quitLabel: () => keybindingLabel("app.quit"),
        describePending: (prefix: Chord) => {
          const label = formatChord(prefix, "text");
          if (chordToString(prefix) === chordToString(parseKeySequence(LEADER_KEY)[0] as Chord)) {
            return `${label}  ${LEADER_FOLLOW_UPS}`;
          }
          return `${label} was pressed; waiting for the second key`;
        },
      }),
    )
    .install();

  // Narrow drawers close with Escape, returning to the editor.
  for (const zone of ["sidebar", "auxiliary"] as const) {
    disposables.add(
      focus.registerKeyHandler(zone, (stroke) => {
        if (stroke.key !== "escape" || layout.effective.get().mode !== "narrow") return false;
        focus.focus("editor");
        return true;
      }),
    );
  }

  disposables.add(registerWorkbenchCommands(context, { toggleConsole: options.toggleConsole }));
  disposables.add(registerQuickPickProviders(context));
  // The live component gallery, for building and reviewing views.
  disposables.add(
    views.registerEditorView({
      kind: "gallery",
      icon: "extensions",
      title: () => "Component Gallery",
      breadcrumb: () => ["Developer", "Component Gallery"],
      component: () => <ComponentGallery />,
    }),
  );
  disposables.add(
    commands.register({
      id: "developer.showComponentGallery",
      title: "Show Component Gallery",
      category: "Developer",
      run: () => {
        editors.open({ kind: "gallery", resource: "gallery" });
        focus.focus("editor");
      },
    }),
  );

  const themeItem = statusBar.register({
    id: "workbench.theme",
    alignment: "right",
    priority: 10,
    text: themes.current.name,
    tooltip: "Change the color theme",
    command: "theme.select",
  });
  disposables.add(themeItem);
  disposables.add(themes.onDidChange((theme) => themeItem.update({ text: theme.name })));

  // ---------------------------------------------------------------- features
  timings.mark("features:start");
  const featureDisposables: Disposable[] = [];
  for (const feature of features) {
    try {
      const result = feature.activate(context);
      if (result) featureDisposables.push(result);
    } catch (error) {
      log.error("Feature failed to activate", { feature: feature.id, error });
      notifications.error(`The ${feature.id} feature failed to start`, errorMessage(error));
    }
  }
  timings.mark("features:activated");
  applyUserBindings();
  disposables.add(
    config.onDidChange((event) => {
      if (event.changed.some((path) => path.startsWith("keybindings."))) applyUserBindings();
    }),
  );

  // ----------------------------------------------------------------- restore
  const restoreEnabled = (options.restore ?? true) && config.get("workspace.restore");
  if (restoreEnabled) {
    try {
      const loaded = await workspaceState.load();
      persisted.load(loaded.state);
      layout.restore(loaded.state.layout);
      editors.restore(loaded.state.openFiles, loaded.state.activeFile);
      commands.setRecent(loaded.state.commandMru);
      if (loaded.source === "recovered" && loaded.message) {
        notifications.warn("Saved layout could not be read", loaded.message);
      }
    } catch (error) {
      log.warn("Restoring workspace state failed", { error });
      notifications.warn("Could not restore the last session", errorMessage(error));
    }
  }
  if (resolved?.openFile) {
    editors.open({ kind: "file", resource: resolved.openFile });
    persisted.noteRecentFile(resolved.openFile);
  }
  for (const notice of resolved?.notices ?? ([] as WorkspaceNotice[])) {
    notifications.show({ severity: notice.level === "warning" ? "warning" : "info", title: notice.message });
  }
  if (config.problems.length > 0) {
    const first = config.problems[0];
    // A problem without a setting path is about the whole file (a TOML syntax error): saying
    // "a setting was ignored" would be wrong, and its message already names the file.
    const wholeFile = first !== undefined && first.path === "";
    notifications.show({
      key: "config-problems",
      severity: "warning",
      title: wholeFile
        ? "config.toml has a syntax error"
        : config.problems.length === 1
          ? "A setting in config.toml was ignored"
          : `${config.problems.length} settings in config.toml were ignored`,
      message: wholeFile
        ? `${first.message}${first.line ? ` See line ${first.line}.` : ""}`
        : first
          ? `${first.message} (${tildify(config.path)})`
          : tildify(config.path),
      // The Settings editor lists every problem and opens the file.
      actions: commands.has("settings.open")
        ? [{ label: "Show Problems", run: () => void context.run("settings.open") }]
        : undefined,
    });
  }
  timings.mark("restore:done");

  // Persist layout, tabs and the command MRU from now on.
  const persist = () => {
    persisted.update({
      layout: layout.toPersisted(),
      ...editors.toPersisted(),
      commandMru: commands.getRecent(),
    });
  };
  persisted.enable();
  disposables.add(toDisposable(layout.store.subscribe(persist)));
  disposables.add(toDisposable(editors.store.subscribe(persist)));
  disposables.add(commands.onDidExecute(({ ok }) => ok && persist()));
  // Quick Open lists recently opened files first.
  disposables.add(
    toDisposable(
      editors.store.subscribe(() => {
        const active = editors.active;
        if (
          active?.kind === "file" &&
          active.resource &&
          persisted.state.recentFiles[0] !== active.resource
        ) {
          persisted.noteRecentFile(active.resource);
        }
      }),
    ),
  );

  const element = (
    <AppProvider value={context}>
      <Workbench />
    </AppProvider>
  );

  const created: CreatedApp = {
    context,
    element,
    markFirstPaint: ({ startBackground = true } = {}) => {
      timings.mark("first-paint");
      resolveFirstPaint();
      if (startBackground) services.startBackground();
    },
    dispose: () => {
      disposed ??= (async () => {
        quickPick.close();
        menus.close();
        dialogs.dispose();
        await persisted.flush();
        for (const feature of featureDisposables.reverse()) {
          try {
            feature.dispose();
          } catch (error) {
            log.warn("Disposing a feature failed", { error });
          }
        }
        router.dispose();
        // Kills PTY trees, stops the watcher and the Tree-sitter worker.
        services.dispose();
        disposables.dispose();
        await config.flush();
      })();
      return disposed;
    },
  };
  return created;
}
