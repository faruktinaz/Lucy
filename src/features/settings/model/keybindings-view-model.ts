/**
 * View model of the Keyboard Shortcuts screen: every command with its bindings, and
 * remapping as an explicit state machine (idle -> capturing -> review -> idle).
 *
 * Overrides are written to `[keybindings.bindings]` through ConfigService (validated,
 * persisted with backups) and applied to the registry immediately. An override lists all
 * of a command's chords, because a user entry replaces the command's defaults.
 */
import type { CommandRegistry } from "@/core/commands/registry";
import type { KeybindingOverride, KeybindingOverrides } from "@/core/config/schema";
import type { ConfigService } from "@/core/config/service";
import { cloneValue } from "@/core/config/values";
import { errorMessage } from "@/core/errors";
import { type Disposable, DisposableStore } from "@/core/events";
import {
  type Chord,
  type ChordFormatStyle,
  chordToString,
  formatChord,
  type KeySequence,
  sequenceToString,
} from "@/core/keybindings/chord";
import {
  isTypingStroke,
  type KeybindingMode,
  type KeyStroke,
  strokeCandidates,
} from "@/core/keybindings/key-stroke";
import type { KeybindingProblem, KeybindingRegistry, KeybindingRule } from "@/core/keybindings/registry";
import {
  type ChordSupport,
  type ChordSupportOptions,
  sequenceSupport,
} from "@/core/keybindings/terminal-support";
import { parseWhen, whenOverlap } from "@/core/keybindings/when";
import { Store } from "@/core/store";
import { foldText, matchesTerms, queryTerms } from "./text-match";

export interface BindingView {
  /** Canonical sequence, e.g. `ctrl+k ctrl+s`. */
  readonly key: string;
  /** Display label in the configured style, e.g. `⌃K ⌃S` or `Ctrl+K Ctrl+S`. */
  readonly label: string;
  readonly source: "default" | "user";
  readonly when?: string;
  /** Works while the terminal has focus. */
  readonly global: boolean;
  readonly support: ChordSupport;
  /** One-line reason when this chord cannot work (or is unreliable) in this terminal. */
  readonly warning: string | null;
  /** Conflict messages involving this binding. */
  readonly conflicts: readonly string[];
}

export interface CommandRow {
  readonly type: "command";
  readonly id: string;
  readonly title: string;
  readonly category: string;
  /** False when a binding names a command no feature has registered (yet). */
  readonly registered: boolean;
  readonly bindings: readonly BindingView[];
  /** Labels of the built-in chords, shown when the user changed them. */
  readonly defaultLabels: readonly string[];
  /** The user has an override for this command (including "no shortcut"). */
  readonly modified: boolean;
}

export interface CategoryRow {
  readonly type: "category";
  readonly category: string;
  readonly count: number;
}

export type KeybindingsRow = CategoryRow | CommandRow;

export interface CaptureConflict {
  readonly command: string;
  readonly title: string;
  readonly key: string;
  readonly label: string;
  /** `same`: identical keys. `prefix`: one is the first step of the other. */
  readonly kind: "same" | "prefix";
}

export type CaptureState =
  | { readonly phase: "idle" }
  | {
      readonly phase: "capturing";
      readonly command: string;
      readonly title: string;
      /** The binding being replaced, or null when adding one. */
      readonly replacing: string | null;
      readonly steps: readonly Chord[];
      readonly label: string;
      readonly hint: string;
    }
  | {
      readonly phase: "review";
      readonly command: string;
      readonly title: string;
      readonly replacing: string | null;
      readonly key: string;
      readonly label: string;
      readonly support: ChordSupport;
      readonly warning: string | null;
      readonly conflicts: readonly CaptureConflict[];
      /** Set when the chord cannot be saved (reserved, or already bound to this command). */
      readonly refusal: string | null;
    };

export interface KeybindingsMessage {
  readonly severity: "error" | "warning" | "info" | "success";
  readonly text: string;
}

export interface KeybindingsState {
  readonly query: string;
  readonly rows: readonly KeybindingsRow[];
  readonly selectedCommand: string | null;
  readonly selectedIndex: number;
  readonly capture: CaptureState;
  readonly saving: boolean;
  readonly message: KeybindingsMessage | null;
  /** Problems reported when applying `[keybindings.bindings]` (unknown commands, bad chords). */
  readonly problems: readonly KeybindingProblem[];
}

export interface KeybindingsViewModelOptions {
  registry: KeybindingRegistry;
  commands: CommandRegistry;
  config: ConfigService;
  /** What the current terminal can deliver (kitty protocol, platform, Option-as-Alt). */
  support: ChordSupportOptions;
  /** Label style; defaults to `mac` on macOS and `text` elsewhere. */
  style?: ChordFormatStyle;
  /** Must match the registry's mode so captured chords are the ones that will match. */
  mode?: KeybindingMode;
}

const IDLE: CaptureState = { phase: "idle" };

const AREA_CATEGORIES: Readonly<Record<string, string>> = {
  palette: "General",
  app: "General",
  view: "View",
  file: "File",
  editor: "Editor",
  terminal: "Terminal",
  git: "Source Control",
  search: "Search",
  help: "Help",
  ai: "AI",
  theme: "Preferences",
  settings: "Preferences",
  keybindings: "Preferences",
};

const MODIFIER_KEYS = new Set([
  "shift",
  "ctrl",
  "control",
  "alt",
  "option",
  "meta",
  "super",
  "cmd",
  "capslock",
  "hyper",
]);

/** "view.toggleSidebar" -> "Toggle Sidebar" for commands no feature registered. */
function humanize(id: string): string {
  const last = id.slice(id.lastIndexOf(".") + 1);
  const words = last.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i]);
}

export class KeybindingsViewModel implements Disposable {
  readonly store: Store<KeybindingsState>;
  private readonly registry: KeybindingRegistry;
  private readonly commands: CommandRegistry;
  private readonly config: ConfigService;
  private support: ChordSupportOptions;
  private readonly style: ChordFormatStyle;
  private readonly mode: KeybindingMode;
  private readonly disposables = new DisposableStore();

  constructor(options: KeybindingsViewModelOptions) {
    this.registry = options.registry;
    this.commands = options.commands;
    this.config = options.config;
    this.support = options.support;
    this.style =
      options.style ?? ((options.support.platform ?? process.platform) === "darwin" ? "mac" : "text");
    this.mode = options.mode ?? "character";
    const rows = this.buildRows("");
    const first = rows.find((r): r is CommandRow => r.type === "command");
    this.store = new Store<KeybindingsState>({
      query: "",
      rows,
      selectedCommand: first?.id ?? null,
      selectedIndex: first ? rows.indexOf(first) : -1,
      capture: IDLE,
      saving: false,
      message: null,
      problems: [],
    });
    this.disposables.add(this.registry.onDidChangeBindings(() => this.refresh()));
    this.disposables.add(this.commands.onDidChangeCommands(() => this.refresh()));
  }

  get state(): KeybindingsState {
    return this.store.get();
  }

  private patch(partial: Partial<KeybindingsState>): void {
    this.store.set({ ...this.store.get(), ...partial });
  }

  /**
   * Updates what the terminal can deliver (the renderer learns about the kitty protocol after
   * startup); warnings are recomputed.
   */
  setSupport(support: ChordSupportOptions): void {
    if (
      support.kittyKeyboard === this.support.kittyKeyboard &&
      support.platform === this.support.platform &&
      support.optionAsAlt === this.support.optionAsAlt
    ) {
      return;
    }
    this.support = support;
    this.refresh();
  }

  label(sequence: KeySequence | string): string {
    return formatChord(sequence, this.style, { platform: this.support.platform });
  }

  private warningFor(support: ChordSupport): string | null {
    return support.ok ? null : support.reason;
  }

  // ---- Rows ----------------------------------------------------------------------------------

  private titleOf(id: string): { title: string; category: string; registered: boolean } {
    const command = this.commands.get(id);
    if (command) return { title: command.title, category: command.category, registered: true };
    const area = id.slice(0, id.indexOf("."));
    return { title: humanize(id), category: AREA_CATEGORIES[area] ?? "Other", registered: false };
  }

  private commandIdsInView(): string[] {
    const listed = this.commands.list().map((c) => c.id);
    return [...new Set([...this.registry.commandIds(), ...listed, ...Object.keys(this.overrides())])];
  }

  private buildRows(query: string): KeybindingsRow[] {
    const terms = queryTerms(query);
    // "Ctrl+K Ctrl+S" or "⌃K" is a chord, matched as one phrase against bindings: matching
    // its words separately would also find ctrl+shift+e next to ctrl+k e.
    const chordQuery = /[+⌃⌥⇧⌘]/.test(query) ? foldText(query.trim()).replace(/\s+/g, " ") : null;
    const conflictMessages = new Map<string, string[]>();
    for (const conflict of this.registry.conflicts()) {
      for (const rule of conflict.rules) {
        const id = `${rule.command}\u0000${rule.key}`;
        conflictMessages.set(id, [...(conflictMessages.get(id) ?? []), conflict.message]);
      }
    }
    const active = this.registry.all();
    const overrides = this.overrides();
    const byCategory = new Map<string, CommandRow[]>();
    for (const id of this.commandIdsInView()) {
      const { title, category, registered } = this.titleOf(id);
      const rules = [
        ...active.filter((r) => r.command === id && r.source === "user"),
        ...active.filter((r) => r.command === id && r.source === "default"),
      ];
      const bindings = rules.map((rule) => this.bindingView(rule, conflictMessages));
      const matches = chordQuery
        ? bindings.some((b) => foldText(b.key).includes(chordQuery) || foldText(b.label).includes(chordQuery))
        : matchesTerms(terms, [title, id, category, ...bindings.flatMap((b) => [b.key, b.label])]);
      if (!matches) continue;
      const row: CommandRow = {
        type: "command",
        id,
        title,
        category,
        registered,
        bindings,
        defaultLabels: this.registry.defaultRulesFor(id).map((r) => this.label(r.sequence)),
        modified: Object.hasOwn(overrides, id),
      };
      byCategory.set(category, [...(byCategory.get(category) ?? []), row]);
    }
    const rows: KeybindingsRow[] = [];
    for (const category of [...byCategory.keys()].sort((a, b) => a.localeCompare(b))) {
      const items = (byCategory.get(category) ?? []).sort((a, b) => a.title.localeCompare(b.title));
      rows.push({ type: "category", category, count: items.length }, ...items);
    }
    return rows;
  }

  private bindingView(rule: KeybindingRule, conflicts: Map<string, string[]>): BindingView {
    const support = sequenceSupport(rule.sequence, this.support);
    return {
      key: rule.key,
      label: this.label(rule.sequence),
      source: rule.source,
      when: rule.when,
      global: rule.global,
      support,
      warning: this.warningFor(support),
      conflicts: conflicts.get(`${rule.command}\u0000${rule.key}`) ?? [],
    };
  }

  refresh(): void {
    const state = this.store.get();
    const rows = this.buildRows(state.query);
    this.store.set({ ...state, rows, ...this.selectionIn(rows, state.selectedCommand) });
  }

  private selectionIn(rows: readonly KeybindingsRow[], wanted: string | null) {
    let index = wanted ? rows.findIndex((r) => r.type === "command" && r.id === wanted) : -1;
    if (index < 0) index = rows.findIndex((r) => r.type === "command");
    const row = rows[index];
    return row?.type === "command"
      ? { selectedCommand: row.id, selectedIndex: index }
      : { selectedCommand: null, selectedIndex: -1 };
  }

  /** Filters by command title, id, category or chord (canonical or displayed). */
  setQuery(query: string): void {
    const state = this.store.get();
    if (state.query === query) return;
    const rows = this.buildRows(query);
    this.store.set({ ...state, query, rows, ...this.selectionIn(rows, state.selectedCommand) });
  }

  visibleRows(start: number, end: number): readonly KeybindingsRow[] {
    return this.store.get().rows.slice(Math.max(0, start), Math.max(0, end));
  }

  row(command: string): CommandRow | undefined {
    const row = this.store.get().rows.find((r) => r.type === "command" && r.id === command);
    return row?.type === "command" ? row : undefined;
  }

  select(command: string): void {
    const state = this.store.get();
    const selection = this.selectionIn(state.rows, command);
    if (selection.selectedCommand === command) this.store.set({ ...state, ...selection });
  }

  moveSelection(delta: number): void {
    const state = this.store.get();
    const items = state.rows.flatMap((r, i) => (r.type === "command" ? [i] : []));
    if (items.length === 0) return;
    const current = Math.max(0, items.indexOf(state.selectedIndex));
    const next = items[Math.max(0, Math.min(items.length - 1, current + delta))] ?? -1;
    const row = state.rows[next];
    if (row?.type === "command") this.store.set({ ...state, selectedCommand: row.id, selectedIndex: next });
  }

  // ---- Capture --------------------------------------------------------------------------------

  /**
   * Starts recording a shortcut for `command`. While capturing, the UI routes every key
   * stroke to `captureStroke`. Escape cancels, Enter accepts a one-step chord, and a second
   * chord makes a two-step sequence (which is accepted automatically).
   */
  beginCapture(command: string, options: { replace?: string } = {}): CaptureState {
    const capture: CaptureState = {
      phase: "capturing",
      command,
      title: this.titleOf(command).title,
      replacing: options.replace ?? null,
      steps: [],
      label: "",
      hint: "Press the shortcut. Escape cancels.",
    };
    this.patch({ capture, message: null, selectedCommand: command });
    return capture;
  }

  captureStroke(stroke: KeyStroke): CaptureState {
    const capture = this.store.get().capture;
    if (capture.phase !== "capturing") return capture;
    const plain = !stroke.ctrl && !stroke.alt && !stroke.shift && !stroke.super;
    const key = stroke.key.toLowerCase();
    if (plain && (key === "escape" || key === "esc")) return this.cancel();
    if (plain && (key === "enter" || key === "return")) {
      if (capture.steps.length > 0) return this.finishCapture();
      return capture;
    }
    if (MODIFIER_KEYS.has(key)) return capture;
    const chord = strokeCandidates(stroke, this.mode)[0];
    if (!chord) return capture;
    const steps = [...capture.steps, chord];
    if (steps.length >= 2) {
      this.patch({ capture: { ...capture, steps, label: this.label(steps) } });
      return this.finishCapture();
    }
    const next: CaptureState = {
      ...capture,
      steps,
      label: this.label(steps),
      hint: `Press Enter to use ${this.label(steps)}, or another key to make a two-step shortcut.`,
    };
    this.patch({ capture: next });
    return next;
  }

  /** Ends recording and shows the label, support warning and conflicts before saving. */
  finishCapture(): CaptureState {
    const capture = this.store.get().capture;
    if (capture.phase !== "capturing" || capture.steps.length === 0) return capture;
    const sequence = capture.steps;
    const key = sequenceToString(sequence);
    const support = sequenceSupport(sequence, this.support);
    const conflicts = this.conflictsFor(capture.command, sequence, capture.replacing);
    let refusal: string | null = null;
    if (!support.ok && support.severity === "reserved")
      refusal = `${this.label(sequence)} cannot be used: ${support.reason}`;
    else if (this.effectiveKeys(capture.command).includes(key) && key !== capture.replacing) {
      refusal = `${this.label(sequence)} is already a shortcut for "${capture.title}".`;
    }
    let warning = this.warningFor(support);
    if (!warning && sequence.length === 1 && isTypingStroke(this.strokeOf(sequence[0] as Chord))) {
      warning = "A key without Ctrl or Alt does nothing while you are typing in a text field.";
    }
    const review: CaptureState = {
      phase: "review",
      command: capture.command,
      title: capture.title,
      replacing: capture.replacing,
      key,
      label: this.label(sequence),
      support,
      warning,
      conflicts,
      refusal,
    };
    this.patch({ capture: review });
    return review;
  }

  private strokeOf(chord: Chord): KeyStroke {
    return { key: chord.key, ctrl: chord.ctrl, alt: chord.alt, shift: chord.shift, super: chord.super };
  }

  private whenOf(command: string): string | undefined {
    return (
      this.registry.defaultRulesFor(command)[0] ?? this.registry.all().find((r) => r.command === command)
    )?.when;
  }

  private conflictsFor(command: string, sequence: KeySequence, replacing: string | null): CaptureConflict[] {
    const key = sequenceToString(sequence);
    const first = chordToString(sequence[0] as Chord);
    const ownWhen = this.whenOf(command);
    const ownExpr = ownWhen ? parseWhen(ownWhen) : undefined;
    const out: CaptureConflict[] = [];
    for (const rule of this.registry.all()) {
      if (rule.command === command) continue;
      if (rule.key === replacing) continue;
      const ruleFirst = chordToString(rule.sequence[0] as Chord);
      const kind =
        rule.key === key
          ? "same"
          : ruleFirst === first && rule.sequence.length !== sequence.length
            ? "prefix"
            : null;
      if (!kind) continue;
      if (!whenOverlap(ownExpr, rule.when ? parseWhen(rule.when) : undefined)) continue;
      out.push({
        command: rule.command,
        title: this.titleOf(rule.command).title,
        key: rule.key,
        label: this.label(rule.sequence),
        kind,
      });
    }
    return out;
  }

  /**
   * Saves the reviewed shortcut. With `replaceConflicts`, identical shortcuts are removed
   * from the other commands first, so the new one is the only owner of the keys.
   */
  async confirm(options: { replaceConflicts?: boolean } = {}): Promise<boolean> {
    const capture = this.store.get().capture;
    if (capture.phase !== "review") return false;
    if (capture.refusal) {
      this.patch({ message: { severity: "error", text: capture.refusal } });
      return false;
    }
    const current = this.effectiveKeys(capture.command);
    const keys = capture.replacing
      ? current.map((k) => (k === capture.replacing ? capture.key : k))
      : [...current, capture.key];
    const next: Record<string, string[]> = { [capture.command]: [...new Set(keys)] };
    if (options.replaceConflicts) {
      for (const conflict of capture.conflicts) {
        if (conflict.kind !== "same") continue;
        next[conflict.command] = (next[conflict.command] ?? this.effectiveKeys(conflict.command)).filter(
          (k) => k !== conflict.key,
        );
      }
    }
    const ok = await this.write(next);
    if (ok) {
      this.patch({
        capture: IDLE,
        message: { severity: "success", text: `${capture.label} now runs "${capture.title}".` },
      });
    }
    return ok;
  }

  /** Discards the capture or review. */
  cancel(): CaptureState {
    this.patch({ capture: IDLE });
    return IDLE;
  }

  // ---- Direct edits ---------------------------------------------------------------------------

  /** Removes one shortcut from a command (the command keeps its others, or has none). */
  async removeBinding(command: string, key: string): Promise<boolean> {
    const current = this.effectiveKeys(command);
    if (!current.includes(key)) {
      this.patch({ message: { severity: "error", text: `"${key}" is not a shortcut of this command.` } });
      return false;
    }
    return this.write({ [command]: current.filter((k) => k !== key) });
  }

  /** Drops the user's override so the command has its built-in shortcuts again. */
  async resetToDefault(command: string): Promise<boolean> {
    const overrides = this.overrides();
    if (!Object.hasOwn(overrides, command)) return true;
    const next = { ...overrides };
    delete next[command];
    return this.persist(next);
  }

  // ---- Persistence ----------------------------------------------------------------------------

  private overrides(): KeybindingOverrides {
    return this.config.get("keybindings.bindings");
  }

  /** Current chords of a command as canonical strings, user rules first. */
  effectiveKeys(command: string): string[] {
    return this.registry.bindingsFor(command).map(sequenceToString);
  }

  /** Turns per-command key lists into overrides, normalizing "same as default" away. */
  private async write(changes: Record<string, string[]>): Promise<boolean> {
    const next: KeybindingOverrides = cloneValue(this.overrides());
    for (const [command, keys] of Object.entries(changes)) {
      const defaults = this.registry.defaultRulesFor(command).map((r) => r.key);
      let value: KeybindingOverride | undefined;
      if (sameKeys(keys, defaults)) value = undefined;
      else if (keys.length === 0) value = defaults.length > 0 ? false : undefined;
      else value = keys.length === 1 ? (keys[0] as string) : keys;
      if (value === undefined) delete next[command];
      else next[command] = value;
    }
    return this.persist(next);
  }

  private async persist(next: KeybindingOverrides): Promise<boolean> {
    this.patch({ saving: true });
    try {
      await this.config.set("keybindings.bindings", next);
      const problems = this.registry.setUserBindings(next);
      this.patch({ saving: false, problems, message: null });
      this.refresh();
      return true;
    } catch (error) {
      this.patch({
        saving: false,
        message: { severity: "error", text: `Could not save the shortcut: ${errorMessage(error)}` },
      });
      return false;
    }
  }

  dispose(): void {
    this.disposables.dispose();
  }
}

/** Convenience for the app: keeps a registry in sync with the config's overrides. */
export function syncUserBindings(registry: KeybindingRegistry, config: ConfigService): Disposable {
  registry.setUserBindings(config.get("keybindings.bindings"));
  return config.onDidChange((event) => {
    if (event.changed.includes("keybindings.bindings"))
      registry.setUserBindings(event.config.keybindings.bindings);
  });
}
