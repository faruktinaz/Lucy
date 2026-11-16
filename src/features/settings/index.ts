/**
 * Settings feature: the Settings editor, the Keyboard Shortcuts editor with remapping, the
 * first-run onboarding, the Integrations view (the activity bar's extensions entry until a
 * plugin system exists) and opening config.toml.
 *
 * The UI is built on the view models in `./model`; this module only wires them to the
 * workbench's registries.
 */
import type { AppContext } from "@/app/app-context";
import type { FeatureModule } from "@/app/feature";
import { type Disposable, DisposableStore } from "@/core/events";
import { type ExternalEditorRunner, openConfigFile } from "./config-file";
import { shouldRunOnboarding } from "./model/onboarding-marker";
import { createSettingsServices, settingsServices } from "./services";
import { IntegrationsView } from "./ui/integrations-view";
import { KeybindingsEditor } from "./ui/keybindings-editor";
import { startOnboarding } from "./ui/onboarding-overlay";
import { SettingsEditor } from "./ui/settings-editor";

export interface SettingsFeatureOptions {
  /**
   * When onboarding opens by itself. `auto` (default): on a real first run only (no
   * config.toml and no completion marker), never in demo mode and never under `bun test`.
   * `always`: on every start (tests of the flow). `never`: only from the command.
   */
  readonly onboarding?: "auto" | "always" | "never";
  /** Environment for tool and editor lookups. Default `process.env`. */
  readonly env?: Record<string, string | undefined>;
  /** Version check timeout of the Integrations view. */
  readonly toolTimeoutMs?: number;
  /** Runs the external editor (tests inject a fake; the default suspends the screen). */
  readonly openExternalEditor?: ExternalEditorRunner;
}

export const SETTINGS_TAB = { kind: "settings", resource: "settings", title: "Settings" } as const;
export const KEYBINDINGS_TAB = {
  kind: "keybindings",
  resource: "keybindings",
  title: "Keyboard Shortcuts",
} as const;

function autoOnboarding(
  ctx: AppContext,
  mode: NonNullable<SettingsFeatureOptions["onboarding"]>,
): Promise<boolean> {
  if (mode === "never") return Promise.resolve(false);
  if (mode === "always") return Promise.resolve(true);
  if (ctx.env.demo || process.env.NODE_ENV === "test") return Promise.resolve(false);
  return shouldRunOnboarding({ dirs: ctx.dirs, demo: ctx.env.demo });
}

export function createSettingsFeature(options: SettingsFeatureOptions = {}): FeatureModule {
  return {
    id: "settings",
    activate(ctx) {
      const store = new DisposableStore();
      const services = store.add(
        createSettingsServices(ctx, {
          env: options.env ?? process.env,
          toolTimeoutMs: options.toolTimeoutMs,
          openExternalEditor: options.openExternalEditor,
        }),
      );
      const register = (definition: Parameters<typeof ctx.commands.register>[0]) =>
        store.add(ctx.commands.register(definition));

      store.add(
        ctx.views.registerEditorView({
          kind: SETTINGS_TAB.kind,
          icon: "settings",
          title: () => SETTINGS_TAB.title,
          breadcrumb: () => ["Preferences", "Settings"],
          component: SettingsEditor,
        }),
      );
      store.add(
        ctx.views.registerEditorView({
          kind: KEYBINDINGS_TAB.kind,
          icon: "settings",
          title: () => KEYBINDINGS_TAB.title,
          breadcrumb: () => ["Preferences", "Keyboard Shortcuts"],
          component: KeybindingsEditor,
        }),
      );
      store.add(
        ctx.views.registerSidebarView({
          id: "integrations",
          title: "Integrations",
          icon: "extensions",
          order: 90,
          command: "view.showIntegrations",
          actions: [{ command: "integrations.refresh", icon: "refresh", title: "Check again" }],
          component: IntegrationsView,
        }),
      );

      register({
        id: "settings.open",
        title: "Open Settings",
        category: "Preferences",
        keywords: ["preferences", "configuration", "options"],
        run: () => {
          ctx.editors.open({ ...SETTINGS_TAB });
          ctx.focus.focus("editor");
        },
      });
      // Replaces the workbench's searchable list with the full editor (remapping included).
      store.add(
        ctx.commands.register(
          {
            id: "keybindings.open",
            title: "Keyboard Shortcuts",
            category: "Preferences",
            keywords: ["keys", "shortcuts", "bindings", "remap"],
            run: () => {
              ctx.editors.open({ ...KEYBINDINGS_TAB });
              ctx.focus.focus("editor");
            },
          },
          { replace: true },
        ),
      );
      register({
        id: "settings.openConfigFile",
        title: "Open Settings File (config.toml)",
        category: "Preferences",
        keywords: ["config", "toml", "edit settings"],
        run: () => openConfigFile(ctx, services),
      });
      register({
        id: "view.showIntegrations",
        title: "Show Integrations",
        category: "View",
        keywords: ["extensions", "tools", "plugins"],
        run: () => {
          ctx.layout.showSidebarView("integrations");
          ctx.focus.focus("sidebar");
          const model = services.integrations();
          if (model.state.checkedAt === null && !model.state.loading) void model.refresh();
        },
      });
      register({
        id: "integrations.refresh",
        title: "Check Integrations Again",
        category: "View",
        run: () => services.integrations().refresh({ force: true }),
      });
      register({
        id: "onboarding.run",
        title: "Run Setup",
        category: "Preferences",
        keywords: ["onboarding", "welcome", "first run", "setup"],
        run: () => startOnboarding(ctx, services),
      });

      const mode = options.onboarding ?? "auto";
      void ctx.lifecycle.firstPaint
        .then(() => autoOnboarding(ctx, mode))
        .then((run) => {
          if (run && !store.isDisposed) startOnboarding(ctx, services);
        })
        .catch((error: unknown) => ctx.log.warn("Onboarding check failed", { error }));

      return store as Disposable;
    },
  };
}

export const settingsFeature: FeatureModule = createSettingsFeature();

export { openConfigFile, settingsServices };
