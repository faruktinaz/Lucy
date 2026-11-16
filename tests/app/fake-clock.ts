/** A manual clock for services that take a `Clock` (notifications, hints). */
import type { Clock } from "@/app/workbench/readable";

export interface FakeClock extends Clock {
  /** Advances time and runs every timer that became due, in order. */
  advance(ms: number): void;
  readonly pending: number;
}

export function createFakeClock(start = 0): FakeClock {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimeout: (callback, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    advance(ms) {
      const target = now + ms;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = target;
    },
    get pending() {
      return timers.size;
    },
  };
}
