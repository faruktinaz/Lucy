/**
 * The built-in workbench commands: palette, quick open, panel toggles, focus movement, zen
 * mode, layout reset, resizing, tabs, theme picker, keyboard shortcuts, quit, suspend and the
 * developer commands. Feature commands (`editor.find`, `git.commit`, ...) live with their
 * features.
 */
import type { CommandDefinition } from "@/core/commands";
import { type Disposable, DisposableStore } from "@/core/events";
import { formatChord } from "@/core/keybindings";
import { listThemes, type ThemeId } from "@/themes";
import type { AppContext } from "../app-context";
import { LEADER_PASSTHROUGH_COMMAND } from "../input/key-router";
import { logFilePath } from "../log-file";
import type { FocusDirection, FocusZone } from "../workbench/focus";
import type { QuickPickItem } from "../workbench/quick-pick";

export interface WorkbenchCommandOptions {
  /** Toggles OpenTUI's console overlay (only offered with `--debug`). */
  toggleConsole?: () => void;
}

const RESIZE_STEP = 4;
const BOTTOM_RESIZE_STEP = 2;

export function registerWorkbenchCommands(
  ctx: AppContext,
  options: WorkbenchCommandOptions = {},
): Disposable {
  const store = new DisposableStore();
  const { layout, focus, editors, quickPick, config, themes, keybindings, commands } = ctx;
  const register = (definition: CommandDefinition) => store.add(commands.register(definition));

  const isNarrow = () => layout.effective.get().mode === "narrow";

  const showSidebarView = (view: string) => {
    layout.showSidebarView(view);
    focus.focus("sidebar");
  };

  const focusPart = (zone: FocusZone) => {
    if (!focus.focus(zone)) ctx.hints.flash({ text: "That part is hidden", tone: "muted" });
  };

  // ------------------------------------------------------------------ pickers

  register({
    id: "palette.show",
    title: "Show All Commands",
    category: "View",
    run: () => quickPick.show(">"),
  });
  register({
    id: "file.quickOpen",
    title: "Go to File",
    category: "File",
    keywords: ["open", "quick open"],
    run: () => quickPick.show(""),
  });
  register({
    id: "workbench.goToLine",
    title: "Go to Line",
    category: "Go",
    description: "Jump to a line in the active editor",
    run: () => quickPick.show(":"),
  });

  // ----------------------------------------------------------------- sidebar

  register({
    id: "view.toggleSidebar",
    title: "Toggle Sidebar",
    category: "View",
    run: () => {
      // In the narrow drawer the toggle opens or closes the drawer, never hides the request.
      if (isNarrow()) {
        if (focus.current === "sidebar") focus.focus("editor");
        else showSidebarView(layout.state.sidebar.view);
        return;
      }
      const visible = !layout.state.sidebar.visible;
      layout.setSidebarVisible(visible);
      if (!visible && focus.current === "sidebar") focus.focus("editor");
    },
  });
  register({
    id: "view.showExplorer",
    title: "Show Explorer",
    category: "View",
    run: () => showSidebarView("explorer"),
  });
  register({
    id: "view.showSearch",
    title: "Show Search",
    category: "View",
    run: () => showSidebarView("search"),
  });
  register({
    id: "view.showSourceControl",
    title: "Show Source Control",
    category: "View",
    run: () => showSidebarView("scm"),
  });

  // --------------------------------------------------------------- auxiliary

  const hasAuxiliary = () => ctx.views.state.auxiliary.length > 0;
  register({
    id: "view.toggleAiPanel",
    title: "Toggle AI Panel",
    category: "View",
    enabled: hasAuxiliary,
    run: () => {
      const showing = !layout.state.auxiliary.visible || (isNarrow() && focus.current !== "auxiliary");
      if (showing) {
        layout.setAuxiliaryVisible(true);
        focus.focus("auxiliary");
      } else {
        if (!isNarrow()) layout.setAuxiliaryVisible(false);
        if (focus.current === "auxiliary") focus.focus("editor");
      }
    },
  });
  register({
    id: "view.focusAiPanel",
    title: "Focus AI Panel",
    category: "View",
    enabled: hasAuxiliary,
    run: () => {
      layout.setAuxiliaryVisible(true);
      focus.focus("auxiliary");
    },
  });

  // ------------------------------------------------------------------ bottom

  register({
    id: "view.toggleBottomPanel",
    title: "Toggle Panel",
    category: "View",
    run: () => {
      if (layout.state.bottom.visible && focus.current === "bottom") {
        layout.setBottomVisible(false);
        focus.focus("editor");
        return;
      }
      if (layout.state.bottom.visible && focus.current !== "bottom") {
        layout.setBottomVisible(false);
        return;
      }
      layout.setBottomVisible(true);
      focus.focus("bottom");
    },
  });
  register({
    id: "view.toggleMaximizedPanel",
    title: "Toggle Maximized Panel",
    category: "View",
    run: () => {
      layout.toggleBottomMaximized();
      focus.focus("bottom");
    },
  });

  // ------------------------------------------------------------- whole layout

  register({
    id: "view.toggleZenMode",
    title: "Toggle Zen Mode",
    category: "View",
    run: () => {
      layout.toggleZen();
      if (layout.state.zen) {
        focus.focus("editor");
        const keys = ctx.keybindingLabel("view.toggleZenMode");
        ctx.notifications.show({
          key: "zen",
          title: "Zen mode",
          message: keys
            ? `Press ${keys} to bring the panels back.`
            : "Run Toggle Zen Mode again to bring the panels back.",
        });
      }
    },
  });
  register({ id: "view.resetLayout", title: "Reset Layout", category: "View", run: () => layout.reset() });

  const resizeFocused = (sign: 1 | -1) => {
    const zone = focus.current;
    if (zone === "sidebar") layout.resize("sidebar", sign * RESIZE_STEP);
    else if (zone === "auxiliary") layout.resize("auxiliary", sign * RESIZE_STEP);
    else if (zone === "bottom") layout.resize("bottom", sign * BOTTOM_RESIZE_STEP);
    // The editor grows by shrinking the sidebar.
    else if (layout.effective.get().sidebar.visible) layout.resize("sidebar", -sign * RESIZE_STEP);
  };
  register({
    id: "view.increaseViewSize",
    title: "Increase Current View Size",
    category: "View",
    run: () => resizeFocused(1),
  });
  register({
    id: "view.decreaseViewSize",
    title: "Decrease Current View Size",
    category: "View",
    run: () => resizeFocused(-1),
  });

  // ------------------------------------------------------------------- focus

  register({ id: "view.focusNextPart", title: "Focus Next Part", category: "View", run: () => focus.next() });
  register({
    id: "view.focusPreviousPart",
    title: "Focus Previous Part",
    category: "View",
    run: () => focus.previous(),
  });
  const directions: [FocusDirection, string][] = [
    ["left", "Left"],
    ["right", "Right"],
    ["up", "Above"],
    ["down", "Below"],
  ];
  for (const [direction, label] of directions) {
    const suffix = direction[0]?.toUpperCase() + direction.slice(1);
    register({
      id: `view.focus${suffix}`,
      title: `Focus Part ${label}`,
      category: "View",
      run: () => {
        if (!focus.move(direction))
          ctx.hints.flash({ text: `Nothing ${label.toLowerCase()} to focus`, tone: "muted" });
      },
    });
  }
  register({
    id: "view.focusEditor",
    title: "Focus Editor",
    category: "View",
    run: () => focusPart("editor"),
  });
  register({
    id: "view.focusSidebar",
    title: "Focus Sidebar",
    category: "View",
    run: () => focusPart("sidebar"),
  });
  register({ id: "view.focusPanel", title: "Focus Panel", category: "View", run: () => focusPart("bottom") });

  // -------------------------------------------------------------------- tabs

  const hasTabs = () => editors.tabs.length > 0;
  register({
    id: "editor.closeTab",
    title: "Close Editor",
    category: "View",
    enabled: hasTabs,
    run: () => {
      const active = editors.active;
      if (active) editors.close(active.id);
    },
  });
  register({
    id: "editor.closeAllTabs",
    title: "Close All Editors",
    category: "View",
    enabled: hasTabs,
    run: () => editors.closeAll(),
  });
  register({
    id: "editor.nextTab",
    title: "Open Next Editor",
    category: "View",
    enabled: hasTabs,
    run: () => editors.next(),
  });
  register({
    id: "editor.previousTab",
    title: "Open Previous Editor",
    category: "View",
    enabled: hasTabs,
    run: () => editors.previous(),
  });
  register({
    id: "editor.navigateBack",
    title: "Go Back",
    category: "Go",
    enabled: () => editors.canGoBack,
    run: () => editors.goBack(),
  });
  register({
    id: "editor.navigateForward",
    title: "Go Forward",
    category: "Go",
    enabled: () => editors.canGoForward,
    run: () => editors.goForward(),
  });
  register({
    id: "editor.keepOpen",
    title: "Keep Editor Open",
    category: "View",
    enabled: () => editors.active?.preview === true,
    run: () => {
      const active = editors.active;
      if (active) editors.keep(active.id);
    },
  });

  // ------------------------------------------------------------- preferences

  register({
    id: "theme.select",
    title: "Color Theme",
    category: "Preferences",
    keywords: ["theme", "colors", "appearance"],
    run: async () => {
      const original = config.get("ui.theme");
      const items: QuickPickItem[] = listThemes().map((theme) => ({
        id: theme.id,
        label: theme.name,
        description: theme.contrastLevel === "AAA" ? "high contrast" : theme.appearance,
        current: theme.id === original,
      }));
      const picked = await quickPick.pick({
        title: "Color Theme",
        placeholder: "Select a color theme (Up/Down to preview)",
        items,
        onActive: (item) => void themes.preview(item.id as ThemeId),
      });
      if (picked) await config.set("ui.theme", picked.id as ThemeId);
      else await config.set("ui.theme", original, { persist: false });
    },
  });

  register({
    id: "keybindings.open",
    title: "Keyboard Shortcuts",
    category: "Preferences",
    keywords: ["keys", "shortcuts", "bindings"],
    run: async () => {
      const rules = keybindings.all();
      const items: QuickPickItem[] = rules.map((rule, index) => {
        const definition = commands.get(rule.command);
        const scope = [
          rule.global ? "works in terminals" : "",
          rule.when ?? "",
          rule.source === "user" ? "yours" : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return {
          id: `${index}`,
          label: definition ? `${definition.category}: ${definition.title}` : rule.command,
          description: definition
            ? scope || undefined
            : ["not available yet", scope].filter(Boolean).join(" · "),
          keybinding: rule.key,
          disabled: !definition,
        };
      });
      const picked = await quickPick.pick({
        title: `Keyboard Shortcuts (${items.length})`,
        placeholder: "Search shortcuts; Enter runs the command",
        items,
        matchOnDescription: true,
      });
      const rule = picked ? rules[Number.parseInt(picked.id, 10)] : undefined;
      if (rule && commands.has(rule.command)) await ctx.run(rule.command, rule.args);
    },
  });

  register({
    id: "notifications.showHistory",
    title: "Show Notifications",
    category: "View",
    run: async () => {
      const history = ctx.notifications.store.get().history;
      await quickPick.pick({
        title: "Notifications",
        placeholder: history.length === 0 ? "No notifications yet" : "Recent notifications, newest first",
        emptyText: "No notifications yet",
        items: history.map((n) => ({
          id: n.id,
          label: n.title,
          description: n.message,
          icon:
            n.severity === "error"
              ? "error"
              : n.severity === "warning"
                ? "warning"
                : n.severity === "success"
                  ? "check"
                  : "info",
        })),
        matchOnDescription: true,
      });
    },
  });

  // --------------------------------------------------------------- lifecycle

  register({ id: "app.quit", title: "Quit", category: "Application", run: () => ctx.lifecycle.quit() });
  register({
    id: "app.suspend",
    title: "Suspend to Shell",
    category: "Application",
    description: "Like Ctrl+Z in a shell; resume with fg",
    run: () => ctx.lifecycle.suspend(),
  });
  register({
    id: LEADER_PASSTHROUGH_COMMAND,
    title: `Send ${formatChord("ctrl+\\", "text")} to the Terminal`,
    category: "Terminal",
    hidden: true,
    // The key router lets the second leader press through to the focused terminal itself.
    run: () => {},
  });

  // --------------------------------------------------------------- developer

  register({
    id: "developer.showLogPath",
    title: "Show Log File Location",
    category: "Developer",
    run: () => {
      ctx.notifications.show({ title: "Log file", message: logFilePath(ctx.dirs), timeoutMs: 10_000 });
    },
  });
  if (ctx.env.debug && options.toggleConsole) {
    const toggle = options.toggleConsole;
    register({
      id: "developer.toggleConsole",
      title: "Toggle Debug Console",
      category: "Developer",
      run: () => toggle(),
    });
  }

  return store;
}
