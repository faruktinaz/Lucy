/**
 * The live configuration: a `Store<Config>` the UI binds to, typed per-key updates that are
 * validated and persisted, and change events.
 *
 * Saves are serialized so two quick changes never race on the file. `persist: false` applies
 * a value in memory only, which the theme picker uses for live previews.
 */

import { LucyError } from "../errors";
import { type Disposable, Emitter } from "../events";
import type { AppDirs } from "../paths";
import { Store } from "../store";
import { type LoadedConfig, loadConfig } from "./load";
import { type SaveConfigResult, saveConfig } from "./save";
import {
  CONFIG_VERSION,
  type Config,
  getDescriptor,
  isSettingPath,
  type SettingPath,
  type SettingValue,
} from "./schema";
import { type ConfigProblem, validateConfigTable } from "./validate";
import { changedPaths, cloneValue, getSetting, withSetting } from "./values";

export type ConfigChangeReason = "set" | "reset" | "reload";

export interface ConfigChangeEvent {
  config: Config;
  previous: Config;
  changed: SettingPath[];
  reason: ConfigChangeReason;
}

/** One setting for `setMany`. `value` is validated against the setting's schema. */
export interface SettingEntry {
  path: SettingPath;
  value: unknown;
}

export interface SetOptions {
  /** Write to config.toml (default true). False applies the value in memory only. */
  persist?: boolean;
}

export class ConfigService implements Disposable {
  readonly store: Store<Config>;
  private loaded: LoadedConfig;
  private readonly changes = new Emitter<ConfigChangeEvent>();
  private saving: Promise<unknown> = Promise.resolve();

  /** Loads config.toml (never throws for file content problems) and returns the service. */
  static async load(dirs: Pick<AppDirs, "config">): Promise<ConfigService> {
    return new ConfigService(dirs, await loadConfig(dirs));
  }

  constructor(
    private readonly dirs: Pick<AppDirs, "config">,
    loaded: LoadedConfig,
  ) {
    this.loaded = loaded;
    this.store = new Store(loaded.config);
  }

  get config(): Config {
    return this.store.get();
  }

  get path(): string {
    return this.loaded.path;
  }

  get source(): LoadedConfig["source"] {
    return this.loaded.source;
  }

  /** Problems found by the last load or reload. */
  get problems(): readonly ConfigProblem[] {
    return this.loaded.problems;
  }

  get<P extends SettingPath>(path: P): SettingValue<P> {
    return getSetting(this.store.get(), path);
  }

  onDidChange(listener: (event: ConfigChangeEvent) => void): Disposable {
    return this.changes.on(listener);
  }

  /**
   * Validates and applies one setting, then persists it. Throws `CONFIG_INVALID` for an
   * unknown path or an invalid value; nothing changes in that case. Resolves with the save
   * result (undefined when not persisted) so the UI can mention backups.
   */
  async set<P extends SettingPath>(
    path: P,
    value: SettingValue<P>,
    options: SetOptions = {},
  ): Promise<SaveConfigResult | undefined> {
    const descriptor = isSettingPath(path) ? getDescriptor(path) : undefined;
    if (!descriptor) {
      throw new LucyError("CONFIG_INVALID", `Unknown setting "${String(path)}"`, { details: { path } });
    }
    const parsed = descriptor.schema.safeParse(value);
    if (!parsed.success) {
      throw new LucyError(
        "CONFIG_INVALID",
        `Invalid value for ${descriptor.tomlPath}: expected ${descriptor.expected}`,
        {
          details: { path },
        },
      );
    }
    return this.apply(withSetting(this.store.get(), path, parsed.data as SettingValue<P>), "set", options);
  }

  /**
   * Validates and applies several settings as one change: one event, one save, one backup.
   * All-or-nothing: if any entry is unknown or invalid, `CONFIG_INVALID` is thrown (naming
   * every bad entry) and nothing changes. Used by onboarding to write its choices at once.
   */
  async setMany(
    entries: readonly SettingEntry[],
    options: SetOptions = {},
  ): Promise<SaveConfigResult | undefined> {
    let next = this.store.get();
    const invalid: string[] = [];
    for (const { path, value } of entries) {
      const descriptor = isSettingPath(path) ? getDescriptor(path) : undefined;
      const parsed = descriptor?.schema.safeParse(value);
      if (!descriptor || !parsed?.success) {
        invalid.push(descriptor ? `${descriptor.tomlPath} (expected ${descriptor.expected})` : `"${path}"`);
        continue;
      }
      next = withSetting(next, path, parsed.data as SettingValue<typeof path>);
    }
    if (invalid.length > 0) {
      throw new LucyError("CONFIG_INVALID", `Invalid settings: ${invalid.join("; ")}`, {
        details: { invalid },
      });
    }
    if (entries.length === 0) return undefined;
    return this.apply(next, "set", options);
  }

  /** Restores a setting to its default (which removes it from config.toml). */
  async reset<P extends SettingPath>(
    path: P,
    options: SetOptions = {},
  ): Promise<SaveConfigResult | undefined> {
    const descriptor = getDescriptor(path);
    return this.apply(
      withSetting(this.store.get(), path, cloneValue(descriptor.default) as SettingValue<P>),
      "reset",
      options,
    );
  }

  /** Re-reads config.toml (after an external edit) and emits the resulting changes. */
  async reload(): Promise<LoadedConfig> {
    await this.flush();
    const next = await loadConfig(this.dirs);
    this.loaded = next;
    this.commit(next.config, "reload");
    return next;
  }

  /** Resolves once every pending save finished. Call on shutdown. */
  async flush(): Promise<void> {
    await this.saving.catch(() => {});
  }

  dispose(): void {
    this.changes.dispose();
  }

  private commit(next: Config, reason: ConfigChangeReason): SettingPath[] {
    const previous = this.store.get();
    const changed = changedPaths(previous, next);
    if (changed.length === 0) return changed;
    this.store.set(next);
    this.changes.emit({ config: next, previous, changed, reason });
    return changed;
  }

  private async apply(
    next: Config,
    reason: ConfigChangeReason,
    options: SetOptions,
  ): Promise<SaveConfigResult | undefined> {
    this.commit(next, reason);
    if (options.persist === false) return undefined;
    const run = this.saving
      .catch(() => {})
      .then(async () => {
        const result = await saveConfig(this.dirs, this.store.get(), { raw: this.loaded.raw });
        // The written table carries the unknown keys forward and is now what is on disk, so
        // problems are recomputed from it (a fixed syntax error disappears, unknown keys stay).
        const { problems } = validateConfigTable(result.table, result.text);
        this.loaded = {
          ...this.loaded,
          raw: result.table,
          source: "file",
          problems,
          fileVersion: CONFIG_VERSION,
        };
        return result;
      });
    this.saving = run;
    return run;
  }
}
