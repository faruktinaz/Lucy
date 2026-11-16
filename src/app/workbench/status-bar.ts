/**
 * Status bar items. Features register items with an alignment and a priority; when the bar
 * is too narrow, items with the lowest priority are dropped first. On both sides items run
 * left to right by descending priority, so the least important item of the right group
 * (the theme name) sits at the far right and is the first to go.
 */
import { LucyError } from "@/core/errors";
import { type Disposable, toDisposable } from "@/core/events";
import { Store } from "@/core/store";
import type { IconName } from "@/themes/icons";

export type StatusTone = "default" | "muted" | "accent" | "success" | "warning" | "error";

export interface StatusItem {
  readonly id: string;
  readonly alignment: "left" | "right";
  /** Higher stays visible longer and sits further left within its side. */
  readonly priority: number;
  readonly text: string;
  readonly icon?: IconName;
  /** Status bars are quiet: `muted` is the default; use `default` only for key facts. */
  readonly tone?: StatusTone;
  /** Shown in the hint area on hover. */
  readonly tooltip?: string;
  /** Clicking runs this command. */
  readonly command?: string;
  readonly args?: unknown;
  readonly visible?: boolean;
}

export interface StatusItemHandle extends Disposable {
  update(patch: Partial<Omit<StatusItem, "id" | "alignment">>): void;
}

export class StatusBarService implements Disposable {
  readonly store = new Store<readonly StatusItem[]>([]);

  get items(): readonly StatusItem[] {
    return this.store.get();
  }

  register(item: StatusItem): StatusItemHandle {
    if (this.items.some((existing) => existing.id === item.id)) {
      throw new LucyError("ALREADY_EXISTS", `Status item "${item.id}" is already registered`, {
        details: { id: item.id },
      });
    }
    let current = item;
    this.store.set((items) => [...items, current]);
    const disposable = toDisposable(() => this.store.set((items) => items.filter((i) => i !== current)));
    return {
      update: (patch) => {
        const next = { ...current, ...patch };
        const changed = (Object.keys(patch) as (keyof StatusItem)[]).some(
          (key) => !Object.is(current[key], next[key]),
        );
        if (!changed) return;
        const previous = current;
        current = next;
        this.store.set((items) => items.map((i) => (i === previous ? next : i)));
      },
      dispose: () => disposable.dispose(),
    };
  }

  dispose(): void {}
}

/**
 * Splits items into the left and right groups in display order, dropping the lowest
 * priorities until the measured widths fit. `measure` returns an item's width in cells
 * including its padding.
 */
export function layoutStatusItems(
  items: readonly StatusItem[],
  available: number,
  measure: (item: StatusItem) => number,
  gap = 0,
): { left: StatusItem[]; right: StatusItem[]; dropped: StatusItem[] } {
  const visible = items.filter((item) => item.visible !== false && item.text !== "");
  const kept = [...visible].sort((a, b) => b.priority - a.priority);
  const dropped: StatusItem[] = [];
  const total = (list: readonly StatusItem[]) =>
    list.reduce((sum, item) => sum + measure(item), 0) + Math.max(0, list.length - 1) * gap;
  while (kept.length > 0 && total(kept) > available) {
    const removed = kept.pop();
    if (removed) dropped.push(removed);
  }
  const left = kept.filter((item) => item.alignment === "left").sort((a, b) => b.priority - a.priority);
  const right = kept.filter((item) => item.alignment === "right").sort((a, b) => b.priority - a.priority);
  return { left, right, dropped };
}
