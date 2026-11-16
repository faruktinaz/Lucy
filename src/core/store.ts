/**
 * Tiny observable state container.
 *
 * Framework-agnostic on purpose: services own their state in a `Store`, and the UI layer
 * binds to it with `useSyncExternalStore(store.subscribe, store.get)`. State objects must be
 * treated as immutable; always pass a new reference to `set`.
 */
export class Store<S> {
  private state: S;
  private listeners = new Set<() => void>();

  constructor(initial: S) {
    this.state = initial;
  }

  /** Stable reference: safe to pass directly to `useSyncExternalStore`. */
  get = (): S => this.state;

  set = (next: S | ((prev: S) => S)): void => {
    const value = typeof next === "function" ? (next as (prev: S) => S)(this.state) : next;
    if (Object.is(value, this.state)) return;
    this.state = value;
    for (const listener of [...this.listeners]) listener();
  };

  /** Shallow-merges into an object state. No-op when nothing actually changed. */
  update = (partial: Partial<S>): void => {
    const prev = this.state as Record<string, unknown>;
    let changed = false;
    for (const key of Object.keys(partial as Record<string, unknown>)) {
      if (!Object.is(prev[key], (partial as Record<string, unknown>)[key])) {
        changed = true;
        break;
      }
    }
    if (changed) this.set({ ...this.state, ...partial });
  };

  /** Stable reference. Returns the unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}
