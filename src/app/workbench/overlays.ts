/**
 * The overlay stack: layer 1 of the key router. The topmost overlay sees every key first; a
 * modal overlay captures everything it does not use, except text for its own input.
 */
import type { ReactNode } from "react";
import { type Disposable, Emitter, toDisposable } from "@/core/events";
import type { ContextKeys } from "@/core/keybindings";
import type { KeyStroke } from "@/core/keybindings/key-stroke";
import { Store } from "@/core/store";

export interface OverlayLayer {
  readonly id: string;
  /** A modal layer captures every key; a non-modal one lets unhandled keys through. */
  readonly modal: boolean;
  /** The layer has its own text input: unhandled keys may reach the focused input. */
  readonly acceptsText?: boolean;
  /** Returns true when the key was used. */
  handleKey?(stroke: KeyStroke): boolean;
  /**
   * The layer needs Ctrl+Q and the leader as ordinary keys (it records shortcuts). Every other
   * modal layer lets the quit bindings through, so the app can always be quit.
   */
  readonly capturesQuit?: boolean;
  /** Closes the overlay (Escape, a click on the backdrop). */
  dismiss(): void;
  /**
   * Feature overlays draw themselves: `OverlayHost` renders this above the workbench (the
   * built-in quick pick, dialogs and menus render from their own services instead). The
   * element positions itself absolutely within the screen size it is given.
   */
  render?(size: { readonly width: number; readonly height: number }): ReactNode;
  /** Dim the workbench behind the overlay, as dialogs do. */
  readonly dim?: boolean;
}

export class OverlayService implements Disposable {
  readonly store = new Store<readonly OverlayLayer[]>([]);
  private readonly changes = new Emitter<readonly OverlayLayer[]>();

  constructor(private readonly contextKeys?: ContextKeys) {}

  get layers(): readonly OverlayLayer[] {
    return this.store.get();
  }

  get top(): OverlayLayer | undefined {
    return this.layers.at(-1);
  }

  get isModalOpen(): boolean {
    return this.layers.some((layer) => layer.modal);
  }

  /** Pushes a layer; disposing removes it wherever it is in the stack. */
  push(layer: OverlayLayer): Disposable {
    this.store.set((layers) => [...layers.filter((l) => l.id !== layer.id), layer]);
    this.sync();
    return toDisposable(() => {
      if (!this.layers.includes(layer)) return;
      this.store.set((layers) => layers.filter((l) => l !== layer));
      this.sync();
    });
  }

  /** Dismisses the top layer (Escape when nothing else handled it). */
  dismissTop(): boolean {
    const top = this.top;
    if (!top) return false;
    top.dismiss();
    return true;
  }

  onDidChange(listener: (layers: readonly OverlayLayer[]) => void): Disposable {
    return this.changes.on(listener);
  }

  private sync(): void {
    this.contextKeys?.set("overlayOpen", this.layers.length > 0);
    this.changes.emit(this.layers);
  }

  dispose(): void {
    this.changes.dispose();
  }
}
