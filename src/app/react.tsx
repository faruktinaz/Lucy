/**
 * React bindings for the service container: `useApp()`, `useStore()`, and the focus hooks
 * components use to take part in keyboard routing.
 */
import { createContext, type ReactNode, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import type { KeyStroke } from "@/core/keybindings/key-stroke";
import type { AppContext } from "./app-context";
import type { FocusTarget, FocusZone, ZoneKeyHandlerOptions } from "./workbench/focus";
import type { Hint } from "./workbench/hints";
import type { Readable } from "./workbench/readable";

const AppReactContext = createContext<AppContext | null>(null);
const ZoneReactContext = createContext<FocusZone | null>(null);

export function AppProvider({ value, children }: { value: AppContext; children: ReactNode }) {
  return <AppReactContext.Provider value={value}>{children}</AppReactContext.Provider>;
}

/** The service container. Throws outside the app root, which is always a bug. */
export function useApp(): AppContext {
  const app = useContext(AppReactContext);
  if (!app) throw new Error("useApp() must be used inside <AppProvider>");
  return app;
}

/** The container, or null outside the app root (for design-system primitives in isolation). */
export function useOptionalApp(): AppContext | null {
  return useContext(AppReactContext);
}

const identity = <T,>(value: T): T => value;

/**
 * Subscribes to a store. With a selector, the component re-renders only when the selected
 * value changes (`Object.is`); keep selectors cheap and return stable references.
 */
export function useStore<T>(store: Readable<T>): T;
export function useStore<T, S>(store: Readable<T>, selector: (state: T) => S): S;
export function useStore<T, S>(store: Readable<T>, selector?: (state: T) => S): S | T {
  const select = (selector ?? identity) as (state: T) => S;
  const getSnapshot = () => select(store.get());
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/** Marks a subtree as belonging to a focus zone (the shell does this for each part). */
export function ZoneProvider({ zone, children }: { zone: FocusZone; children: ReactNode }) {
  return <ZoneReactContext.Provider value={zone}>{children}</ZoneReactContext.Provider>;
}

/** The focus zone this component lives in, or null in an overlay. */
export function useZone(): FocusZone | null {
  return useContext(ZoneReactContext);
}

/** True while the component's zone has keyboard focus. */
export function useZoneFocused(): boolean {
  const app = useApp();
  const zone = useZone();
  return useStore(app.focus.store, (state) => zone !== null && state.zone === zone);
}

export interface KeyHandlerOptions extends ZoneKeyHandlerOptions {
  /** Defaults to true; pass false to stop receiving keys without unmounting. */
  enabled?: boolean;
}

/**
 * Receives keys while this component's zone is focused and no binding claimed them
 * (layer 3 of the key router). Return true when the key was used. The latest handler wins,
 * so a nested component can take over keys from its parent while it is mounted.
 *
 *   useKeyHandler((key) => {
 *     if (key.key === "down") { select(index + 1); return true; }
 *     return false;
 *   });
 */
export function useKeyHandler(
  handler: (stroke: KeyStroke) => boolean,
  options: KeyHandlerOptions = {},
): void {
  const app = useApp();
  const zone = useZone();
  const ref = useRef(handler);
  ref.current = handler;
  const enabled = options.enabled ?? true;
  const whileInputFocused = options.whileInputFocused ?? false;
  useEffect(() => {
    if (!zone || !enabled) return;
    const subscription = app.focus.registerKeyHandler(zone, (stroke) => ref.current(stroke), {
      whileInputFocused,
    });
    return () => subscription.dispose();
  }, [app, zone, enabled, whileInputFocused]);
}

/**
 * Registers what should receive renderable focus when this component's zone is focused
 * (a text input, an embedded terminal). Pass a ref to the renderable.
 */
export function useFocusTarget(ref: { current: { focus(): void } | null }, enabled = true): void {
  const app = useApp();
  const zone = useZone();
  useEffect(() => {
    if (!zone || !enabled) return;
    const target: FocusTarget = { focus: () => ref.current?.focus() };
    const subscription = app.focus.registerFocusTarget(zone, target);
    return () => subscription.dispose();
  }, [app, zone, enabled, ref]);
}

/** Returns handlers that show a hint in the status bar while hovered. */
export function useHoverHint(hint: Hint | null): { onMouseOver: () => void; onMouseOut: () => void } {
  const app = useOptionalApp();
  const owner = useRef({}).current;
  const latest = useRef(hint);
  latest.current = hint;
  useEffect(() => () => app?.hints.setHover(owner, null), [app, owner]);
  return {
    onMouseOver: () => {
      if (latest.current) app?.hints.setHover(owner, latest.current);
    },
    onMouseOut: () => app?.hints.setHover(owner, null),
  };
}

/** The formatted keybinding of a command (`Ctrl+K E`), updated when bindings change. */
export function useKeybindingLabel(command: string | undefined): string | undefined {
  const app = useOptionalApp();
  // Re-read when user bindings change: they come from config.
  useStore(app?.config.store ?? EMPTY, (config) => (config as { keybindings?: unknown }).keybindings);
  return command && app ? app.keybindingLabel(command) : undefined;
}

const EMPTY: Readable<unknown> = { get: () => undefined, subscribe: () => () => {} };
