/**
 * The keybinding registry: default rules plus user overrides, resolution of key strokes
 * against the current context, and the reports the UI needs (hints, help, conflicts).
 *
 * Resolution policy, in order:
 * 1. Input focus: a typing stroke (printable, no ctrl/alt/super) never triggers a binding.
 * 2. Terminal focus: only rules marked `global` are considered; everything else falls
 *    through to the embedded terminal.
 * 3. A pending sequence prefix (`ctrl+k`) is completed by the next stroke or cancelled
 *    (Escape, a non-matching key, or the timeout).
 * 4. A chord that starts any applicable two-step sequence enters the pending state.
 * 5. Otherwise the applicable single-chord rule wins; user rules beat defaults, and among
 *    rules of the same source the one registered last wins.
 */
import type { KeybindingOverrides } from "../config/schema";
import { type Disposable, Emitter } from "../events";
import { type Chord, chordToString, type KeySequence, sequenceToString, tryParseKeySequence } from "./chord";
import { CONTEXT_KEYS, type ContextReader, contextFrom } from "./context-keys";
import type { KeybindingDefinition } from "./defaults";
import { isTypingStroke, type KeybindingMode, type KeyStroke, strokeCandidates } from "./key-stroke";
import { type ChordSupportOptions, sequenceSupport } from "./terminal-support";
import { evaluateWhen, parseWhen, type WhenExpr, whenOverlap } from "./when";

export type KeybindingSource = "default" | "user";

export interface KeybindingRule {
  readonly command: string;
  readonly sequence: KeySequence;
  /** Canonical sequence string, e.g. `ctrl+k ctrl+s`. */
  readonly key: string;
  readonly when?: string;
  readonly global: boolean;
  readonly args?: unknown;
  readonly source: KeybindingSource;
}

export type ResolveResult =
  | {
      readonly kind: "command";
      readonly command: string;
      readonly args?: unknown;
      readonly rule: KeybindingRule;
    }
  /** The stroke started a sequence; consume it and wait for the next one. */
  | { readonly kind: "pending"; readonly prefix: Chord }
  /** A pending sequence was abandoned by this stroke; consume it, run nothing. */
  | { readonly kind: "cancelled"; readonly prefix: Chord }
  /** No binding: let the stroke through (to the focused input or the terminal). */
  | { readonly kind: "none" };

export interface KeybindingProblem {
  severity: "warning" | "info";
  command: string;
  message: string;
  key?: string;
}

export interface KeybindingConflict {
  /**
   * - `conflict`: two rules of the same source bind the same keys in overlapping contexts.
   * - `shadow`: a user rule hides a default rule for another command (informational).
   * - `prefix`: a single chord can never fire because a sequence starts with it.
   */
  kind: "conflict" | "shadow" | "prefix";
  severity: "warning" | "info";
  key: string;
  rules: readonly [KeybindingRule, KeybindingRule];
  message: string;
}

export interface Scheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultScheduler: Scheduler = {
  setTimeout: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface KeybindingRegistryOptions {
  defaults?: readonly KeybindingDefinition[];
  mode?: KeybindingMode;
  /** How long a sequence prefix waits for its second stroke. Default 2000 ms. */
  sequenceTimeoutMs?: number;
  /** Used to warn about user bindings for commands that do not exist. */
  isKnownCommand?: (command: string) => boolean;
  scheduler?: Scheduler;
}

interface InternalRule extends KeybindingRule {
  readonly whenExpr?: WhenExpr;
}

function toRules(
  definition: KeybindingDefinition,
  source: KeybindingSource,
  keys: readonly string[],
): InternalRule[] {
  const whenExpr = definition.when ? parseWhen(definition.when) : undefined;
  return keys.map((text) => {
    const parsed = tryParseKeySequence(text);
    if (!parsed.ok) throw parsed.error;
    return {
      command: definition.command,
      sequence: parsed.sequence,
      key: sequenceToString(parsed.sequence),
      when: definition.when,
      whenExpr,
      global: definition.global === true,
      args: definition.args,
      source,
    };
  });
}

function isContextReader(value: unknown): value is ContextReader {
  return typeof (value as ContextReader | null)?.get === "function";
}

export class KeybindingRegistry implements Disposable {
  private readonly defaults: readonly KeybindingDefinition[];
  private readonly defaultRules: readonly InternalRule[];
  private userRules: InternalRule[] = [];
  private overridden = new Set<string>();
  private active: InternalRule[] = [];
  private mode: KeybindingMode;
  private readonly timeoutMs: number;
  private readonly isKnownCommand?: (command: string) => boolean;
  private readonly scheduler: Scheduler;
  private pendingPrefix: { chord: Chord; rules: InternalRule[] } | undefined;
  private pendingTimer: unknown;
  private readonly pendingChanges = new Emitter<Chord | undefined>();
  private readonly bindingChanges = new Emitter<void>();

  /** Default definitions are trusted input: an invalid chord or `when` throws immediately. */
  constructor(options: KeybindingRegistryOptions = {}) {
    this.defaults = options.defaults ?? [];
    this.defaultRules = this.defaults.flatMap((d) => toRules(d, "default", d.keys));
    this.mode = options.mode ?? "character";
    this.timeoutMs = options.sequenceTimeoutMs ?? 2000;
    this.isKnownCommand = options.isKnownCommand;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.rebuild();
  }

  setMode(mode: KeybindingMode): void {
    this.mode = mode;
  }

  /**
   * Applies `[keybindings.bindings]` from the config. Each entry replaces all default chords
   * of its command (`false` removes them). A user rule inherits `when`, `global` and `args`
   * from the command's first default definition. Invalid chords and unknown commands are
   * reported and skipped; if none of an entry's chords parse, the defaults stay.
   */
  setUserBindings(overrides: KeybindingOverrides): KeybindingProblem[] {
    const problems: KeybindingProblem[] = [];
    const rules: InternalRule[] = [];
    const overridden = new Set<string>();
    for (const [command, value] of Object.entries(overrides)) {
      const template = this.defaults.find((d) => d.command === command);
      if (!template && this.isKnownCommand && !this.isKnownCommand(command)) {
        problems.push({
          severity: "warning",
          command,
          message: `Unknown command "${command}"; shortcut ignored.`,
        });
        continue;
      }
      if (value === false) {
        overridden.add(command);
        continue;
      }
      const keys = typeof value === "string" ? [value] : value;
      const valid: string[] = [];
      for (const key of keys) {
        const parsed = tryParseKeySequence(key);
        if (parsed.ok) valid.push(key);
        else problems.push({ severity: "warning", command, key, message: parsed.error.message });
      }
      if (valid.length === 0) {
        problems.push({
          severity: "warning",
          command,
          message: `No valid shortcut for "${command}"; keeping its default shortcuts.`,
        });
        continue;
      }
      overridden.add(command);
      rules.push(...toRules({ ...(template ?? { keys: [] }), command, keys: valid }, "user", valid));
    }
    this.userRules = rules;
    this.overridden = overridden;
    this.rebuild();
    this.bindingChanges.emit();
    return problems;
  }

  private rebuild(): void {
    this.active = [...this.defaultRules.filter((r) => !this.overridden.has(r.command)), ...this.userRules];
    this.clearPending();
  }

  /** The pending sequence prefix, for a "Ctrl+K was pressed, waiting for a second key" hint. */
  get pending(): Chord | undefined {
    return this.pendingPrefix?.chord;
  }

  onDidChangePending(listener: (prefix: Chord | undefined) => void): Disposable {
    return this.pendingChanges.on(listener);
  }

  cancelPending(): void {
    this.clearPending();
  }

  private clearPending(): void {
    if (this.pendingTimer !== undefined) this.scheduler.clearTimeout(this.pendingTimer);
    this.pendingTimer = undefined;
    if (this.pendingPrefix) {
      this.pendingPrefix = undefined;
      this.pendingChanges.emit(undefined);
    }
  }

  private startPending(chord: Chord, rules: InternalRule[]): void {
    this.clearPending();
    this.pendingPrefix = { chord, rules };
    this.pendingTimer = this.scheduler.setTimeout(() => {
      this.pendingTimer = undefined;
      this.clearPending();
    }, this.timeoutMs);
    this.pendingChanges.emit(chord);
  }

  /** Resolves a key stroke in the given context. See the module comment for the policy. */
  resolve(stroke: KeyStroke, context: ContextReader | Readonly<Record<string, unknown>> = {}): ResolveResult {
    const reader = isContextReader(context) ? context : contextFrom(context);
    const lookup = (key: string) => reader.get(key);
    const terminalFocus = evaluateWhen({ kind: "key", key: CONTEXT_KEYS.terminalFocus }, lookup);
    const inputFocus = evaluateWhen({ kind: "key", key: CONTEXT_KEYS.inputFocus }, lookup);
    const applicable = (rule: InternalRule) =>
      (!terminalFocus || rule.global) && (!rule.whenExpr || evaluateWhen(rule.whenExpr, lookup));
    const candidates = strokeCandidates(stroke, this.mode).map(chordToString);

    if (this.pendingPrefix) {
      const prefix = this.pendingPrefix.chord;
      const waiting = this.pendingPrefix.rules;
      this.clearPending();
      for (const candidate of candidates) {
        for (let i = waiting.length - 1; i >= 0; i--) {
          const rule = waiting[i];
          if (!rule || rule.sequence.length < 2 || !applicable(rule)) continue;
          if (chordToString(rule.sequence[1] as Chord) === candidate) {
            return { kind: "command", command: rule.command, args: rule.args, rule };
          }
        }
      }
      return { kind: "cancelled", prefix };
    }

    if (inputFocus && isTypingStroke(stroke)) return { kind: "none" };

    const ordered = this.precedenceOrder().filter(applicable);
    for (const candidate of candidates) {
      const starts = ordered.filter(
        (rule) => rule.sequence.length > 1 && chordToString(rule.sequence[0] as Chord) === candidate,
      );
      if (starts.length > 0) {
        this.startPending(starts[0]?.sequence[0] as Chord, [...starts].reverse());
        return { kind: "pending", prefix: starts[0]?.sequence[0] as Chord };
      }
      const single = ordered.find((rule) => rule.sequence.length === 1 && rule.key === candidate);
      if (single) return { kind: "command", command: single.command, args: single.args, rule: single };
    }
    return { kind: "none" };
  }

  /** Rules from highest to lowest precedence: user before default, later before earlier. */
  private precedenceOrder(): InternalRule[] {
    const users = this.active.filter((r) => r.source === "user").reverse();
    const defaults = this.active.filter((r) => r.source === "default").reverse();
    return [...users, ...defaults];
  }

  /**
   * Active key sequences for a command, preferred first: for menus, the palette and hints.
   * With `support`, sequences that work in that terminal are listed before those that do not.
   */
  bindingsFor(command: string, support?: ChordSupportOptions): KeySequence[] {
    const rules = this.active.filter((r) => r.command === command);
    const ordered = [
      ...rules.filter((r) => r.source === "user"),
      ...rules.filter((r) => r.source === "default"),
    ];
    const sequences = ordered.map((r) => r.sequence);
    if (!support) return sequences;
    const works = (s: KeySequence) => sequenceSupport(s, support).ok;
    return [...sequences.filter(works), ...sequences.filter((s) => !works(s))];
  }

  /** Every active rule, for the keyboard shortcuts help screen. */
  all(): KeybindingRule[] {
    return this.active.map(({ whenExpr: _ignored, ...rule }) => rule);
  }

  /** The built-in rules of a command, whether or not a user override hides them. */
  defaultRulesFor(command: string): KeybindingRule[] {
    return this.defaultRules
      .filter((r) => r.command === command)
      .map(({ whenExpr: _ignored, ...rule }) => rule);
  }

  /** Every command that has a default or user binding, in definition order. */
  commandIds(): string[] {
    return [...new Set([...this.defaultRules, ...this.userRules].map((r) => r.command))];
  }

  /** Fires after `setUserBindings` replaced the user rules (for views listing bindings). */
  onDidChangeBindings(listener: () => void): Disposable {
    return this.bindingChanges.on(listener);
  }

  /** Overlapping bindings. See `KeybindingConflict` for the kinds. */
  conflicts(): KeybindingConflict[] {
    const out: KeybindingConflict[] = [];
    const rules = this.active;
    for (let i = 0; i < rules.length; i++) {
      for (let j = i + 1; j < rules.length; j++) {
        const a = rules[i];
        const b = rules[j];
        if (!a || !b || a.command === b.command) continue;
        if (!whenOverlap(a.whenExpr, b.whenExpr)) continue;
        const firstA = chordToString(a.sequence[0] as Chord);
        const firstB = chordToString(b.sequence[0] as Chord);
        if (a.key === b.key) {
          const shadow = a.source !== b.source;
          const [low, high] = a.source === "user" ? [b, a] : [a, b];
          out.push({
            kind: shadow ? "shadow" : "conflict",
            severity: shadow ? "info" : "warning",
            key: a.key,
            rules: [low, high],
            message: shadow
              ? `Your shortcut ${a.key} for "${high.command}" replaces the default for "${low.command}".`
              : `${a.key} is bound to both "${a.command}" and "${b.command}" in overlapping contexts.`,
          });
        } else if (firstA === firstB && a.sequence.length !== b.sequence.length) {
          const [single, sequence] = a.sequence.length === 1 ? [a, b] : [b, a];
          out.push({
            kind: "prefix",
            severity: "warning",
            key: single.key,
            rules: [single, sequence],
            message: `${single.key} ("${single.command}") never fires because ${sequence.key} ("${sequence.command}") starts with it.`,
          });
        }
      }
    }
    return out;
  }

  dispose(): void {
    this.clearPending();
    this.pendingChanges.dispose();
    this.bindingChanges.dispose();
  }
}
