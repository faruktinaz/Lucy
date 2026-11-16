/**
 * The read side of a `Store`: what React binds to with `useStore`. Contributions (badges,
 * status items) accept this instead of a full `Store` so a feature can expose derived state
 * without handing out a setter.
 */
import type { Store } from "@/core/store";

export type Readable<T> = Pick<Store<T>, "get" | "subscribe">;

/** A `Readable` that never changes. */
export function constant<T>(value: T): Readable<T> {
  return { get: () => value, subscribe: () => () => {} };
}

/**
 * A memoized view over other readables: `compute` runs again only when one of the sources
 * returned a different reference, so React subscribers re-render only on real changes.
 */
export function derived<S extends readonly Readable<unknown>[], T>(
  sources: S,
  compute: (...values: { [K in keyof S]: S[K] extends Readable<infer V> ? V : never }) => T,
): Readable<T> {
  let lastInputs: unknown[] | undefined;
  let lastValue: T;
  const get = (): T => {
    const inputs = sources.map((source) => source.get());
    if (lastInputs && inputs.every((value, i) => Object.is(value, lastInputs?.[i]))) return lastValue;
    lastInputs = inputs;
    lastValue = (compute as (...values: unknown[]) => T)(...inputs);
    return lastValue;
  };
  const subscribe = (listener: () => void): (() => void) => {
    const unsubscribes = sources.map((source) => source.subscribe(listener));
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  };
  return { get, subscribe };
}

/** Clock seam for services with timers (notifications, spinners). */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    // Timers in services must never keep the process alive on their own.
    (timer as { unref?: () => void }).unref?.();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
