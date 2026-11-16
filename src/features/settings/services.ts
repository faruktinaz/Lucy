/**
 * Per-app state of the Settings feature: the view models behind the Settings and Keyboard
 * Shortcuts editors, the Integrations view and onboarding, created lazily and shared by every
 * tab instance (only the active tab's view is mounted, so state cannot live in components).
 */
import type { CliRenderer } from "@opentui/core";
import type { AppContext } from "@/app/app-context";
import { type Disposable, DisposableStore } from "@/core/events";
import type { ChordSupportOptions } from "@/core/keybindings";
import { Store } from "@/core/store";
import type { ExternalEditorRunner } from "./config-file";
import { IntegrationsModel, type TerminalCapabilities } from "./model/integrations-model";
import { KeybindingsViewModel } from "./model/keybindings-view-model";
import type { OnboardingModel } from "./model/onboarding-model";
import { SettingsViewModel } from "./model/settings-view-model";

/** Built-in feature modules listed in the Integrations view. */
export const BUILT_IN_MODULES = [
  { id: "explorer", title: "Explorer" },
  { id: "search", title: "Search" },
  { id: "source-control", title: "Source Control" },
  { id: "editor", title: "Code viewer" },
  { id: "terminal", title: "Terminal" },
  { id: "ai", title: "Claude Code panel" },
  { id: "settings", title: "Settings and shortcuts" },
] as const;

export interface SettingsFeatureEnvironment {
  /** Environment for tool and editor lookups. Default `process.env`. */
  readonly env: Record<string, string | undefined>;
  /** Version check timeout of the Integrations view. */
  readonly toolTimeoutMs?: number;
  /** Runs the external editor; tests inject a fake. Default: the editor adapter. */
  readonly openExternalEditor?: ExternalEditorRunner;
}

export interface SettingsServices extends Disposable {
  readonly settings: SettingsViewModel;
  keybindings(): KeybindingsViewModel;
  integrations(): IntegrationsModel;
  /**
   * The renderer, provided by whichever of this feature's components is mounted (the
   * Integrations sidebar view always is). Needed to suspend the screen for an external
   * editor and to copy to the clipboard; null until a component mounted.
   */
  readonly renderer: { current: CliRenderer | null };
  /** The running onboarding flow, if any (the overlay renders it). */
  readonly onboarding: Store<OnboardingModel | null>;
  /** What the current terminal can deliver, for keybinding warnings. */
  support(): ChordSupportOptions;
  terminalCapabilities(): TerminalCapabilities;
  readonly environment: SettingsFeatureEnvironment;
}

const registry = new WeakMap<AppContext, SettingsServices>();

export function createSettingsServices(
  ctx: AppContext,
  environment: SettingsFeatureEnvironment,
): SettingsServices {
  const disposables = new DisposableStore();
  const renderer: { current: CliRenderer | null } = { current: null };
  const settings = disposables.add(new SettingsViewModel({ config: ctx.config }));
  let keybindings: KeybindingsViewModel | undefined;
  let integrations: IntegrationsModel | undefined;

  const support = (): ChordSupportOptions => ({
    kittyKeyboard: renderer.current?.capabilities?.kitty_keyboard === true,
    platform: ctx.env.platform,
  });

  const terminalCapabilities = (): TerminalCapabilities => {
    const caps = renderer.current?.capabilities;
    const theme = ctx.themes.current;
    return {
      name:
        caps?.terminal?.name || environment.env.TERM_PROGRAM || environment.env.TERM || "Unknown terminal",
      truecolor: caps?.rgb === true || theme.colorMode === "truecolor",
      kittyKeyboard: caps?.kitty_keyboard === true,
      mouse: renderer.current?.useMouse ?? true,
      hyperlinks: caps?.hyperlinks === true,
    };
  };

  const services: SettingsServices = {
    settings,
    renderer,
    environment,
    onboarding: new Store<OnboardingModel | null>(null),
    support,
    terminalCapabilities,
    keybindings: () => {
      keybindings ??= disposables.add(
        new KeybindingsViewModel({
          registry: ctx.keybindings,
          commands: ctx.commands,
          config: ctx.config,
          support: support(),
          // Keyboard labels follow the rest of the UI (`Ctrl+K E`), not macOS symbols.
          style: "text",
          mode: ctx.config.get("keybindings.mode"),
        }),
      );
      keybindings.setSupport(support());
      return keybindings;
    },
    integrations: () => {
      integrations ??= disposables.add(
        new IntegrationsModel({
          terminal: terminalCapabilities(),
          features: BUILT_IN_MODULES,
          env: environment.env,
          timeoutMs: environment.toolTimeoutMs,
        }),
      );
      return integrations;
    },
    dispose: () => {
      services.onboarding.get()?.dispose();
      disposables.dispose();
      registry.delete(ctx);
    },
  };
  registry.set(ctx, services);
  return services;
}

/** The feature's services for this app. Throws if the Settings feature is not active. */
export function settingsServices(ctx: AppContext): SettingsServices {
  const services = registry.get(ctx);
  if (!services) throw new Error("The Settings feature is not active");
  return services;
}
