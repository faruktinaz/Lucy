/**
 * Context keys: small named facts about the UI state (`terminalFocus`, `sidebarView`) that
 * `when` clauses read. The UI sets them as focus and views change.
 */
import { type Disposable, Emitter } from "../events";
import { evaluateWhen, parseWhen, type WhenExpr } from "./when";

/** Context keys with a built-in meaning. Features may add their own. */
export const CONTEXT_KEYS = {
  /** The embedded terminal (shell or Claude Code) has keyboard focus. Only global bindings apply. */
  terminalFocus: "terminalFocus",
  /** A text input has focus. Printable keys without ctrl/alt/super never trigger bindings. */
  inputFocus: "inputFocus",
  /** The code viewer has focus. */
  editorFocus: "editorFocus",
  /** The sidebar has focus. */
  sidebarFocus: "sidebarFocus",
  /** The visible sidebar view: "explorer", "search" or "scm". */
  sidebarView: "sidebarView",
  /** The commit message input has focus. */
  scmInputFocus: "scmInputFocus",
  /** A modal overlay (palette, dialog) is open. */
  overlayOpen: "overlayOpen",
} as const;

export interface ContextReader {
  get(key: string): unknown;
}

/** Wraps a plain object as a context (tests, one-off evaluation). */
export function contextFrom(values: Readonly<Record<string, unknown>>): ContextReader {
  return { get: (key) => values[key] };
}

export interface ContextChangeEvent {
  keys: string[];
}

export class ContextKeys implements ContextReader, Disposable {
  private readonly values = new Map<string, unknown>();
  private readonly parsed = new Map<string, WhenExpr>();
  private readonly changes = new Emitter<ContextChangeEvent>();

  get(key: string): unknown {
    return this.values.get(key);
  }

  /** Sets a key; `undefined` removes it. Emits only when the value actually changes. */
  set(key: string, value: unknown): void {
    this.setMany({ [key]: value });
  }

  /** Sets several keys and emits a single change event. */
  setMany(entries: Readonly<Record<string, unknown>>): void {
    const changed: string[] = [];
    for (const [key, value] of Object.entries(entries)) {
      if (Object.is(this.values.get(key), value) && (value !== undefined || !this.values.has(key))) continue;
      if (value === undefined) this.values.delete(key);
      else this.values.set(key, value);
      changed.push(key);
    }
    if (changed.length > 0) this.changes.emit({ keys: changed });
  }

  delete(key: string): void {
    this.set(key, undefined);
  }

  /** Evaluates a `when` clause; `undefined` or empty means "always". Parses are cached. */
  evaluate(expression: string | WhenExpr | undefined): boolean {
    if (expression === undefined) return true;
    if (typeof expression !== "string") return evaluateWhen(expression, (key) => this.get(key));
    if (expression.trim() === "") return true;
    let expr = this.parsed.get(expression);
    if (!expr) {
      expr = parseWhen(expression);
      this.parsed.set(expression, expr);
    }
    return evaluateWhen(expr, (key) => this.get(key));
  }

  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.values);
  }

  onDidChange(listener: (event: ContextChangeEvent) => void): Disposable {
    return this.changes.on(listener);
  }

  dispose(): void {
    this.changes.dispose();
  }
}
