/**
 * A feature is a module that contributes to the workbench through the registries in the
 * `AppContext`: views, editor views, commands, keybindings, status items, quick-pick
 * providers. The shell never imports a feature; `src/app/features.ts` lists them.
 */
import type { Disposable } from "@/core/events";
import type { KeybindingDefinition } from "@/core/keybindings";
import type { AppContext } from "./app-context";

export interface FeatureModule {
  /** Stable id, used in logs: "explorer", "source-control". */
  readonly id: string;
  /**
   * Default keybindings for the feature's commands, with `when` contexts. They join the
   * built-in defaults before user overrides apply, so users can rebind them in config.
   */
  readonly keybindings?: readonly KeybindingDefinition[];
  /**
   * Registers contributions. Return a Disposable (or nothing) that releases everything;
   * features are disposed in reverse activation order on shutdown. Activation must be
   * fast and side-effect free: no processes, watchers or PTYs (use `ctx.services` lazily,
   * or wait for `ctx.lifecycle.firstPaint`).
   */
  activate(ctx: AppContext): Disposable | undefined;
}
