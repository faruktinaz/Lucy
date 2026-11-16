/**
 * Promise-based modal dialogs: confirm, prompt and alert. One dialog is shown at a time;
 * further requests wait in a queue. Keyboard behaviour lives here so it is testable without a
 * renderer: Tab and the arrow keys move between buttons, Enter activates the focused button
 * (or submits a prompt), Escape cancels. A confirm always opens with the safe action focused.
 */
import type { Disposable } from "@/core/events";
import { normalizeKey } from "@/core/keybindings";
import type { KeyStroke } from "@/core/keybindings/key-stroke";
import { Store } from "@/core/store";
import type { OverlayService } from "./overlays";

export interface ConfirmOptions {
  readonly title: string;
  readonly message?: string;
  /** Default "OK". Name the action: "Delete", "Discard Changes". */
  readonly confirmLabel?: string;
  /** Default "Cancel". */
  readonly cancelLabel?: string;
  /** Destructive action: the confirm button uses the error color. */
  readonly danger?: boolean;
}

export interface PromptOptions {
  readonly title: string;
  readonly message?: string;
  readonly placeholder?: string;
  readonly value?: string;
  readonly confirmLabel?: string;
  /** Returns an error message, or undefined when the value is acceptable. */
  readonly validate?: (value: string) => string | undefined;
}

export interface AlertOptions {
  readonly title: string;
  readonly message?: string;
  readonly okLabel?: string;
}

export type DialogButtonKind = "primary" | "ghost" | "danger";

export interface DialogButton {
  readonly id: "cancel" | "confirm";
  readonly label: string;
  readonly kind: DialogButtonKind;
}

export interface DialogRequest {
  readonly id: string;
  readonly kind: "confirm" | "prompt" | "alert";
  readonly title: string;
  readonly message?: string;
  readonly danger: boolean;
  readonly buttons: readonly DialogButton[];
  /** Index into `buttons`; -1 means the prompt's text input has focus. */
  readonly focusIndex: number;
  readonly value: string;
  readonly placeholder?: string;
  readonly error?: string;
}

interface Pending {
  request: DialogRequest;
  validate?: (value: string) => string | undefined;
  resolve: (result: { confirmed: boolean; value: string }) => void;
}

export class DialogService implements Disposable {
  readonly store = new Store<DialogRequest | null>(null);
  private queue: Pending[] = [];
  private current: Pending | null = null;
  private layer: Disposable | null = null;
  private nextId = 1;

  constructor(private readonly overlays: OverlayService) {}

  get request(): DialogRequest | null {
    return this.store.get();
  }

  async confirm(options: ConfirmOptions): Promise<boolean> {
    const danger = options.danger === true;
    const result = await this.enqueue(
      {
        kind: "confirm",
        title: options.title,
        message: options.message,
        danger,
        buttons: [
          { id: "cancel", label: options.cancelLabel ?? "Cancel", kind: "ghost" },
          { id: "confirm", label: options.confirmLabel ?? "OK", kind: danger ? "danger" : "primary" },
        ],
        focusIndex: 0,
        value: "",
      },
      undefined,
    );
    return result.confirmed;
  }

  async prompt(options: PromptOptions): Promise<string | undefined> {
    const result = await this.enqueue(
      {
        kind: "prompt",
        title: options.title,
        message: options.message,
        danger: false,
        buttons: [
          { id: "cancel", label: "Cancel", kind: "ghost" },
          { id: "confirm", label: options.confirmLabel ?? "OK", kind: "primary" },
        ],
        focusIndex: -1,
        value: options.value ?? "",
        placeholder: options.placeholder,
      },
      options.validate,
    );
    return result.confirmed ? result.value : undefined;
  }

  async alert(options: AlertOptions): Promise<void> {
    await this.enqueue(
      {
        kind: "alert",
        title: options.title,
        message: options.message,
        danger: false,
        buttons: [{ id: "confirm", label: options.okLabel ?? "OK", kind: "primary" }],
        focusIndex: 0,
        value: "",
      },
      undefined,
    );
  }

  private enqueue(
    request: Omit<DialogRequest, "id">,
    validate: ((value: string) => string | undefined) | undefined,
  ): Promise<{ confirmed: boolean; value: string }> {
    return new Promise((resolve) => {
      this.queue.push({ request: { ...request, id: `dialog-${this.nextId++}` }, validate, resolve });
      if (!this.current) this.showNext();
    });
  }

  private showNext(): void {
    const next = this.queue.shift();
    this.current = next ?? null;
    this.store.set(next?.request ?? null);
    if (next && !this.layer) {
      this.layer = this.overlays.push({
        id: "dialog",
        modal: true,
        acceptsText: true,
        handleKey: (stroke) => this.handleKey(stroke),
        dismiss: () => this.cancel(),
      });
    } else if (!next && this.layer) {
      this.layer.dispose();
      this.layer = null;
    }
  }

  private update(patch: Partial<DialogRequest>): void {
    const current = this.current;
    if (!current) return;
    current.request = { ...current.request, ...patch };
    this.store.set(current.request);
  }

  /** The prompt's text changed (from the input). */
  setValue(value: string): void {
    const current = this.current;
    if (current?.request.kind !== "prompt") return;
    this.update({ value, error: current.request.error ? current.validate?.(value) : undefined });
  }

  setFocus(index: number): void {
    const request = this.request;
    if (!request) return;
    const min = request.kind === "prompt" ? -1 : 0;
    const max = request.buttons.length - 1;
    this.update({ focusIndex: Math.max(min, Math.min(max, index)) });
  }

  /** Activates a button (or submits a prompt for "confirm"). */
  activate(buttonId: DialogButton["id"]): void {
    const current = this.current;
    if (!current) return;
    if (buttonId === "cancel") {
      this.cancel();
      return;
    }
    if (current.request.kind === "prompt") {
      const error = current.validate?.(current.request.value);
      if (error) {
        this.update({ error, focusIndex: -1 });
        return;
      }
    }
    this.finish(true);
  }

  cancel(): void {
    if (!this.current) return;
    this.finish(false);
  }

  private finish(confirmed: boolean): void {
    const current = this.current;
    if (!current) return;
    current.resolve({ confirmed, value: current.request.value });
    this.showNext();
  }

  handleKey(stroke: KeyStroke): boolean {
    const request = this.request;
    if (!request) return false;
    const key = normalizeKey(stroke.key) ?? stroke.key;
    const plain = !stroke.ctrl && !stroke.alt && !stroke.super;
    if (key === "escape") {
      this.cancel();
      return true;
    }
    if (key === "enter" && plain) {
      const button = request.focusIndex >= 0 ? request.buttons[request.focusIndex] : undefined;
      this.activate(button?.id ?? "confirm");
      return true;
    }
    const count = request.buttons.length;
    const min = request.kind === "prompt" ? -1 : 0;
    const span = count - min;
    const move = (delta: number) => this.setFocus(((request.focusIndex - min + delta + span) % span) + min);
    if (key === "tab" && plain) {
      move(stroke.shift ? -1 : 1);
      return true;
    }
    // Arrow keys move between buttons only when a button has focus; in the input they edit text.
    if ((key === "left" || key === "right") && plain && request.focusIndex >= 0) {
      this.setFocus(Math.max(0, Math.min(count - 1, request.focusIndex + (key === "right" ? 1 : -1))));
      return true;
    }
    return false;
  }

  dispose(): void {
    this.current?.resolve({ confirmed: false, value: "" });
    for (const pending of this.queue) pending.resolve({ confirmed: false, value: "" });
    this.queue = [];
    this.current = null;
    this.layer?.dispose();
    this.layer = null;
    this.store.set(null);
  }
}
