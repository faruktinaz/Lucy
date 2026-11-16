import { afterEach, describe, expect, test } from "bun:test";
import { DisposableStore, Emitter, setListenerErrorSink, toDisposable } from "@/core/events";
import { Store } from "@/core/store";

afterEach(() => {
  setListenerErrorSink(() => {});
});

describe("toDisposable", () => {
  test("runs its cleanup exactly once", () => {
    let count = 0;
    const d = toDisposable(() => count++);
    d.dispose();
    d.dispose();
    expect(count).toBe(1);
  });
});

describe("DisposableStore", () => {
  test("disposes in reverse order, once", () => {
    const order: number[] = [];
    const store = new DisposableStore();
    store.add(toDisposable(() => order.push(1)));
    store.addFn(() => order.push(2));
    store.add(toDisposable(() => order.push(3)));
    store.dispose();
    store.dispose();
    expect(order).toEqual([3, 2, 1]);
    expect(store.isDisposed).toBe(true);
  });

  test("a throwing item does not stop the others", () => {
    const order: string[] = [];
    const store = new DisposableStore();
    store.addFn(() => order.push("first"));
    store.addFn(() => {
      throw new Error("boom");
    });
    store.addFn(() => order.push("last"));
    expect(() => store.dispose()).not.toThrow();
    expect(order).toEqual(["last", "first"]);
  });

  test("adding after disposal releases immediately instead of leaking", () => {
    const store = new DisposableStore();
    store.dispose();
    let released = false;
    const item = store.add(toDisposable(() => (released = true)));
    expect(released).toBe(true);
    expect(typeof item.dispose).toBe("function");
  });
});

describe("Emitter", () => {
  test("on, once, emit and unsubscribe", () => {
    const emitter = new Emitter<number>();
    const seen: string[] = [];
    const sub = emitter.on((v) => seen.push(`on:${v}`));
    emitter.once((v) => seen.push(`once:${v}`));
    emitter.emit(1);
    emitter.emit(2);
    sub.dispose();
    emitter.emit(3);
    expect(seen).toEqual(["on:1", "once:1", "on:2"]);
    expect(emitter.size).toBe(0);
  });

  test("a throwing listener goes to the error sink and the others still run", () => {
    const errors: [unknown, string][] = [];
    setListenerErrorSink((error, context) => errors.push([error, context]));
    const emitter = new Emitter<string>();
    const seen: string[] = [];
    emitter.on(() => {
      throw new Error("listener failed");
    });
    emitter.on((v) => seen.push(v));
    emitter.emit("x");
    expect(seen).toEqual(["x"]);
    expect(errors).toHaveLength(1);
    const [first] = errors;
    expect(first?.[0]).toBeInstanceOf(Error);
    expect(first?.[1]).toBe("Emitter listener");
  });

  test("listeners may subscribe and unsubscribe during emit", () => {
    const emitter = new Emitter<number>();
    const seen: string[] = [];
    const a = emitter.on(() => {
      seen.push("a");
      a.dispose();
      emitter.on(() => seen.push("late"));
    });
    emitter.on(() => seen.push("b"));
    emitter.emit(1);
    emitter.emit(2);
    expect(seen).toEqual(["a", "b", "b", "late"]);
  });

  test("dispose removes every listener", () => {
    const emitter = new Emitter<void>();
    let count = 0;
    emitter.on(() => count++);
    emitter.dispose();
    emitter.emit();
    expect(count).toBe(0);
  });
});

describe("Store", () => {
  test("get, set with a value or an updater, and subscribe", () => {
    const store = new Store({ count: 0, name: "a" });
    let notified = 0;
    const unsubscribe = store.subscribe(() => notified++);
    store.set({ count: 1, name: "a" });
    store.set((prev) => ({ ...prev, count: prev.count + 1 }));
    expect(store.get()).toEqual({ count: 2, name: "a" });
    expect(notified).toBe(2);
    unsubscribe();
    store.set({ count: 3, name: "a" });
    expect(notified).toBe(2);
  });

  test("setting the same reference does not notify", () => {
    const state = { count: 0 };
    const store = new Store(state);
    let notified = 0;
    store.subscribe(() => notified++);
    store.set(state);
    store.set((prev) => prev);
    expect(notified).toBe(0);
  });

  test("update shallow-merges and skips no-op updates", () => {
    const store = new Store({ a: 1, b: { deep: true } });
    const before = store.get();
    let notified = 0;
    store.subscribe(() => notified++);
    store.update({ a: 1, b: before.b });
    expect(store.get()).toBe(before);
    store.update({ a: 2 });
    expect(store.get()).toEqual({ a: 2, b: { deep: true } });
    expect(store.get().b).toBe(before.b);
    expect(notified).toBe(1);
  });

  test("get and subscribe are stable references for useSyncExternalStore", () => {
    const store = new Store(1);
    const { get, subscribe } = store;
    expect(get()).toBe(1);
    expect(store.get).toBe(get);
    expect(store.subscribe).toBe(subscribe);
  });
});
