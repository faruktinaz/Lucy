# Architecture

How Lucy Workspace is put together, and how to build a feature on it. Everything named here
exists in the code; file paths are relative to the repository root.

## 1. Layers

```
src/core       kernel: events, Store, errors, log, process, paths, text, config, keybindings,
               commands, workspace state            (no UI, no adapters)
src/themes     design tokens, four themes, color-mode degradation, icon tiers
src/adapters   git, filesystem, search, syntax, pty, agents   (UI-agnostic services)
src/app        service container, workbench services, input routing, built-in commands,
               persistence, bootstrap (cli, shutdown, create-app)
src/ui         design system (theme, tokens, primitives, overlays) and the shell
src/features   feature modules: explorer, search, source-control, editor, terminal, ai, settings
src/main.ts    entry point; bin/lucy launches it
```

Import rules:

| Module | May import |
| --- | --- |
| `src/core` | nothing above it (`src/themes/ids.ts` only, for the config schema) |
| `src/themes` | `src/core` |
| `src/adapters` | `src/core`, `src/themes` |
| `src/app` | everything below; `src/ui` only from `create-app.tsx` (the root element and the gallery) and the `ThemeService` type in `app-context.ts` |
| `src/ui` | `src/core`, `src/themes`, `src/adapters` (pure helpers such as `style-groups`), `src/app` React bindings and service types |
| `src/features` | everything; nothing imports a feature except `src/app/features.ts` |

The shell (`src/ui/shell`) never imports a feature. Features reach the workbench only through
the registries on the `AppContext`.

## 2. The service container

`AppContext` (`src/app/app-context.ts`) is created by `createApp` and handed to every feature
(`activate(ctx)`) and component (`useApp()`).

| Field | Type | Purpose |
| --- | --- | --- |
| `workspace`, `dirs`, `env`, `log` | `Workspace`, `AppDirs`, `AppEnvironment`, `Logger` | Where we are; `env` has `version`, `demo`, `debug`, `platform` |
| `config` | `ConfigService` | Typed settings (`config.get("ui.theme")`), `onDidChange`, `set(path, value, { persist })` |
| `themes` | `ThemeService` | The resolved `UiTheme` (`themes.current`, `themes.store`, `preview(id)`) |
| `commands` | `CommandRegistry` | Every user-visible action |
| `keybindings` | `KeybindingRegistry` | Defaults plus user overrides; `resolve`, `bindingsFor`, `all` |
| `contextKeys` | `ContextKeys` | Facts that `when` clauses read |
| `workspaceState`, `persisted` | `WorkspaceStateStore`, `PersistedState` | Per-workspace restore state on disk and in memory |
| `layout` | `LayoutService` | Panel visibility and sizes; `effective` is what fits on screen |
| `focus` | `FocusService` | Focus zones, zone key handlers, focus targets |
| `editors` | `EditorService` | Tabs, preview tabs, history, view state, `reveal` |
| `views` | `ViewRegistry` | Sidebar views, auxiliary views, bottom tabs, editor views |
| `statusBar` | `StatusBarService` | Status items |
| `notifications` | `NotificationService` | Toasts and their history |
| `dialogs` | `DialogService` | `confirm`, `prompt`, `alert` (promise based) |
| `quickPick` | `QuickPickService` | The one picker: prefix providers and ad-hoc `pick()` |
| `menus` | `MenuService` | Context menus |
| `overlays` | `OverlayService` | The overlay stack (layer 1 of key routing) |
| `hints` | `HintService` | The status bar's hint area |
| `services` | `DomainServices` | Git, file index, search, syntax, file ops, PTYs, agents (lazy) |
| `lifecycle` | `Lifecycle` | `firstPaint`, `timings`, `mark()`, `quit()`, `suspend()` |

Helpers on the context: `run(command, args)` (failures become a toast), `keybindingFor(command)`
(the best key sequence for this terminal, e.g. `ctrl+k e`), `keybindingLabel(command)`
(formatted, `Ctrl+K E`), `track(disposable)` (released on shutdown).

React bindings (`src/app/react.tsx`):

- `useApp()`: the container; throws outside `<AppProvider>`. `useOptionalApp()` returns null
  instead (design-system primitives that also work in isolation).
- `useStore(store, selector?)`: `useSyncExternalStore` over any `Readable<T>` (`get` +
  `subscribe`, i.e. a `Store`). Selectors must be cheap and return stable references: a
  selector or `get()` that returns a new array each call loops forever.
- `useZone()`, `useZoneFocused()`, `ZoneProvider`, `useKeyHandler`, `useFocusTarget`,
  `useHoverHint`, `useKeybindingLabel` (see sections 4 and 5).

Workbench services are framework-agnostic classes with their state in a `Store`; React only
renders them. `derived([...readables], compute)` (`src/app/workbench/readable.ts`) builds a
memoized `Readable` from others.

## 3. Adding a feature, step by step

### 3.1 The module

```ts
// src/features/<name>/index.ts
import type { FeatureModule } from "@/app/feature";
import { DisposableStore } from "@/core/events";

export const myFeature: FeatureModule = {
  id: "my-feature",
  keybindings: [{ command: "my.doThing", keys: ["ctrl+k d"], when: "sidebarView == 'mine'" }],
  activate(ctx) {
    const store = new DisposableStore();
    store.add(ctx.commands.register({ id: "my.doThing", title: "Do Thing", category: "My", run: () => {} }));
    return store;
  },
};
```

Then add it to `FEATURES` in `src/app/features.ts`. The seven modules there today are honest
stubs; feature engineers replace their `index.ts` and keep the export name.

- `activate` must be fast and side-effect free: no process, watcher or PTY. Domain services
  are lazy; start work on user action or after `ctx.lifecycle.firstPaint`.
- A throwing `activate` is logged and shown as a toast; the app still starts.
- `keybindings` is a static field, not a registration call, because `KeybindingRegistry`
  takes its defaults at construction; `createApp` merges `DEFAULT_KEYBINDINGS` with every
  feature's list before user overrides from `keybindings.bindings` apply.
- Return a `Disposable`; features are disposed in reverse order on shutdown.

### 3.2 Views

```ts
ctx.views.registerSidebarView({
  id: "explorer",              // "explorer" | "search" | "scm" are persisted by name
  title: "Explorer",           // shown uppercase in the header
  icon: "explorer",            // IconName from src/themes/icons.ts
  order: 10,                   // activity bar position
  command: "view.showExplorer",// its keybinding appears in the activity-bar hint
  badge: countReadable,        // Readable<number | undefined>; 0/undefined hides it
  actions: [{ command: "explorer.refresh", icon: "refresh" }], // header buttons
  component: ExplorerView,     // (props: ViewProps) => ReactNode
});
```

`ViewProps` is `{ visible, focused }`. Every registered view stays mounted (hidden ones get
`visible={false}`), so views keep their scroll and state. `registerAuxiliaryView({ id, title,
icon, order, component, actions })` adds a view to the right-hand panel (the AI feature);
`registerBottomTab({ id, title, icon?, order, component, badge?, actions? })` adds a tab to
the bottom panel (the terminal). The component type is `ViewComponent<P>`; React's
`ComponentType` is not accepted because OpenTUI's JSX typings reject async components.

Each view is wrapped in a `PanelBoundary`: a render error shows "X stopped working" with
Retry and is logged; the rest of the workbench keeps working.

### 3.3 Editor views and tabs

```ts
ctx.views.registerEditorView({
  kind: "file",
  component: CodeView,                         // (props: EditorViewProps) => ReactNode
  title: (input) => undefined,                 // default: base name of input.resource
  icon: undefined,                             // file/diff tabs use the file-type icon
  breadcrumb: (tab) => tab.resource!.split("/"),
});
```

`EditorViewProps` is `{ tab: EditorTab, focused }`. Only the active tab's view is mounted;
keep per-tab state in the tab's view-state bag:

- `ctx.editors.open(input, { preview, activate, pinned, viewState })`: tabs are deduplicated
  by kind + resource + params. `preview: true` (single click) reuses one italic preview tab
  until it is kept, pinned or dirty; opening the same input without `preview` promotes it.
- `setViewState(id, patch)`, `setDirty(id, dirty)`, `setTitle`, `keep`, `pin`, `close`,
  `next`/`previous`, `goBack`/`goForward`.
- `reveal({ tabId, line, column })` emits `onDidRequestReveal`; the editor view scrolls.
  Quick Open (`file.ts:42`) and the `:` provider use it.
- File and diff tabs (not previews) persist per workspace with `viewState.scrollTop`.

### 3.4 Commands and keybindings

`ctx.commands.register({ id, title, category, run, description?, keywords?, enabled?, when?, hidden? })`.
Ids are `area.verbNoun` (`git.stageAll`). `enabled` is a `when` string or a function; disabled
commands stay listed and greyed. `when` hides a command from the palette. `hidden` keeps it out
of the palette entirely. Failures go to `commands.onDidFail`, which the app shows as a toast.

Context keys available to `when` clauses:

| Key | Set by | Meaning |
| --- | --- | --- |
| `focusedZone` | focus | `"sidebar"`, `"editor"`, `"auxiliary"`, `"bottom"` |
| `sidebarFocus`, `editorFocus`, `auxiliaryFocus`, `panelFocus` | focus | One per zone |
| `inputFocus` | key router, renderer | A text input or textarea has renderable focus |
| `terminalFocus` | key router | An embedded terminal has renderable focus |
| `overlayOpen` | overlays | A palette, dialog or menu is open |
| `sidebarView` | create-app | The visible sidebar view id (unset when hidden) |
| `zenMode` | create-app | Zen mode is on |
| `scmInputFocus` | the Source Control feature | Its commit message box has focus |

Features may set their own keys with `ctx.contextKeys.set`.

Rules for default chords (enforced by tests in `tests/core/keybindings-*.test.ts`): every
command has a legacy-safe chord (usually `ctrl+k <key>`); `global: true` is reserved for the
escape hatches. A user override inherits `when`, `global` and `args` from the command's FIRST
default definition, so list a command's non-global definition first.

### 3.5 Status items

```ts
const item = ctx.statusBar.register({
  id: "git.branch", alignment: "left", priority: 100, text: "main",
  icon: "branch", tone: "default", tooltip: "Tracking origin/main", command: "git.checkout",
});
item.update({ text: "feature/x" });
```

On both sides items run left to right by descending priority; when space runs out the lowest
priorities are dropped first (`layoutStatusItems`). Status bars are quiet: the default tone is
muted; use `default` only for key facts and the status tones only for real states.

### 3.6 Quick pick, dialogs, notifications, menus, hints

- `ctx.quickPick.registerProvider({ prefix, title, placeholder, provideItems(query, signal), accept(item, query), emptyText? })`:
  the longest matching prefix wins. Built in: `>` commands, `""` files (with `:line`), `:` go
  to line, `?` help. Providers filter themselves; `filterQuickPickItems(items, query)` does
  fuzzy filtering with highlights for static lists.
- `await ctx.quickPick.pick({ items, title, placeholder, activeId, onActive, matchOnDescription })`
  resolves with the chosen `QuickPickItem` or `undefined`. `onActive` enables live preview
  (the theme picker).
- `await ctx.dialogs.confirm({ title, message, confirmLabel, danger })`, `prompt({ ..., validate })`,
  `alert(...)`. The safe action has focus when a confirm opens.
- `ctx.notifications.show({ severity, title, message, actions, timeoutMs, key })` or
  `info/success/warn/error(title, message)`. Toasts with actions stay until dismissed.
- `ctx.menus.show({ x, y, items })` with `MenuItem`s that run a command or a callback.
- `ctx.hints.flash({ text, keys })` for a short status-bar message; `useHoverHint` /
  `usePointer({ hint })` for hover hints.

### 3.7 Keyboard and focus inside a view

```tsx
function ResultsView({ focused }: ViewProps) {
  const [index, setIndex] = useState(0);
  useKeyHandler((key) => {
    if (key.key === "down") { setIndex((i) => i + 1); return true; }
    return false;
  });
  const input = useRef<InputRenderable>(null);
  useFocusTarget(input);          // gets renderable focus when the zone is focused
  ...
}
```

- `useKeyHandler(handler, { enabled, whileInputFocused })` receives keys while the
  component's zone is focused and no binding claimed them. The newest handler is asked first.
  Handlers are skipped while a text input is focused unless `whileInputFocused` is set, and
  never receive typing keys then. They are never called while a terminal has focus.
- `useFocusTarget(ref)` registers the renderable (input, terminal) that receives focus when
  the zone gains focus. A zone without a target takes renderable focus away from stale inputs.
- `useZoneFocused()` tells a component whether its zone has focus (header accent, selection
  colors). The shell wraps each part in `ZoneProvider` through `ZoneBox`.
- Do not use OpenTUI's `useKeyboard`: it runs after the router and sees every key.

### 3.8 Persisted slices and domain services

- `ctx.persisted.update({ explorer: { expanded } })`, `{ search: { query } }`,
  `{ commitDraft }`; `noteRecentFile(path)` feeds Quick Open. Layout, tabs and the command MRU
  are written by the workbench. The state store validates and caps everything on save.
- `ctx.services.git` (`GitService`), `fileIndex` (`FileIndex`), `contentSearch`,
  `syntax` (`SyntaxService`), `fileOps` (`FileOps`, undo trash under the state dir),
  `pty` (`PtyRegistry`), `agents` (`AgentSessionManager` with the Claude provider from the
  `ai.*` settings). Each is created on first access; creating one starts nothing.
- `startBackground()` runs once after the first frame: a Git refresh, then the file watcher
  (if `workspace.watch`). Watcher batches invalidate the file index, schedule a Git refresh
  (if `git.autoRefresh`) and are re-emitted on `ctx.services.onDidChangeFiles(listener)`.
- `killAllTerminals()` kills every PTY tree synchronously (used on shutdown).

### 3.9 Terminals

An embedded terminal must stay mounted for its session's lifetime (unmounting destroys the
emulator); hide it with `visible={false}`. The auxiliary and bottom panels already stay
mounted while hidden. `registerCustomElements()` (called by `createApp`) registers the
`<embedded-terminal>` element; wire it with `connectEmbeddedTerminal` from `@/adapters/pty`
(see `docs/dev/PTY_NOTES.md` §5). The key router recognizes `EmbeddedTerminalRenderable`
automatically; call `registerTerminalRenderable(renderable)` for any other terminal-like
widget so the terminal-focus policy applies to it.

### 3.10 Screenshots and tests

- Screenshot scenario: create `scripts/scenarios/<feature>.ts(x)`; every file there is loaded
  by `bun run screenshots`.

  ```ts
  import { defineScenario } from "../screenshots";
  defineScenario("explorer-expanded", async ({ ctx, tui }) => {
    await tui.act(() => ctx.commands.execute("view.showExplorer"));
    await tui.press("down");
  }, { description: "...", sizes: [{ cols: 120, rows: 35 }], themes: ["catppuccin-mocha"] });
  ```

- Tests: `mountApp(options)` (`tests/helpers/app.tsx`) mounts the whole app on `mountTui`.
  Defaults: a fresh temporary workspace (plus `files`), private config/state/cache dirs
  (`createTestDirs()`), a `MockGitAdapter` (`git: "mock"` or its options; `"real"` uses the
  Git CLI, isolated for the demo workspace), no PTY (`ptySpawn` throws unless given), no agent
  providers, truecolor, background services off (`startBackground: true` to start them),
  `exitOnCtrlC: false`. `settings` applies settings in memory; `dirs` plus the same workspace
  root tests restore across two mounts. It returns `{ tui, app, ctx, root, dirs, git, demo,
  dispose }` and is disposed automatically after each test.

## 4. Key routing

One listener, installed with `renderer.keyInput.prependListener("keypress", ...)` by
`KeyRouter` (`src/app/input/key-router.ts`), runs before every other listener. For each key
press it converts the OpenTUI event with `toKeyStroke` (`src/app/input/key-stroke-adapter.ts`,
following the contract in `src/core/keybindings/key-stroke.ts`), updates `terminalFocus` and
`inputFocus` from the renderer's focused renderable, then offers the key to four layers:

1. **Overlay stack.** The top overlay's `handleKey` sees the key first. A modal overlay
   consumes everything it does not handle, except text and editing keys for its own input
   (`acceptsText` and an input has focus).
2. **Keybindings.** `keybindings.resolve(stroke, contextKeys)`. A pending or cancelled
   sequence consumes the key. A resolved command runs if it is registered; an unregistered
   single-chord command lets the key fall through (its feature is not built yet), an
   unregistered sequence shows "... is not available yet".
3. **Reserved conventions, outside terminals only.** Ctrl+C shows "Quit with Ctrl+Q" in the
   hint area (and is consumed unless an input has focus); Ctrl+Z suspends to the shell.
4. **The focused zone's key handlers** (`useKeyHandler`), unless a terminal has focus.

Anything left falls through to the focused widget. A consumed key gets `preventDefault()` and
`stopPropagation()`.

Policies (resolution rules of `KeybindingRegistry`, proven in `tests/app/key-router.test.tsx`):

- **Terminal focus:** only bindings marked `global` resolve. Ctrl+R (Atuin), Ctrl+P, Ctrl+C,
  Escape, Tab and all text reach the terminal untouched.
- **Input focus:** typing keys (printable, no Ctrl/Alt/Super) never trigger bindings.
- **Leader `Ctrl+\`** (the guaranteed way out of a terminal in any terminal emulator): then
  `p` palette, `h`/`j`/`k`/`l` or arrows move focus, `e`/`f`/`g` explorer/search/source
  control, `a` AI panel, `t` terminal, `q` quit. Pressing `Ctrl+\` twice lets the second press
  through, so the terminal receives a literal Ctrl+\ (`leader.sendKey` is a pass-through
  command). Any other key, or 2 s without a key, cancels silently. The armed state is shown in
  the status bar's hint area.
- Focus changes cancel a pending sequence.

Mouse: clicking anywhere in a part focuses its zone (`ZoneBox`). OpenTUI has no click events;
`usePointer` synthesizes click, double-click (400 ms, same cell), context click (right
button) and hover, ignores the `up` that ends a drag, and lets the innermost element claim a
click so a button inside a row does not also click the row. Panel dividers use OpenTUI's drag
capture (`useDragResize`).

## 5. Default keybindings

From `src/core/keybindings/defaults.ts`. Labels shown in the UI come from `keybindingFor`:
the first chord this terminal can send (kitty chords only when the terminal speaks the kitty
protocol).

| Command | Chords | Global | When |
| --- | --- | --- | --- |
| `palette.show` | `ctrl+shift+p`, `f1`, `ctrl+\ p` | yes | |
| `view.focusNextPart` | `f6` | yes | |
| `view.focusPreviousPart` | `shift+f6` | yes | |
| `terminal.toggle` | `ctrl+\``, `ctrl+\ t` | yes | |
| `terminal.toggle` | `ctrl+k t` | | |
| `file.quickOpen` | `ctrl+p` | | |
| `view.toggleSidebar` | `ctrl+b` | | |
| `view.showExplorer` | `ctrl+k e`; `ctrl+shift+e`, `ctrl+\ e` (global) | | |
| `view.showSearch` | `ctrl+k f`; `ctrl+shift+f`, `ctrl+\ f` (global) | | |
| `view.showSourceControl` | `ctrl+k g`; `ctrl+shift+g`, `ctrl+\ g` (global) | | |
| `view.toggleAiPanel` | `ctrl+k a`; `ctrl+shift+a` (global) | | |
| `view.focusAiPanel` | `ctrl+l`; `ctrl+\ a` (global) | | |
| `view.toggleBottomPanel` | `ctrl+j`, `ctrl+k j` | | |
| `view.toggleMaximizedPanel` | `ctrl+k m` | | |
| `view.toggleZenMode` | `ctrl+k z` | | |
| `view.focusLeft` / `Down` / `Up` / `Right` | `ctrl+k left/down/up/right`; `ctrl+\ h/j/k/l` and `ctrl+\ <arrow>` (global) | | |
| `view.increaseViewSize` | `ctrl+k =` | | |
| `view.decreaseViewSize` | `ctrl+k -` | | |
| `theme.select` | `ctrl+k ctrl+t` | | |
| `settings.open` | `ctrl+,`, `ctrl+k ,` | | |
| `keybindings.open` | `ctrl+k ctrl+s`, `ctrl+k k` | | |
| `app.quit` | `ctrl+q`, `ctrl+k q`; `ctrl+\ q` (global) | | |
| `leader.sendKey` | `ctrl+\ ctrl+\` | yes | |
| `editor.find` | `ctrl+f` | | `editorFocus` |
| `editor.goToLine` | `ctrl+g` | | `editorFocus` |
| `editor.closeTab` | `ctrl+w` | | `!inputFocus` |
| `editor.nextTab` / `previousTab` | `ctrl+pagedown` / `ctrl+pageup` | | |
| `git.commit` | `ctrl+enter` | | `scmInputFocus` |
| `git.commit` | `ctrl+k c` | | `sidebarView == 'scm'` |
| `ai.newSession` | `ctrl+k n` | | |

Reserved, handled by the router and not remappable: Ctrl+C (quit hint) and Ctrl+Z (suspend),
both only outside terminals. Feature commands that are not registered yet (`editor.find`,
`git.commit`, `ai.newSession`, ...) let their keys fall through.

## 6. Lifecycle

Startup (`src/main.ts`, `run(argv)`), with the timing mark after each phase:

1. Parse arguments (`parseArgs` in `src/app/cli.ts`): `--help`, `--version`, unknown flags
   (exit code 2 with a suggestion). Not a TTY: a friendly message, exit 1. `start`
2. Resolve the workspace (typed errors become sentences via `describeWorkspaceError`) and
   Lucy's directories; `--demo` builds the demo project and private dirs. `workspace`
3. Rotate and configure the file log; load the configuration (problems become a toast later,
   the app always starts). `config`
4. `configureOpenTuiDataPath(<cache>/opentui)`, then `createCliRenderer` with
   `exitOnCtrlC: false`, `exitSignals: []`, the console overlay opening on errors only with
   `--debug`, and the theme's background. `renderer`
5. `createApp`: services, feature activation (`features:start`, `features:activated`),
   restore of layout and tabs (`restore:done`).
6. `createRoot(renderer).render(app.element)` (`mounted`), wait for the first frame,
   `app.markFirstPaint()` (`first-paint`), which starts Git, the watcher and one prune of the
   undo trash (`TRASH_LIMITS`: 30 days, 512 MiB).

`LUCY_PROFILE=1` prints the marks to stderr after exit; they are always logged. Measured once
in a Bun PTY on macOS with `--demo`: `start` 133 ms (module loading), `workspace` 1079 ms
(building the demo repository takes about 0.95 s of that), `renderer` 1089 ms, `mounted`
1095 ms, `first-paint` 1115 ms, i.e. about 20 ms from mount to the first frame. Without
`--demo` the workspace phase takes a few milliseconds.

Shutdown goes through one `ShutdownController` (`src/app/shutdown.ts`) for `app.quit`,
SIGTERM/SIGINT/SIGHUP/SIGQUIT (exit code 128+n) and startup failures. It is idempotent; each
step is guarded and limited to 3 s: dispose the app (flush workspace state, dispose features
in reverse order, the key router, domain services (PTY trees killed), registries, config
saves), kill terminals again synchronously, destroy the renderer and await `closed`, remove
demo files, flush the log, `process.exit`. `installPtyShutdownHooks(registry, { signals: [] })`
also kills PTY trees on process exit.

Uncaught exceptions and unhandled rejections are logged with `redact` and shown as one calm
toast ("Something went wrong ... Details are in <log>"); the app keeps running. A render error
inside a view is contained by its `PanelBoundary`.

Suspend (`app.suspend`, or Ctrl+Z outside a terminal): `renderer.suspend()`, resume on
`SIGCONT`, `SIGSTOP` self.

## 7. Where things live

| What | Where |
| --- | --- |
| Settings | `<config>/config.toml` (`ConfigService`, `configFilePath`); `LUCY_CONFIG_DIR` or XDG |
| Workspace restore state | `<state>/workspaces/<workspace id>.json` (`workspaceStatePath`), debounced atomic writes, mode 0600 |
| Log | `<state>/logs/lucy.log` (`logFilePath`), rotated to `lucy.log.1` above 2 MiB at startup |
| Undo trash | `<state>/trash/<workspace id>`, pruned after first paint (30 days, 512 MiB) |
| OpenTUI data (Tree-sitter) | `<cache>/opentui`; Lucy's grammars cache in `<cache>/tree-sitter` |
| Demo mode | the project under the system temp dir; config/state/cache in a temporary `lucy-demo-home-*`; Git runs with `isolatedGitEnv`; all removed on exit |
| Tests and screenshots | `LUCY_*_DIR` and `XDG_DATA_HOME` point at temporary directories (`tests/setup.ts`, `scripts/screenshots.ts`) |

## 8. Known limits

- Hover and drag rely on mouse mode 1003 (every pointer move is reported); its CPU cost on
  slow links is not measured.
- Keybinding labels follow `renderer.capabilities.kitty_keyboard` at render time; a component
  re-renders on config changes, not when capabilities arrive later.
- `DomainServices.agents` reads `ai.executable` and `ai.args` when first created; later
  changes need a restart.
- The leader hint lists the most used follow-ups (P, H J K L, E F G, Q); A and T work too.
