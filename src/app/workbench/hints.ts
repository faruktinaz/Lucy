/**
 * The status bar's hint area: TUI-style tooltips. Hovering or focusing an action shows its
 * description and keybinding there; a pending key sequence and short transient messages
 * ("Quit with Ctrl+Q") take precedence.
 */
import type { Disposable } from "@/core/events";
import { Store } from "@/core/store";
import { type Clock, systemClock } from "./readable";

export interface Hint {
  readonly text: string;
  /** A key sequence (`ctrl+k z`), formatted next to the text. */
  readonly keys?: string;
  readonly tone?: "muted" | "accent" | "warning";
}

export interface HintsState {
  /** A pending key sequence or the armed leader. */
  readonly pending: Hint | null;
  /** A short-lived message. */
  readonly transient: Hint | null;
  /** The hovered or focused action. */
  readonly hover: Hint | null;
  /** A standing hint for the focused context (a terminal: how to leave it). Lowest precedence. */
  readonly ambient: Hint | null;
}

const TRANSIENT_MS = 2500;

export class HintService implements Disposable {
  readonly store = new Store<HintsState>({ pending: null, transient: null, hover: null, ambient: null });
  private hoverOwner: object | null = null;
  private ambientOwner: object | null = null;
  private timer: unknown;

  constructor(private readonly clock: Clock = systemClock) {}

  /** The hint to show now, by precedence. */
  get current(): Hint | null {
    const { pending, transient, hover, ambient } = this.store.get();
    return pending ?? transient ?? hover ?? ambient;
  }

  /** Sets the ambient hint for `owner`; clearing only works for the owner that set it. */
  setAmbient(owner: object, hint: Hint | null): void {
    if (hint === null) {
      if (this.ambientOwner !== owner) return;
      this.ambientOwner = null;
      this.store.update({ ambient: null });
      return;
    }
    this.ambientOwner = owner;
    this.store.update({ ambient: hint });
  }

  /** Sets the hover hint for `owner`; clearing only works for the owner that set it. */
  setHover(owner: object, hint: Hint | null): void {
    if (hint === null) {
      if (this.hoverOwner !== owner) return;
      this.hoverOwner = null;
      this.store.update({ hover: null });
      return;
    }
    this.hoverOwner = owner;
    this.store.update({ hover: hint });
  }

  setPending(hint: Hint | null): void {
    this.store.update({ pending: hint });
  }

  /** Shows a message for a moment. */
  flash(hint: Hint, ms = TRANSIENT_MS): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.store.update({ transient: hint });
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.store.update({ transient: null });
    }, ms);
  }

  dispose(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
  }
}
