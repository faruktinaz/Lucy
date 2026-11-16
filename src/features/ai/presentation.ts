/**
 * How agent sessions are described everywhere (panel header, tabs, sidebar, status bar):
 * one vocabulary, one tone per state. The state word always accompanies the colored dot, so
 * High Contrast never relies on color alone.
 */
import type { AgentActivity, AgentSession } from "@/adapters/agents";
import type { StatusTone } from "@/app/workbench/status-bar";
import type { TextTone } from "@/ui/primitives/text";

export const ACTIVITY_TONE: Readonly<Record<AgentActivity, TextTone>> = {
  working: "accent",
  idle: "subtle",
  attention: "warning",
  exited: "muted",
};

export const ACTIVITY_STATUS_TONE: Readonly<Record<AgentActivity, StatusTone>> = {
  working: "default",
  idle: "muted",
  attention: "warning",
  exited: "muted",
};

/** Short state word; an ended session says how it ended. */
export function activityLabel(session: AgentSession): string {
  switch (session.activity) {
    case "working":
      return "working";
    case "idle":
      return "idle";
    case "attention":
      return "needs attention";
    case "exited": {
      const state = session.terminal.state.get();
      if (state.status === "failed") return "failed to start";
      if (state.status === "starting") return "starting";
      if (state.signal) return "stopped";
      return state.exitCode === 0 ? "exited" : `exited (${state.exitCode ?? "?"})`;
    }
  }
}

/** Precedence for summarizing several sessions in one place (the status bar). */
const PRECEDENCE: readonly AgentActivity[] = ["attention", "working", "idle", "exited"];

export function summarize(
  sessions: readonly AgentSession[],
): { activity: AgentActivity; count: number } | null {
  for (const activity of PRECEDENCE) {
    const count = sessions.filter((session) => session.activity === activity).length;
    if (count > 0) return { activity, count };
  }
  return null;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** `14:02` today, `12 Nov` on other days. */
export function formatStartTime(at: number, now: number = Date.now()): string {
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString())
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** `just now`, `5 min ago`, `3 h ago`, `yesterday`, `4 days ago`, then a date. */
export function formatRelative(at: number, now: number = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return formatStartTime(at, now);
}
