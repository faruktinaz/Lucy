/**
 * Toasts and their history. At most three toasts are on screen; a fourth pushes the oldest
 * into the history only. Toasts dismiss themselves (errors stay longer) unless they carry
 * actions, which wait for the user.
 */
import { type Disposable, Emitter } from "@/core/events";
import { Store } from "@/core/store";
import { type Clock, systemClock } from "./readable";

export type NotificationSeverity = "info" | "success" | "warning" | "error";

export interface NotificationAction {
  readonly label: string;
  readonly run: () => void | Promise<void>;
}

export interface NotificationInput {
  readonly severity?: NotificationSeverity;
  /** One short sentence: what happened. */
  readonly title: string;
  /** Optional second sentence: what to do, or where to look. */
  readonly message?: string;
  readonly actions?: readonly NotificationAction[];
  /** Milliseconds before auto-dismissal; 0 keeps it until dismissed. */
  readonly timeoutMs?: number;
  /** Toasts with the same key replace each other instead of stacking. */
  readonly key?: string;
}

export interface Notification extends NotificationInput {
  readonly id: string;
  readonly severity: NotificationSeverity;
  readonly createdAt: number;
}

export interface NotificationsState {
  readonly toasts: readonly Notification[];
  readonly history: readonly Notification[];
}

export const MAX_TOASTS = 3;
const MAX_HISTORY = 100;

const DEFAULT_TIMEOUT: Record<NotificationSeverity, number> = {
  info: 4000,
  success: 3000,
  warning: 6000,
  error: 8000,
};

export interface NotificationHandle extends Disposable {
  readonly id: string;
}

export class NotificationService implements Disposable {
  readonly store = new Store<NotificationsState>({ toasts: [], history: [] });
  private readonly timers = new Map<string, unknown>();
  private readonly shown = new Emitter<Notification>();
  private nextId = 1;

  constructor(private readonly clock: Clock = systemClock) {}

  get toasts(): readonly Notification[] {
    return this.store.get().toasts;
  }

  show(input: NotificationInput): NotificationHandle {
    const severity = input.severity ?? "info";
    const notification: Notification = {
      ...input,
      severity,
      id: `notification-${this.nextId++}`,
      createdAt: this.clock.now(),
    };
    this.store.set((state) => {
      const kept = input.key ? state.toasts.filter((t) => t.key !== input.key) : [...state.toasts];
      for (const removed of state.toasts.filter((t) => !kept.includes(t))) this.clearTimer(removed.id);
      kept.push(notification);
      while (kept.length > MAX_TOASTS) {
        const overflow = kept.shift();
        if (overflow) this.clearTimer(overflow.id);
      }
      return {
        toasts: kept,
        history: [notification, ...state.history].slice(0, MAX_HISTORY),
      };
    });
    const timeout =
      input.timeoutMs ?? (input.actions && input.actions.length > 0 ? 0 : DEFAULT_TIMEOUT[severity]);
    if (timeout > 0) {
      this.timers.set(
        notification.id,
        this.clock.setTimeout(() => this.dismiss(notification.id), timeout),
      );
    }
    this.shown.emit(notification);
    return { id: notification.id, dispose: () => this.dismiss(notification.id) };
  }

  info(title: string, message?: string): NotificationHandle {
    return this.show({ severity: "info", title, message });
  }

  success(title: string, message?: string): NotificationHandle {
    return this.show({ severity: "success", title, message });
  }

  warn(title: string, message?: string): NotificationHandle {
    return this.show({ severity: "warning", title, message });
  }

  error(title: string, message?: string): NotificationHandle {
    return this.show({ severity: "error", title, message });
  }

  dismiss(id: string): void {
    this.clearTimer(id);
    this.store.set((state) =>
      state.toasts.some((t) => t.id === id)
        ? { ...state, toasts: state.toasts.filter((t) => t.id !== id) }
        : state,
    );
  }

  dismissAll(): void {
    for (const toast of this.toasts) this.clearTimer(toast.id);
    this.store.set((state) => (state.toasts.length === 0 ? state : { ...state, toasts: [] }));
  }

  clearHistory(): void {
    this.store.set((state) => ({ ...state, history: [] }));
  }

  onDidShow(listener: (notification: Notification) => void): Disposable {
    return this.shown.on(listener);
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) this.clock.clearTimeout(timer);
    this.timers.delete(id);
  }

  dispose(): void {
    for (const timer of this.timers.values()) this.clock.clearTimeout(timer);
    this.timers.clear();
    this.shown.dispose();
  }
}
