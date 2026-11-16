/**
 * Registries for everything a feature can show: sidebar views, auxiliary-panel views,
 * bottom-panel tabs and editor views (by tab kind). The shell renders whatever is registered;
 * it never imports a feature.
 */
import type { ReactNode } from "react";
import { LucyError } from "@/core/errors";
import { type Disposable, toDisposable } from "@/core/events";
import { Store } from "@/core/store";
import type { IconName } from "@/themes/icons";
import type { EditorInput, EditorTab } from "./editors";
import type { Readable } from "./readable";

/**
 * A function component. (React's `ComponentType` allows async components, which OpenTUI's
 * JSX typings reject; contributions are plain function components.)
 */
export type ViewComponent<P> = (props: P) => ReactNode;

/** Props every sidebar, auxiliary and bottom-panel view receives. */
export interface ViewProps {
  /** The view is the one currently shown in its container (hidden views stay mounted). */
  readonly visible: boolean;
  /** Its container has keyboard focus. */
  readonly focused: boolean;
}

/** A button in a view's header. It runs a command, so it is also reachable from the palette. */
export interface ViewAction {
  readonly command: string;
  readonly args?: unknown;
  readonly icon: IconName;
  /** Shown in the status-bar hint on hover and focus; defaults to the command's title. */
  readonly title?: string;
  /** Editor actions only: a short text shown instead of the icon (`Preview`, `Edit`). */
  readonly label?: string;
  /** Rendered as a toggle that is on. */
  readonly active?: boolean;
}

export interface SidebarViewContribution {
  /** Stable id; "explorer", "search" and "scm" are the built-in views. */
  readonly id: string;
  /** Short title, shown uppercase in the sidebar header. */
  readonly title: string;
  readonly icon: IconName;
  /** Activity bar position (ascending). */
  readonly order: number;
  readonly component: ViewComponent<ViewProps>;
  /** Count shown on the activity bar icon; `undefined` or 0 hides it. */
  readonly badge?: Readable<number | undefined>;
  readonly actions?: readonly ViewAction[];
  /** The command that shows this view; its keybinding appears in the activity bar hint. */
  readonly command?: string;
}

export interface AuxiliaryViewContribution {
  readonly id: string;
  readonly title: string;
  readonly icon: IconName;
  readonly order: number;
  readonly component: ViewComponent<ViewProps>;
  readonly actions?: readonly ViewAction[];
}

export interface BottomTabContribution {
  readonly id: string;
  readonly title: string;
  readonly icon?: IconName;
  readonly order: number;
  readonly component: ViewComponent<ViewProps>;
  readonly badge?: Readable<number | undefined>;
  readonly actions?: readonly ViewAction[];
}

export interface EditorViewProps {
  readonly tab: EditorTab;
  /** The editor zone has keyboard focus and this tab is active. */
  readonly focused: boolean;
}

export interface EditorViewContribution {
  /** The tab kind this view renders ("file", "diff", ...). */
  readonly kind: string;
  readonly component: ViewComponent<EditorViewProps>;
  /** Tab title for an input without one. Defaults to the resource's base name. */
  readonly title?: (input: EditorInput) => string | undefined;
  /** Icon in the tab strip; file tabs use the file-type icon when omitted. */
  readonly icon?: IconName;
  /** Breadcrumb segments for the active tab; defaults to the resource path segments. */
  readonly breadcrumb?: (tab: EditorTab) => readonly string[];
  /**
   * Actions shown at the right end of the breadcrumb row for the active tab. Each runs a
   * command, so it is also in the palette. Read when the tab or its view state changes.
   */
  readonly actions?: (tab: EditorTab) => readonly ViewAction[];
  /**
   * When two features contribute the same kind, the higher priority renders its tabs (default
   * 0), whatever the activation order; when it is disposed the other one takes over. Equal
   * priorities are still a programming error. Lets the feature that owns a kind supersede a
   * placeholder registered by another feature.
   */
  readonly priority?: number;
}

export interface ViewsState {
  readonly sidebar: readonly SidebarViewContribution[];
  readonly auxiliary: readonly AuxiliaryViewContribution[];
  readonly bottom: readonly BottomTabContribution[];
  readonly editors: Readonly<Record<string, EditorViewContribution>>;
}

function byOrder<T extends { order: number; id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

function duplicate(kind: string, id: string): LucyError {
  return new LucyError("ALREADY_EXISTS", `A ${kind} with id "${id}" is already registered`, {
    details: { id },
  });
}

export class ViewRegistry implements Disposable {
  readonly store = new Store<ViewsState>({ sidebar: [], auxiliary: [], bottom: [], editors: {} });
  /** True when at least one auxiliary view is registered. */
  readonly hasAuxiliary: Readable<boolean> = {
    get: () => this.store.get().auxiliary.length > 0,
    subscribe: (listener) => this.store.subscribe(listener),
  };

  get state(): ViewsState {
    return this.store.get();
  }

  registerSidebarView(view: SidebarViewContribution): Disposable {
    if (this.state.sidebar.some((v) => v.id === view.id)) throw duplicate("sidebar view", view.id);
    this.store.set((s) => ({ ...s, sidebar: byOrder([...s.sidebar, view]) }));
    return toDisposable(() =>
      this.store.set((s) => ({ ...s, sidebar: s.sidebar.filter((v) => v !== view) })),
    );
  }

  registerAuxiliaryView(view: AuxiliaryViewContribution): Disposable {
    if (this.state.auxiliary.some((v) => v.id === view.id)) throw duplicate("auxiliary view", view.id);
    this.store.set((s) => ({ ...s, auxiliary: byOrder([...s.auxiliary, view]) }));
    return toDisposable(() =>
      this.store.set((s) => ({ ...s, auxiliary: s.auxiliary.filter((v) => v !== view) })),
    );
  }

  registerBottomTab(tab: BottomTabContribution): Disposable {
    if (this.state.bottom.some((v) => v.id === tab.id)) throw duplicate("bottom panel tab", tab.id);
    this.store.set((s) => ({ ...s, bottom: byOrder([...s.bottom, tab]) }));
    return toDisposable(() => this.store.set((s) => ({ ...s, bottom: s.bottom.filter((v) => v !== tab) })));
  }

  registerEditorView(view: EditorViewContribution): Disposable {
    const candidates = this.editorCandidates.get(view.kind) ?? [];
    const priority = view.priority ?? 0;
    if (candidates.some((candidate) => (candidate.priority ?? 0) === priority)) {
      throw duplicate("editor view", view.kind);
    }
    this.editorCandidates.set(view.kind, [...candidates, view]);
    this.publishEditorView(view.kind);
    return toDisposable(() => {
      const remaining = (this.editorCandidates.get(view.kind) ?? []).filter(
        (candidate) => candidate !== view,
      );
      if (remaining.length > 0) this.editorCandidates.set(view.kind, remaining);
      else this.editorCandidates.delete(view.kind);
      this.publishEditorView(view.kind);
    });
  }

  /** Every contribution per kind; the store holds only the highest-priority one. */
  private readonly editorCandidates = new Map<string, readonly EditorViewContribution[]>();

  private publishEditorView(kind: string): void {
    let best: EditorViewContribution | undefined;
    for (const candidate of this.editorCandidates.get(kind) ?? []) {
      if (!best || (candidate.priority ?? 0) > (best.priority ?? 0)) best = candidate;
    }
    this.store.set((s) => {
      if (s.editors[kind] === best) return s;
      if (!best) {
        const { [kind]: _removed, ...rest } = s.editors;
        return { ...s, editors: rest };
      }
      return { ...s, editors: { ...s.editors, [kind]: best } };
    });
  }

  sidebarView(id: string): SidebarViewContribution | undefined {
    return this.state.sidebar.find((v) => v.id === id);
  }

  auxiliaryView(id: string | null): AuxiliaryViewContribution | undefined {
    return this.state.auxiliary.find((v) => v.id === id) ?? this.state.auxiliary[0];
  }

  bottomTab(id: string | null): BottomTabContribution | undefined {
    return this.state.bottom.find((v) => v.id === id) ?? this.state.bottom[0];
  }

  editorView(kind: string): EditorViewContribution | undefined {
    return this.state.editors[kind];
  }

  dispose(): void {}
}
