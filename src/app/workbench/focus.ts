/**
 * Explicit keyboard focus between the four workbench zones (sidebar, editor, auxiliary panel,
 * bottom panel), plus the per-zone key handlers the key router calls (layer 3).
 *
 * Zones are a workbench concept; inside a zone, the OpenTUI renderable that receives text
 * (an input, a terminal) is a "focus target" the zone's view registers. When a zone gains
 * focus its newest target is focused; a zone without a target takes renderable focus away
 * from whatever had it, so typing never lands in a stale input.
 */
import { type Disposable, Emitter, toDisposable } from "@/core/events";
import { CONTEXT_KEYS, type ContextKeys } from "@/core/keybindings";
import type { KeyStroke } from "@/core/keybindings/key-stroke";
import { Store } from "@/core/store";
import type { FocusZone } from "./layout-compute";
import { derived, type Readable } from "./readable";

export type { FocusZone } from "./layout-compute";

export type FocusDirection = "left" | "right" | "up" | "down";

/** Context keys set by the focus service. */
export const FOCUS_CONTEXT_KEYS: Readonly<Record<FocusZone, string>> = {
  sidebar: CONTEXT_KEYS.sidebarFocus,
  editor: CONTEXT_KEYS.editorFocus,
  auxiliary: CONTEXT_KEYS.auxiliaryFocus,
  bottom: CONTEXT_KEYS.panelFocus,
};

export interface FocusState {
  readonly zone: FocusZone;
}

/**
 * Handles a key for the focused zone. Return true when the key was used; it is then consumed
 * and reaches nothing else.
 */
export type ZoneKeyHandler = (stroke: KeyStroke) => boolean;

export interface ZoneKeyHandlerOptions {
  /** Also receive keys while a text input in the zone has focus. Typing keys are never sent. */
  whileInputFocused?: boolean;
}

export interface FocusTarget {
  /** Gives renderable focus to the element that should receive keys (an input, a terminal). */
  focus(): void;
}

export interface ZoneKeyContext {
  /** A text input or textarea has renderable focus. */
  inputFocused: boolean;
  /** The stroke types text (printable, no ctrl/alt/super). */
  typing: boolean;
}

interface HandlerEntry {
  handler: ZoneKeyHandler;
  options: ZoneKeyHandlerOptions;
}

export interface FocusLayout {
  /** Whether a zone can take focus now (visible or openable). */
  isAvailable(zone: FocusZone): boolean;
  /** Reading order for F6 cycling, given the sidebar side. */
  order(): readonly FocusZone[];
  /** Columns from left to right; the editor column holds editor and bottom panel. */
  columns(): readonly (readonly FocusZone[])[];
}

const DEFAULT_LAYOUT: FocusLayout = {
  isAvailable: () => true,
  order: () => ["sidebar", "editor", "bottom", "auxiliary"],
  columns: () => [["sidebar"], ["editor", "bottom"], ["auxiliary"]],
};

export class FocusService implements Disposable {
  readonly store = new Store<FocusState>({ zone: "editor" });
  /** The focused zone as a primitive, for derived stores. */
  readonly zone: Readable<FocusZone> = derived([this.store] as const, (state) => state.zone);
  private readonly handlers = new Map<FocusZone, HandlerEntry[]>();
  private readonly targets = new Map<FocusZone, FocusTarget[]>();
  private readonly changes = new Emitter<{ zone: FocusZone; previous: FocusZone }>();
  private layout: FocusLayout = DEFAULT_LAYOUT;
  private releaseRenderableFocus: () => void = () => {};

  constructor(private readonly contextKeys?: ContextKeys) {
    this.syncContextKeys();
  }

  get current(): FocusZone {
    return this.store.get().zone;
  }

  /** Wires the layout questions (visibility, order) in; done once by the app. */
  setLayout(layout: FocusLayout): void {
    this.layout = layout;
  }

  /** What to do when a focused zone has no focus target: the app blurs the renderer's focus. */
  setRenderableFocusReleaser(release: () => void): void {
    this.releaseRenderableFocus = release;
  }

  isAvailable(zone: FocusZone): boolean {
    return zone === "editor" || this.layout.isAvailable(zone);
  }

  /** Focuses a zone. Returns false when it is not available (hidden). */
  focus(zone: FocusZone): boolean {
    if (!this.isAvailable(zone)) return false;
    const previous = this.current;
    if (previous !== zone) {
      this.store.set({ zone });
      this.syncContextKeys();
      this.changes.emit({ zone, previous });
    }
    this.applyTarget(zone);
    return true;
  }

  /** Re-applies renderable focus for the current zone (after an overlay closes, a view mounts). */
  restore(): void {
    this.applyTarget(this.current);
  }

  next(): FocusZone {
    return this.cycle(1);
  }

  previous(): FocusZone {
    return this.cycle(-1);
  }

  private cycle(step: 1 | -1): FocusZone {
    const order = this.layout.order().filter((zone) => this.isAvailable(zone));
    if (order.length === 0) return this.current;
    const index = order.indexOf(this.current);
    const next = order[(index + step + order.length) % order.length] ?? "editor";
    this.focus(next);
    return this.current;
  }

  /** Moves focus to the neighbouring zone in a direction. Returns false at an edge. */
  move(direction: FocusDirection): boolean {
    const columns = this.layout.columns().map((column) => column.filter((zone) => this.isAvailable(zone)));
    const nonEmpty = columns.filter((column) => column.length > 0);
    const columnIndex = nonEmpty.findIndex((column) => column.includes(this.current));
    if (columnIndex === -1) return false;
    const column = nonEmpty[columnIndex] ?? [];
    if (direction === "up" || direction === "down") {
      const row = column.indexOf(this.current) + (direction === "down" ? 1 : -1);
      const target = column[row];
      return target ? this.focus(target) : false;
    }
    const neighbour = nonEmpty[columnIndex + (direction === "right" ? 1 : -1)];
    const target = neighbour?.[0];
    return target ? this.focus(target) : false;
  }

  /**
   * Registers a key handler for a zone. The newest enabled handler of the focused zone is
   * asked first; the next one only if it returned false.
   */
  registerKeyHandler(
    zone: FocusZone,
    handler: ZoneKeyHandler,
    options: ZoneKeyHandlerOptions = {},
  ): Disposable {
    const entry: HandlerEntry = { handler, options };
    const list = this.handlers.get(zone) ?? [];
    list.push(entry);
    this.handlers.set(zone, list);
    return toDisposable(() => {
      const current = this.handlers.get(zone);
      if (!current) return;
      const index = current.indexOf(entry);
      if (index !== -1) current.splice(index, 1);
    });
  }

  /** Registers the renderable that should receive keys while `zone` is focused. */
  registerFocusTarget(zone: FocusZone, target: FocusTarget): Disposable {
    const list = this.targets.get(zone) ?? [];
    list.push(target);
    this.targets.set(zone, list);
    if (this.current === zone) target.focus();
    return toDisposable(() => {
      const current = this.targets.get(zone);
      if (!current) return;
      const index = current.indexOf(target);
      if (index !== -1) current.splice(index, 1);
    });
  }

  /** Layer 3 of the key router. */
  handleKey(stroke: KeyStroke, context: ZoneKeyContext): boolean {
    const list = this.handlers.get(this.current);
    if (!list) return false;
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i];
      if (!entry) continue;
      if (context.inputFocused && (!entry.options.whileInputFocused || context.typing)) continue;
      if (entry.handler(stroke)) return true;
    }
    return false;
  }

  onDidChange(listener: (event: { zone: FocusZone; previous: FocusZone }) => void): Disposable {
    return this.changes.on(listener);
  }

  private applyTarget(zone: FocusZone): void {
    const target = this.targets.get(zone)?.at(-1);
    if (target) target.focus();
    else this.releaseRenderableFocus();
  }

  private syncContextKeys(): void {
    if (!this.contextKeys) return;
    const zone = this.current;
    this.contextKeys.setMany({
      focusedZone: zone,
      [FOCUS_CONTEXT_KEYS.sidebar]: zone === "sidebar",
      [FOCUS_CONTEXT_KEYS.editor]: zone === "editor",
      [FOCUS_CONTEXT_KEYS.auxiliary]: zone === "auxiliary",
      [FOCUS_CONTEXT_KEYS.bottom]: zone === "bottom",
    });
  }

  dispose(): void {
    this.changes.dispose();
    this.handlers.clear();
    this.targets.clear();
  }
}
