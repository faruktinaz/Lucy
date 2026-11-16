/**
 * The one key router. Registered ahead of every other listener with
 * `renderer.keyInput.prependListener("keypress", ...)`, it offers each key to four layers:
 *
 * 1. The overlay stack: the top overlay sees the key first; a modal overlay captures every
 *    key it does not use, except text and editing keys for its own input.
 * 2. The keybinding registry, with sequences (`ctrl+k z`, the `ctrl+\` leader) and their
 *    pending state. While an embedded terminal has focus only `global` bindings apply;
 *    while a text input has focus typing keys never trigger bindings (both enforced by the
 *    registry's resolution policy).
 * 3. The focused zone's key handlers (`useKeyHandler`), unless a terminal has focus.
 * 4. Otherwise the key falls through to the focused widget (input, textarea, terminal).
 *
 * A consumed key gets `preventDefault()` and `stopPropagation()`, so neither the focused
 * renderable nor any later `useKeyboard` listener sees it.
 */
import { EmbeddedTerminalRenderable, type KeyEvent, type Renderable } from "@opentui/core";
import type { CommandRegistry } from "@/core/commands";
import { type Disposable, toDisposable } from "@/core/events";
import {
  type Chord,
  type ContextKeys,
  formatChord,
  type KeybindingRegistry,
  normalizeKey,
} from "@/core/keybindings";
import { isTypingStroke, type KeyStroke } from "@/core/keybindings/key-stroke";
import type { Logger } from "@/core/log";
import type { FocusService } from "../workbench/focus";
import type { HintService } from "../workbench/hints";
import type { OverlayService } from "../workbench/overlays";
import { toKeyStroke } from "./key-stroke-adapter";

/**
 * The command bound to `ctrl+\ ctrl+\`: the router lets that second press through to the
 * focused widget, so a terminal receives a literal Ctrl+\ (SIGQUIT stays reachable).
 */
export const LEADER_PASSTHROUGH_COMMAND = "leader.sendKey";

/** The leader chord, as written in keybindings. */
export const LEADER_CHORD = "ctrl+\\";

export interface FocusedWidget {
  /** An embedded terminal (or a widget registered as one) has renderable focus. */
  readonly terminal: boolean;
  /** A text input or textarea has renderable focus. */
  readonly input: boolean;
}

const terminalLike = new WeakSet<object>();

/**
 * Makes the router treat a renderable as a terminal: only global bindings apply while it is
 * focused and every other key reaches it untouched. `EmbeddedTerminalRenderable` is
 * recognized automatically; use this for custom terminal-like widgets.
 */
export function registerTerminalRenderable(renderable: object): Disposable {
  terminalLike.add(renderable);
  return toDisposable(() => terminalLike.delete(renderable));
}

export function isTerminalRenderable(renderable: Renderable | null | undefined): boolean {
  if (!renderable) return false;
  return renderable instanceof EmbeddedTerminalRenderable || terminalLike.has(renderable);
}

export interface KeyRouterRenderer {
  readonly keyInput: {
    prependListener(event: "keypress", listener: (event: KeyEvent) => void): unknown;
    off(event: "keypress", listener: (event: KeyEvent) => void): unknown;
  };
  readonly currentFocusedRenderable: Renderable | null;
  readonly currentFocusedEditor: unknown;
}

export interface KeyRouterOptions {
  renderer: KeyRouterRenderer;
  keybindings: KeybindingRegistry;
  contextKeys: ContextKeys;
  commands: CommandRegistry;
  focus: FocusService;
  overlays: OverlayService;
  hints: HintService;
  log: Logger;
  /** Ctrl+Z outside a terminal. */
  onSuspend: () => void;
  /** The quit keybinding label for the Ctrl+C hint (`Ctrl+Q`). */
  quitLabel: () => string | undefined;
  /** Formats a pending sequence prefix and lists what can follow. */
  describePending?: (prefix: Chord) => string;
}

function isPlainCtrl(stroke: KeyStroke, letter: string): boolean {
  return (
    stroke.ctrl &&
    !stroke.alt &&
    !stroke.super &&
    !stroke.shift &&
    (normalizeKey(stroke.key) ?? stroke.key).toLowerCase() === letter
  );
}

export class KeyRouter implements Disposable {
  private readonly listener = (event: KeyEvent) => this.handle(event);
  private readonly subscriptions: Disposable[] = [];
  private installed = false;

  constructor(private readonly options: KeyRouterOptions) {}

  /** Starts routing. Idempotent. */
  install(): this {
    if (this.installed) return this;
    this.installed = true;
    this.options.renderer.keyInput.prependListener("keypress", this.listener);
    const { keybindings, hints, focus } = this.options;
    this.subscriptions.push(
      keybindings.onDidChangePending((prefix) => {
        hints.setPending(prefix ? { text: this.describePending(prefix), tone: "accent" } : null);
      }),
      // A half-typed sequence must not complete in a different part of the UI.
      focus.onDidChange(() => keybindings.cancelPending()),
    );
    return this;
  }

  /** What has renderable focus right now. */
  focusedWidget(): FocusedWidget {
    const { renderer } = this.options;
    const terminal = isTerminalRenderable(renderer.currentFocusedRenderable);
    return { terminal, input: !terminal && renderer.currentFocusedEditor != null };
  }

  /** Routes one key event. Public so tests can feed parsed events directly. */
  handle(event: KeyEvent): void {
    try {
      this.route(event);
    } catch (error) {
      // A failing layer must never swallow input silently or crash the renderer's key loop.
      this.options.log.error("Key routing failed", { error });
    }
  }

  private route(event: KeyEvent): void {
    if (event.eventType === "release") return;
    const stroke = toKeyStroke(event);
    if (!stroke) return;
    const { contextKeys, overlays, keybindings, commands, focus, hints } = this.options;
    const widget = this.focusedWidget();
    contextKeys.setMany({ terminalFocus: widget.terminal, inputFocus: widget.input });
    const consume = () => {
      event.preventDefault();
      event.stopPropagation();
    };

    // Layer 1: overlays.
    const top = overlays.top;
    if (top) {
      if (top.handleKey?.(stroke)) {
        consume();
        return;
      }
      if (top.modal) {
        // Text and editing keys reach the overlay's own input; nothing else gets through.
        if (!(top.acceptsText && widget.input)) consume();
        return;
      }
    }

    // Layer 2: keybindings.
    const result = keybindings.resolve(stroke, contextKeys);
    if (result.kind === "pending" || result.kind === "cancelled") {
      consume();
      return;
    }
    if (result.kind === "command") {
      if (result.command === LEADER_PASSTHROUGH_COMMAND) return;
      if (commands.has(result.command)) {
        consume();
        commands.execute(result.command, result.args).catch(() => {
          // Reported through `commands.onDidFail`; nothing else to do here.
        });
        return;
      }
      if (result.rule.sequence.length > 1) {
        consume();
        hints.flash({ text: `${formatChord(result.rule.key, "text")} is not available yet`, tone: "muted" });
        return;
      }
      // An unregistered single-chord command (its feature is not built yet): the key falls through.
    }

    // Reserved terminal conventions, outside terminals only.
    if (!widget.terminal && isPlainCtrl(stroke, "c")) {
      const quit = this.options.quitLabel();
      hints.flash({ text: quit ? `Quit with ${quit}` : "Quit from the command palette", tone: "muted" });
      if (!widget.input) consume();
      return;
    }
    if (!widget.terminal && isPlainCtrl(stroke, "z")) {
      consume();
      this.options.onSuspend();
      return;
    }

    // Layer 3: the focused zone.
    if (widget.terminal) return;
    if (focus.handleKey(stroke, { inputFocused: widget.input, typing: isTypingStroke(stroke) })) consume();
    // Layer 4: fall through to the focused widget.
  }

  private describePending(prefix: Chord): string {
    if (this.options.describePending) return this.options.describePending(prefix);
    return `${formatChord(prefix, "text")} was pressed; waiting for the next key`;
  }

  dispose(): void {
    if (this.installed) this.options.renderer.keyInput.off("keypress", this.listener);
    this.installed = false;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions.length = 0;
  }
}
