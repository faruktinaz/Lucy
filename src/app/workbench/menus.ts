/**
 * Context menus at the pointer (or anchored to an element for keyboard users). Items run a
 * command or a callback; their keybinding hint comes from the command when not given.
 */
import { errorMessage } from "@/core/errors";
import type { Disposable } from "@/core/events";
import { normalizeKey } from "@/core/keybindings";
import type { KeyStroke } from "@/core/keybindings/key-stroke";
import { Store } from "@/core/store";
import type { IconName } from "@/themes/icons";
import type { OverlayService } from "./overlays";

export type MenuItem =
  | {
      readonly kind?: "item";
      readonly id: string;
      readonly label: string;
      /** Runs this command (and shows its keybinding) when chosen. */
      readonly command?: string;
      readonly args?: unknown;
      /** Runs instead of a command. */
      readonly run?: () => void | Promise<void>;
      readonly icon?: IconName;
      /** Overrides the command's keybinding hint (a key sequence such as `ctrl+k e`). */
      readonly keybinding?: string;
      readonly disabled?: boolean;
      /** Destructive: drawn in the error color. */
      readonly danger?: boolean;
      /**
       * A toggle: `true` shows a check mark, `false` an empty slot of the same width. Menus
       * without any `checked` item render exactly as before.
       */
      readonly checked?: boolean;
    }
  | { readonly kind: "separator"; readonly id: string };

export type MenuActionItem = Extract<MenuItem, { label: string }>;

export interface MenuRequest {
  readonly x: number;
  readonly y: number;
  readonly items: readonly MenuItem[];
}

export interface MenuState extends MenuRequest {
  readonly open: boolean;
  /** Index into `items` of the highlighted entry, -1 for none. */
  readonly activeIndex: number;
}

const CLOSED: MenuState = { open: false, x: 0, y: 0, items: [], activeIndex: -1 };

export function isActionItem(item: MenuItem | undefined): item is MenuActionItem {
  return item !== undefined && item.kind !== "separator";
}

export interface MenuServiceOptions {
  execute: (command: string, args?: unknown) => Promise<unknown>;
  onError: (title: string, error: unknown) => void;
}

export class MenuService implements Disposable {
  readonly store = new Store<MenuState>(CLOSED);
  private layer: Disposable | null = null;

  constructor(
    private readonly overlays: OverlayService,
    private readonly options: MenuServiceOptions,
  ) {}

  get state(): MenuState {
    return this.store.get();
  }

  /** Opens a menu at a screen cell. Keyboard users get the first item highlighted. */
  show(request: MenuRequest, options: { highlightFirst?: boolean } = {}): void {
    const first = request.items.findIndex((item) => isActionItem(item) && !item.disabled);
    this.store.set({ ...request, open: true, activeIndex: options.highlightFirst === false ? -1 : first });
    if (!this.layer) {
      this.layer = this.overlays.push({
        id: "menu",
        modal: true,
        handleKey: (stroke) => this.handleKey(stroke),
        dismiss: () => this.close(),
      });
    }
  }

  close(): void {
    if (this.state.open) this.store.set(CLOSED);
    this.layer?.dispose();
    this.layer = null;
  }

  setActiveIndex(index: number): void {
    if (index === this.state.activeIndex) return;
    this.store.set({ ...this.state, activeIndex: index });
  }

  async choose(index: number): Promise<void> {
    const item = this.state.items[index];
    if (!isActionItem(item) || item.disabled) return;
    this.close();
    try {
      if (item.run) await item.run();
      else if (item.command) await this.options.execute(item.command, item.args);
    } catch (error) {
      this.options.onError(`${item.label} failed: ${errorMessage(error)}`, error);
    }
  }

  private step(delta: 1 | -1): void {
    const { items, activeIndex } = this.state;
    const count = items.length;
    for (let offset = 1; offset <= count; offset++) {
      const index =
        ((((activeIndex === -1 && delta < 0 ? 0 : activeIndex) + delta * offset) % count) + count) % count;
      const item = items[index];
      if (isActionItem(item) && !item.disabled) {
        this.setActiveIndex(index);
        return;
      }
    }
  }

  handleKey(stroke: KeyStroke): boolean {
    if (!this.state.open) return false;
    const key = normalizeKey(stroke.key) ?? stroke.key;
    if (key === "escape") {
      this.close();
      return true;
    }
    if (key === "down" || (key === "tab" && !stroke.shift)) {
      this.step(1);
      return true;
    }
    if (key === "up" || (key === "tab" && stroke.shift)) {
      this.step(-1);
      return true;
    }
    if (key === "home") {
      this.setActiveIndex(-1);
      this.step(1);
      return true;
    }
    if (key === "enter" || key === "space") {
      void this.choose(this.state.activeIndex);
      return true;
    }
    return true;
  }

  dispose(): void {
    this.close();
  }
}
