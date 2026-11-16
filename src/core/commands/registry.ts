/**
 * The command registry: every user-visible action (palette entries, menu items, keybinding
 * targets) is a command with a stable id of the form `area.verbNoun` (`view.toggleSidebar`,
 * `file.quickOpen`, `git.commit`, `ai.newSession`, `theme.select`).
 *
 * Nothing fails silently: `execute` rejects for unknown or disabled commands and for
 * failures inside `run`, and every failure is also emitted on `onDidFail` so the UI can show
 * it even when the caller (a keybinding) does not await the result.
 */
import { LucyError } from "../errors";
import { type Disposable, Emitter, toDisposable } from "../events";
import { type ContextReader, contextFrom } from "../keybindings/context-keys";
import { evaluateWhen, parseWhen, type WhenExpr } from "../keybindings/when";

export const COMMAND_ID_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

export interface CommandDefinition {
  /** `area.verbNoun`, e.g. `view.toggleSidebar`. */
  id: string;
  /** Short imperative title shown in the palette: "Toggle Sidebar". */
  title: string;
  /** Palette group: "View", "File", "Git", "AI", "Preferences". */
  category: string;
  description?: string;
  /** Extra search terms for the palette. */
  keywords?: readonly string[];
  run: (args?: unknown) => unknown;
  /**
   * Whether the command can run now: a `when` expression or a function. Disabled commands
   * stay listed (greyed) and `execute` rejects them.
   */
  enabled?: string | (() => boolean);
  /** Visibility: when false the command is not listed (it can still be executed). */
  when?: string;
  /** Never listed in the palette (internal commands, keybinding-only actions). */
  hidden?: boolean;
}

export interface CommandListEntry {
  id: string;
  title: string;
  category: string;
  description?: string;
  keywords: readonly string[];
  enabled: boolean;
  hidden: boolean;
}

export interface CommandExecutionEvent {
  id: string;
  args?: unknown;
  ok: boolean;
  durationMs: number;
  error?: unknown;
}

export interface CommandFailureEvent {
  id: string;
  args?: unknown;
  error: unknown;
}

export interface CommandRegistryOptions {
  /** Context used for `enabled` and `when` expressions. */
  context?: ContextReader;
  /** Length of the most-recently-used list. Default 20. */
  recentLimit?: number;
}

interface Entry {
  definition: CommandDefinition;
  enabledExpr?: WhenExpr;
  whenExpr?: WhenExpr;
}

function readerFrom(context: ContextReader | Readonly<Record<string, unknown>> | undefined): ContextReader {
  if (!context) return contextFrom({});
  return typeof (context as ContextReader).get === "function"
    ? (context as ContextReader)
    : contextFrom(context as Readonly<Record<string, unknown>>);
}

export class CommandRegistry implements Disposable {
  private readonly commands = new Map<string, Entry>();
  private readonly context?: ContextReader;
  private readonly recentLimit: number;
  private recent: string[] = [];
  private readonly executions = new Emitter<CommandExecutionEvent>();
  private readonly failures = new Emitter<CommandFailureEvent>();
  private readonly registrations = new Emitter<{ id: string; registered: boolean }>();

  constructor(options: CommandRegistryOptions = {}) {
    this.context = options.context;
    this.recentLimit = options.recentLimit ?? 20;
  }

  /**
   * Registers a command. Throws `INVALID_ARGUMENT` for a malformed id or `when`/`enabled`
   * expression and `ALREADY_EXISTS` for a duplicate id. Disposing unregisters it.
   *
   * `replace: true` lets a feature take over a command another module registered (the
   * Settings feature's Keyboard Shortcuts editor replaces the workbench's simple list). The
   * takeover is explicit so accidental duplicates still fail; disposing the replacement
   * restores the previous definition.
   */
  register(definition: CommandDefinition, options: { replace?: boolean } = {}): Disposable {
    if (!COMMAND_ID_PATTERN.test(definition.id)) {
      throw new LucyError(
        "INVALID_ARGUMENT",
        `Command id "${definition.id}" must look like "area.verbNoun"`,
        {
          details: { id: definition.id },
        },
      );
    }
    const previous = this.commands.get(definition.id);
    if (previous && !options.replace) {
      throw new LucyError("ALREADY_EXISTS", `Command "${definition.id}" is already registered`, {
        details: { id: definition.id },
      });
    }
    const entry: Entry = {
      definition,
      enabledExpr: typeof definition.enabled === "string" ? parseWhen(definition.enabled) : undefined,
      whenExpr: definition.when ? parseWhen(definition.when) : undefined,
    };
    this.commands.set(definition.id, entry);
    this.registrations.emit({ id: definition.id, registered: true });
    return toDisposable(() => {
      if (this.commands.get(definition.id) !== entry) return;
      if (previous) {
        this.commands.set(definition.id, previous);
        this.registrations.emit({ id: definition.id, registered: true });
        return;
      }
      this.commands.delete(definition.id);
      this.registrations.emit({ id: definition.id, registered: false });
    });
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  get(id: string): CommandDefinition | undefined {
    return this.commands.get(id)?.definition;
  }

  private checkEnabled(entry: Entry, reader: ContextReader): boolean {
    const { enabled } = entry.definition;
    if (typeof enabled === "function") {
      try {
        return enabled();
      } catch {
        return false;
      }
    }
    return !entry.enabledExpr || evaluateWhen(entry.enabledExpr, (key) => reader.get(key));
  }

  /** Whether `execute(id)` would run now (registered and enabled). */
  canExecute(id: string, context?: ContextReader | Readonly<Record<string, unknown>>): boolean {
    const entry = this.commands.get(id);
    return entry !== undefined && this.checkEnabled(entry, readerFrom(context ?? this.context));
  }

  /**
   * Commands for the palette, in registration order. Hidden commands and commands whose
   * `when` is false are left out unless `includeHidden` is set.
   */
  list(
    options: { context?: ContextReader | Readonly<Record<string, unknown>>; includeHidden?: boolean } = {},
  ): CommandListEntry[] {
    const reader = readerFrom(options.context ?? this.context);
    const out: CommandListEntry[] = [];
    for (const entry of this.commands.values()) {
      const { definition } = entry;
      const visible = !entry.whenExpr || evaluateWhen(entry.whenExpr, (key) => reader.get(key));
      const hidden = definition.hidden === true || !visible;
      if (hidden && !options.includeHidden) continue;
      out.push({
        id: definition.id,
        title: definition.title,
        category: definition.category,
        description: definition.description,
        keywords: definition.keywords ?? [],
        enabled: this.checkEnabled(entry, reader),
        hidden,
      });
    }
    return out;
  }

  /**
   * Runs a command. Rejects with `NOT_FOUND` for an unknown id, `UNSUPPORTED` when it is
   * disabled, or with whatever `run` threw. Failures are also emitted on `onDidFail`.
   */
  async execute(id: string, args?: unknown): Promise<unknown> {
    const started = performance.now();
    const entry = this.commands.get(id);
    try {
      if (!entry) throw new LucyError("NOT_FOUND", `Unknown command "${id}"`, { details: { id } });
      if (!this.checkEnabled(entry, readerFrom(this.context))) {
        throw new LucyError("UNSUPPORTED", `"${entry.definition.title}" is not available right now`, {
          details: { id },
        });
      }
      const result = await entry.definition.run(args);
      if (!entry.definition.hidden) this.noteRecent(id);
      this.executions.emit({ id, args, ok: true, durationMs: performance.now() - started });
      return result;
    } catch (error) {
      this.executions.emit({ id, args, ok: false, durationMs: performance.now() - started, error });
      this.failures.emit({ id, args, error });
      throw error;
    }
  }

  private noteRecent(id: string): void {
    this.recent = [id, ...this.recent.filter((existing) => existing !== id)].slice(0, this.recentLimit);
  }

  /** Most recently executed command ids, newest first. */
  getRecent(): string[] {
    return [...this.recent];
  }

  /** Restores a persisted MRU list. Duplicates are dropped and the list is capped. */
  setRecent(ids: readonly string[]): void {
    const unique: string[] = [];
    for (const id of ids) {
      if (typeof id === "string" && COMMAND_ID_PATTERN.test(id) && !unique.includes(id)) unique.push(id);
    }
    this.recent = unique.slice(0, this.recentLimit);
  }

  onDidExecute(listener: (event: CommandExecutionEvent) => void): Disposable {
    return this.executions.on(listener);
  }

  onDidFail(listener: (event: CommandFailureEvent) => void): Disposable {
    return this.failures.on(listener);
  }

  onDidChangeCommands(listener: (event: { id: string; registered: boolean }) => void): Disposable {
    return this.registrations.on(listener);
  }

  dispose(): void {
    this.executions.dispose();
    this.failures.dispose();
    this.registrations.dispose();
    this.commands.clear();
  }
}
