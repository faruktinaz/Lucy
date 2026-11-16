/**
 * View model of the Settings screen. Rows are generated from `settingsSchema`, edits are
 * explicit state transitions, and every change goes through `ConfigService.set`, which
 * validates and persists with backups. Nothing fails silently: a rejected or unsaved change
 * becomes a visible message.
 */
import type { ConfigSource } from "@/core/config/load";
import {
  getDescriptor,
  type SettingCategory,
  type SettingDescriptor,
  type SettingPath,
  settingsSchema,
} from "@/core/config/schema";
import type { ConfigService } from "@/core/config/service";
import type { ConfigProblem } from "@/core/config/validate";
import { deepEqual, getSetting } from "@/core/config/values";
import { errorMessage, isLucyError } from "@/core/errors";
import { type Disposable, DisposableStore, Emitter, toDisposable } from "@/core/events";
import { tildify } from "@/core/paths";
import { Store } from "@/core/store";
import {
  type ControlKind,
  controlFor,
  type DraftKind,
  formatSettingValue,
  initialDraft,
  parseDraft,
  type SettingControl,
} from "./setting-controls";
import { matchesTerms, queryTerms } from "./text-match";

type AnyDescriptor = SettingDescriptor<string, unknown>;

export interface SettingItemRow {
  readonly type: "item";
  readonly path: SettingPath;
  readonly title: string;
  readonly description: string;
  readonly category: SettingCategory;
  /** TOML key shown as a quiet hint, e.g. `layout.sidebar_width`. */
  readonly configKey: string;
  readonly control: SettingControl;
  readonly value: unknown;
  readonly valueLabel: string;
  readonly defaultValue: unknown;
  readonly defaultLabel: string;
  readonly modified: boolean;
  readonly requiresRestart: boolean;
  readonly livePreview: boolean;
  /** A config file problem on this key (invalid value that fell back to the default). */
  readonly problem: string | null;
}

export interface SettingHeaderRow {
  readonly type: "header";
  readonly category: SettingCategory;
  readonly count: number;
}

export type SettingsRow = SettingHeaderRow | SettingItemRow;

export interface SettingsEdit {
  readonly kind: DraftKind;
  readonly path: SettingPath;
  readonly draft: string;
  /** Live validation message for the draft; null when it would be accepted. */
  readonly error: string | null;
  /** For list entries: the entry being edited, or null when adding one. */
  readonly index: number | null;
}

export interface SettingsMessage {
  readonly severity: "error" | "warning" | "info" | "success";
  readonly text: string;
  readonly path?: SettingPath;
}

export interface ConfigProblemView {
  readonly severity: ConfigProblem["severity"];
  readonly message: string;
  /** TOML path the problem is about, "" for the whole file. */
  readonly key: string;
  /** `config.toml:12:3`, when the position is known. */
  readonly location: string | null;
  readonly line?: number;
  readonly column?: number;
}

export interface SettingsFileInfo {
  readonly path: string;
  /** The path with the home directory shown as `~`. */
  readonly displayPath: string;
  readonly source: ConfigSource;
  readonly hasSyntaxError: boolean;
  /** Explains what saving does when the file is broken; null otherwise. */
  readonly saveNote: string | null;
  /** Plain statement for the screen footer: where settings live and what Lucy never touches. */
  readonly statement: string;
}

export interface SettingsState {
  readonly query: string;
  /** Category headers and items, filtered by `query`. */
  readonly rows: readonly SettingsRow[];
  readonly selectedPath: SettingPath | null;
  /** Index of the selected row in `rows`, or -1. */
  readonly selectedIndex: number;
  readonly edit: SettingsEdit | null;
  /** A live preview in progress (theme picker): the value to restore on cancel. */
  readonly preview: { readonly path: SettingPath; readonly original: unknown } | null;
  readonly saving: boolean;
  readonly message: SettingsMessage | null;
  readonly problems: readonly ConfigProblemView[];
  readonly file: SettingsFileInfo;
  /** Settings changed in this session that apply only after a restart. */
  readonly restartPending: readonly SettingPath[];
}

export type SettingsIntent =
  | {
      readonly kind: "open-config-file";
      readonly path: string;
      readonly line?: number;
      readonly column?: number;
    }
  | { readonly kind: "open-keybindings" };

export interface SettingsViewModelOptions {
  config: ConfigService;
  /** Home directory for the `~` display path. Defaults to the OS home. */
  home?: string;
}

const CATEGORY_ORDER: readonly SettingCategory[] = [...new Set(settingsSchema.map((d) => d.category))];

const STATEMENT_TAIL =
  "Lucy writes only its own files. It never edits other tools' configuration, such as your shell, Git, terminal, tmux or Atuin settings.";

export class SettingsViewModel implements Disposable {
  readonly store: Store<SettingsState>;
  private readonly config: ConfigService;
  private readonly home?: string;
  private readonly intents = new Emitter<SettingsIntent>();
  private readonly disposables = new DisposableStore();

  constructor(options: SettingsViewModelOptions) {
    this.config = options.config;
    this.home = options.home;
    const rows = this.buildRows("");
    const first = rows.find((r): r is SettingItemRow => r.type === "item")?.path ?? null;
    this.store = new Store<SettingsState>({
      query: "",
      rows,
      selectedPath: first,
      selectedIndex: first ? rows.findIndex((r) => r.type === "item" && r.path === first) : -1,
      edit: null,
      preview: null,
      saving: false,
      message: null,
      problems: this.problemViews(),
      file: this.fileInfo(),
      restartPending: [],
    });
    // External changes (reload, other screens) refresh values and problems.
    const unsubscribe = this.config.store.subscribe(() => this.refresh());
    this.disposables.add(toDisposable(unsubscribe));
  }

  get state(): SettingsState {
    return this.store.get();
  }

  // ---- Rows, search and selection -------------------------------------------------------

  private itemRow(descriptor: AnyDescriptor, problems: Map<string, string>): SettingItemRow {
    const config = this.config.config;
    const path = descriptor.path as SettingPath;
    const value = getSetting(config, path);
    return {
      type: "item",
      path,
      title: descriptor.title,
      description: descriptor.description,
      category: descriptor.category,
      configKey: descriptor.tomlPath,
      control: controlFor(descriptor),
      value,
      valueLabel: formatSettingValue(descriptor, value),
      defaultValue: descriptor.default,
      defaultLabel: formatSettingValue(descriptor, descriptor.default),
      modified: !deepEqual(value, descriptor.default),
      requiresRestart: descriptor.requiresRestart === true,
      livePreview: descriptor.livePreview === true,
      problem: problems.get(descriptor.tomlPath) ?? null,
    };
  }

  private buildRows(query: string): SettingsRow[] {
    const terms = queryTerms(query);
    const problems = new Map<string, string>();
    for (const p of this.config.problems)
      if (p.path && !problems.has(p.path)) problems.set(p.path, p.message);
    const rows: SettingsRow[] = [];
    for (const category of CATEGORY_ORDER) {
      const items = (settingsSchema as readonly AnyDescriptor[])
        .filter((d) => d.category === category)
        .filter((d) => matchesTerms(terms, [d.title, d.description, d.path, d.tomlPath, d.category]))
        .map((d) => this.itemRow(d, problems));
      if (items.length === 0) continue;
      rows.push({ type: "header", category, count: items.length }, ...items);
    }
    return rows;
  }

  private problemViews(): ConfigProblemView[] {
    return this.config.problems.map((p) => ({
      severity: p.severity,
      message: p.message,
      key: p.path,
      location:
        p.line === undefined ? null : `config.toml:${p.line}${p.column === undefined ? "" : `:${p.column}`}`,
      line: p.line,
      column: p.column,
    }));
  }

  private fileInfo(): SettingsFileInfo {
    const path = this.config.path;
    const displayPath = this.home === undefined ? tildify(path) : tildify(path, this.home);
    const source = this.config.source;
    const hasSyntaxError =
      source === "fallback" &&
      this.config.problems.some((p) => p.severity === "error" && p.line !== undefined);
    let saveNote: string | null = null;
    if (source === "fallback") {
      saveNote = hasSyntaxError
        ? "config.toml has a syntax error, so Lucy is using the default settings. Changing a setting here rewrites the file with your current settings; the broken file is first kept next to it as config.toml.broken-<time>, and also as config.toml.bak."
        : "config.toml could not be read, so Lucy is using the default settings. Changing a setting here tries to rewrite it, after backing up whatever is there.";
    }
    return {
      path,
      displayPath,
      source,
      hasSyntaxError,
      saveNote,
      statement: `Settings are saved in ${displayPath}. ${STATEMENT_TAIL}`,
    };
  }

  /** Recomputes rows, problems and file status from the current config. */
  refresh(): void {
    const state = this.store.get();
    const rows = this.buildRows(state.query);
    this.store.set({
      ...state,
      rows,
      ...this.selectionIn(rows, state.selectedPath),
      problems: this.problemViews(),
      file: this.fileInfo(),
    });
  }

  private selectionIn(
    rows: readonly SettingsRow[],
    wanted: SettingPath | null,
  ): { selectedPath: SettingPath | null; selectedIndex: number } {
    let index = wanted ? rows.findIndex((r) => r.type === "item" && r.path === wanted) : -1;
    if (index < 0) index = rows.findIndex((r) => r.type === "item");
    const row = rows[index];
    return row?.type === "item"
      ? { selectedPath: row.path, selectedIndex: index }
      : { selectedPath: null, selectedIndex: -1 };
  }

  setQuery(query: string): void {
    const state = this.store.get();
    if (state.query === query) return;
    const rows = this.buildRows(query);
    this.store.set({ ...state, query, rows, ...this.selectionIn(rows, state.selectedPath) });
  }

  /** Rows `[start, end)` for a virtualized list. */
  visibleRows(start: number, end: number): readonly SettingsRow[] {
    return this.store.get().rows.slice(Math.max(0, start), Math.max(0, end));
  }

  item(path: SettingPath): SettingItemRow | undefined {
    const row = this.store.get().rows.find((r) => r.type === "item" && r.path === path);
    if (row?.type === "item") return row;
    const descriptor = getDescriptor(path) as AnyDescriptor | undefined;
    return descriptor ? this.itemRow(descriptor, new Map()) : undefined;
  }

  select(path: SettingPath): void {
    const state = this.store.get();
    const selection = this.selectionIn(state.rows, path);
    if (selection.selectedPath === path) this.store.set({ ...state, ...selection });
  }

  /** Moves the selection by `delta` items, skipping category headers, without wrapping. */
  moveSelection(delta: number): void {
    const state = this.store.get();
    const items = state.rows.flatMap((r, i) => (r.type === "item" ? [i] : []));
    if (items.length === 0) return;
    const current = Math.max(0, items.indexOf(state.selectedIndex));
    const next = items[Math.max(0, Math.min(items.length - 1, current + delta))] ?? -1;
    const row = state.rows[next];
    if (row?.type === "item") this.store.set({ ...state, selectedPath: row.path, selectedIndex: next });
  }

  // ---- Applying changes -----------------------------------------------------------------

  private target(path?: SettingPath): AnyDescriptor | undefined {
    const resolved = path ?? this.store.get().selectedPath;
    return resolved ? (getDescriptor(resolved) as AnyDescriptor | undefined) : undefined;
  }

  private patch(partial: Partial<SettingsState>): void {
    this.store.set({ ...this.store.get(), ...partial });
  }

  /** Applies a validated value through ConfigService and reports the outcome. */
  private async apply(descriptor: AnyDescriptor, value: unknown, persist = true): Promise<boolean> {
    const path = descriptor.path as SettingPath;
    this.patch({ saving: true });
    try {
      // setMany takes an untyped value and validates it against the same schema.
      const result = await this.config.setMany([{ path, value }], { persist });
      const restartPending =
        descriptor.requiresRestart && persist && !this.store.get().restartPending.includes(path)
          ? [...this.store.get().restartPending, path]
          : this.store.get().restartPending;
      let message: SettingsMessage | null = null;
      if (result?.brokenBackupPath) {
        message = {
          severity: "info",
          text: `Saved. Your previous config.toml could not be parsed; it was kept as ${result.brokenBackupPath}.`,
          path,
        };
      } else if (descriptor.requiresRestart && persist) {
        message = {
          severity: "info",
          text: `Saved. "${descriptor.title}" takes effect after restarting Lucy.`,
          path,
        };
      }
      this.patch({ saving: false, message, restartPending });
      this.refresh();
      return true;
    } catch (error) {
      const text = isLucyError(error, "CONFIG_INVALID")
        ? errorMessage(error)
        : `Could not save config.toml (${errorMessage(error)}). The change applies to this session only.`;
      this.patch({ saving: false, message: { severity: "error", text, path } });
      this.refresh();
      return false;
    }
  }

  /** Flips a toggle. */
  async toggle(path?: SettingPath): Promise<boolean> {
    const descriptor = this.target(path);
    if (descriptor?.type !== "boolean") return this.refuse(descriptor, "toggle");
    return this.apply(descriptor, getSetting(this.config.config, descriptor.path as SettingPath) !== true);
  }

  /** Moves a select to the next (or previous) option, wrapping around. */
  async cycleOption(path?: SettingPath, direction: 1 | -1 = 1): Promise<boolean> {
    const descriptor = this.target(path);
    const options = descriptor?.options ?? [];
    if (!descriptor || options.length === 0) return this.refuse(descriptor, "select");
    const current = getSetting(this.config.config, descriptor.path as SettingPath);
    const index = options.findIndex((o) => o.value === current);
    const next = index < 0 ? 0 : (index + direction + options.length) % options.length;
    return this.apply(descriptor, options[next]?.value);
  }

  /** Picks one option of a select. */
  async pickOption(path: SettingPath, value: string): Promise<boolean> {
    const descriptor = this.target(path);
    if (!descriptor?.options?.some((o) => o.value === value)) {
      this.patch({
        message: { severity: "error", text: `"${value}" is not an option of this setting`, path },
      });
      return false;
    }
    return this.apply(descriptor, value);
  }

  /**
   * Shows an option live without saving (theme and other live-preview settings). The first
   * preview remembers the saved value; `commitPreview` saves, `cancelPreview` restores it.
   */
  async previewOption(path: SettingPath, value: string): Promise<boolean> {
    const descriptor = this.target(path);
    if (!descriptor?.livePreview || !descriptor.options?.some((o) => o.value === value)) {
      this.patch({ message: { severity: "error", text: "This setting has no live preview", path } });
      return false;
    }
    const previous = this.store.get().preview;
    if (previous && previous.path !== path) await this.cancelPreview();
    const preview =
      previous?.path === path ? previous : { path, original: getSetting(this.config.config, path) };
    this.patch({ preview });
    return this.apply(descriptor, value, false);
  }

  async commitPreview(): Promise<boolean> {
    const preview = this.store.get().preview;
    if (!preview) return false;
    this.patch({ preview: null });
    const descriptor = getDescriptor(preview.path) as AnyDescriptor;
    return this.apply(descriptor, getSetting(this.config.config, preview.path));
  }

  async cancelPreview(): Promise<boolean> {
    const preview = this.store.get().preview;
    if (!preview) return false;
    this.patch({ preview: null });
    return this.apply(getDescriptor(preview.path) as AnyDescriptor, preview.original, false);
  }

  /** Resets a setting to its default (removing it from config.toml). */
  async reset(path?: SettingPath): Promise<boolean> {
    const descriptor = this.target(path);
    if (!descriptor) return false;
    return this.apply(descriptor, descriptor.default);
  }

  /**
   * The default action for Enter on a row: toggle, cycle a select, start a text/number edit,
   * or open the Keyboard Shortcuts screen.
   */
  async activate(path?: SettingPath): Promise<boolean> {
    const descriptor = this.target(path);
    if (!descriptor) return false;
    const kind: ControlKind = controlFor(descriptor).kind;
    switch (kind) {
      case "toggle":
        return this.toggle(descriptor.path as SettingPath);
      case "select":
        return this.cycleOption(descriptor.path as SettingPath);
      case "keybindings":
        this.intents.emit({ kind: "open-keybindings" });
        return true;
      case "list":
        return this.beginAddEntry(descriptor.path as SettingPath);
      default:
        return this.beginEdit(descriptor.path as SettingPath);
    }
  }

  private refuse(descriptor: AnyDescriptor | undefined, action: string): false {
    this.patch({
      message: {
        severity: "error",
        text: descriptor
          ? `"${descriptor.title}" cannot be changed with ${action}`
          : "No setting is selected",
        path: descriptor?.path as SettingPath | undefined,
      },
    });
    return false;
  }

  // ---- Text, number, color, command and list-entry edits ---------------------------------

  private draftKindFor(descriptor: AnyDescriptor): DraftKind | null {
    switch (descriptor.type) {
      case "integer":
        return "number";
      case "string":
        return "text";
      case "enum-or-color":
        return "color";
      case "enum-or-command":
        return "command";
      default:
        return null;
    }
  }

  private validate(edit: Omit<SettingsEdit, "error">): string | null {
    const descriptor = getDescriptor(edit.path) as AnyDescriptor;
    const items = getSetting(this.config.config, edit.path);
    const result = parseDraft(descriptor, edit.kind, edit.draft, {
      items: Array.isArray(items) ? (items as string[]) : [],
      index: edit.index,
    });
    return result.ok ? null : result.error;
  }

  /** Starts a number, text, custom color or custom command edit. */
  beginEdit(path?: SettingPath): Promise<boolean> {
    const descriptor = this.target(path);
    const kind = descriptor ? this.draftKindFor(descriptor) : null;
    if (!descriptor || !kind) return Promise.resolve(this.refuse(descriptor, "text editing"));
    const settingPath = descriptor.path as SettingPath;
    const draft = initialDraft(kind, getSetting(this.config.config, settingPath));
    const base = { kind, path: settingPath, draft, index: null };
    this.patch({ edit: { ...base, error: this.validate(base) }, message: null });
    return Promise.resolve(true);
  }

  /** Starts adding an entry to a string list. */
  beginAddEntry(path?: SettingPath): Promise<boolean> {
    const descriptor = this.target(path);
    if (descriptor?.type !== "string-list") return Promise.resolve(this.refuse(descriptor, "list editing"));
    const base = {
      kind: "list-entry" as const,
      path: descriptor.path as SettingPath,
      draft: "",
      index: null,
    };
    this.patch({ edit: { ...base, error: this.validate(base) }, message: null });
    return Promise.resolve(true);
  }

  /** Starts editing one entry of a string list. */
  beginEditEntry(path: SettingPath, index: number): boolean {
    const items = getSetting(this.config.config, path);
    if (!Array.isArray(items) || index < 0 || index >= items.length) return false;
    const base = { kind: "list-entry" as const, path, draft: String(items[index]), index };
    this.patch({ edit: { ...base, error: this.validate(base) }, message: null });
    return true;
  }

  /** Updates the draft and its live validation message. */
  updateEdit(draft: string): void {
    const edit = this.store.get().edit;
    if (!edit) return;
    const next = { ...edit, draft };
    this.patch({ edit: { ...next, error: this.validate(next) } });
  }

  /** Validates and saves the draft. An invalid draft stays open with its message. */
  async commitEdit(): Promise<boolean> {
    const edit = this.store.get().edit;
    if (!edit) return false;
    const descriptor = getDescriptor(edit.path) as AnyDescriptor;
    const items = getSetting(this.config.config, edit.path);
    const result = parseDraft(descriptor, edit.kind, edit.draft, {
      items: Array.isArray(items) ? (items as string[]) : [],
      index: edit.index,
    });
    if (!result.ok) {
      this.patch({
        edit: { ...edit, error: result.error },
        message: { severity: "error", text: result.error, path: edit.path },
      });
      return false;
    }
    const ok = await this.apply(descriptor, result.value);
    if (ok) this.patch({ edit: null });
    return ok;
  }

  cancelEdit(): void {
    if (this.store.get().edit) this.patch({ edit: null });
  }

  /** Removes one entry of a string list and saves. */
  async removeEntry(path: SettingPath, index: number): Promise<boolean> {
    const descriptor = getDescriptor(path) as AnyDescriptor;
    const items = getSetting(this.config.config, path);
    if (descriptor.type !== "string-list" || !Array.isArray(items) || index < 0 || index >= items.length) {
      return this.refuse(descriptor, "removing an entry");
    }
    return this.apply(
      descriptor,
      items.filter((_, i) => i !== index),
    );
  }

  // ---- Messages and intents ---------------------------------------------------------------

  dismissMessage(): void {
    if (this.store.get().message) this.patch({ message: null });
  }

  /** Asks the app to open config.toml in the editor, at a problem's position if given. */
  openConfigFile(problem?: ConfigProblemView): SettingsIntent {
    const intent: SettingsIntent = {
      kind: "open-config-file",
      path: this.config.path,
      line: problem?.line,
      column: problem?.column,
    };
    this.intents.emit(intent);
    return intent;
  }

  onIntent(listener: (intent: SettingsIntent) => void): Disposable {
    return this.intents.on(listener);
  }

  dispose(): void {
    this.disposables.dispose();
    this.intents.dispose();
  }
}
