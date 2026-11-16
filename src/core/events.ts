/**
 * Kernel primitives for lifecycle and eventing.
 *
 * Everything that allocates a resource (listener, watcher, process, timer) returns a
 * `Disposable`. Owners collect them in a `DisposableStore` and dispose once, so nothing
 * leaks when a panel closes or the app exits.
 */

export interface Disposable {
  dispose(): void;
}

export type Listener<T> = (value: T) => void;

export function toDisposable(fn: () => void): Disposable {
  let done = false;
  return {
    dispose() {
      if (done) return;
      done = true;
      fn();
    },
  };
}

/** Collects disposables and releases them in reverse order of registration. */
export class DisposableStore implements Disposable {
  private items: Disposable[] = [];
  private disposed = false;

  get isDisposed(): boolean {
    return this.disposed;
  }

  add<T extends Disposable>(item: T): T {
    if (this.disposed) {
      // The owner is already gone: release immediately instead of leaking.
      item.dispose();
      return item;
    }
    this.items.push(item);
    return item;
  }

  /** Convenience for plain cleanup callbacks. */
  addFn(fn: () => void): void {
    this.add(toDisposable(fn));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const items = this.items;
    this.items = [];
    for (let i = items.length - 1; i >= 0; i--) {
      try {
        items[i]?.dispose();
      } catch {
        // One failing cleanup must not prevent the rest from running.
      }
    }
  }
}

export type ErrorSink = (error: unknown, context: string) => void;

let listenerErrorSink: ErrorSink = () => {};

/** Lets the app route listener failures to the log without the kernel depending on it. */
export function setListenerErrorSink(sink: ErrorSink): void {
  listenerErrorSink = sink;
}

/**
 * Minimal typed event emitter. A throwing listener never breaks the emit loop or the
 * other listeners; the error goes to the configured sink.
 */
export class Emitter<T> implements Disposable {
  private listeners = new Set<Listener<T>>();

  get size(): number {
    return this.listeners.size;
  }

  on(listener: Listener<T>): Disposable {
    this.listeners.add(listener);
    return toDisposable(() => {
      this.listeners.delete(listener);
    });
  }

  once(listener: Listener<T>): Disposable {
    const sub = this.on((value) => {
      sub.dispose();
      listener(value);
    });
    return sub;
  }

  emit(value: T): void {
    // Snapshot so listeners may subscribe/unsubscribe while we iterate.
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (error) {
        listenerErrorSink(error, "Emitter listener");
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
