/**
 * The "AI Sessions" sidebar view: the sessions running in Lucy now (Enter shows one, F2
 * renames, Delete closes), then previous sessions of this workspace read from Claude Code's
 * local history (Enter resumes one by id). The history is read-only and best effort, and the
 * view says so.
 */
import { useEffect, useMemo, useState } from "react";
import type { AgentSession, AgentSessionSummary } from "@/adapters/agents";
import { useApp, useKeyHandler, useStore, useZoneFocused } from "@/app/react";
import type { ViewComponent, ViewProps } from "@/app/workbench/views";
import { normalizeKey } from "@/core/keybindings";
import { displayWidth, sanitizeForDisplay } from "@/core/text";
import { Icon } from "@/ui/primitives/icon";
import { List } from "@/ui/primitives/list";
import { useMeasure } from "@/ui/primitives/measure";
import { Label, Span, type TextTone, toneColor } from "@/ui/primitives/text";
import { TreeRowContent } from "@/ui/primitives/tree";
import { useDensity, useTheme } from "@/ui/theme/theme-context";
import type { AiController, HistoryState } from "./ai-controller";
import { ACTIVITY_TONE, activityLabel, formatRelative, formatStartTime } from "./presentation";

type Row =
  | { readonly kind: "section"; readonly key: string; readonly title: string; readonly count?: number }
  | { readonly kind: "note"; readonly key: string; readonly text: string; readonly tone: TextTone }
  | { readonly kind: "gap"; readonly key: string }
  | { readonly kind: "live"; readonly key: string; readonly session: AgentSession }
  | { readonly kind: "history"; readonly key: string; readonly summary: AgentSessionSummary };

const selectable = (row: Row | undefined) => row?.kind === "live" || row?.kind === "history";

/** Greedy word wrap to `width` cells (notes are list rows, one line each). */
export function wrapWords(text: string, width: number): string[] {
  const words = sanitizeForDisplay(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (displayWidth(next) <= width || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function buildRows(
  sessions: readonly AgentSession[],
  history: HistoryState,
  providerName: string,
  newSessionKeys: string | undefined,
  width: number,
): Row[] {
  const rows: Row[] = [];
  const note = (key: string, text: string, tone: TextTone) => {
    wrapWords(text, Math.max(10, width)).forEach((line, index) => {
      rows.push({ kind: "note", key: `${key}-${index}`, text: line, tone });
    });
  };
  rows.push({ kind: "section", key: "running", title: "Running", count: sessions.length });
  if (sessions.length === 0) {
    note("no-live", "No session is running in Lucy.", "muted");
    note(
      "start",
      newSessionKeys ? `Start one with ${newSessionKeys}.` : "Start one from the AI panel.",
      "subtle",
    );
  }
  for (const session of sessions) rows.push({ kind: "live", key: `live-${session.id}`, session });
  rows.push({ kind: "gap", key: "gap" });
  const listing = history.listing;
  rows.push({ kind: "section", key: "history", title: "History", count: listing?.sessions.length });
  note("source", `From ${providerName}'s local history, best effort.`, "subtle");
  if (history.loading && !listing) note("loading", "Reading the history…", "muted");
  if (listing) {
    for (const summary of listing.sessions)
      rows.push({ kind: "history", key: `history-${summary.id}`, summary });
    if (listing.problem) note("problem", listing.problem, "muted");
  }
  return rows;
}

function SessionRows({ controller, width }: { controller: AiController; width: number }) {
  const app = useApp();
  const theme = useTheme();
  const focused = useZoneFocused();
  const sessions = useStore(controller.sessions);
  const history = useStore(controller.history);
  const newSessionKeys = app.keybindingLabel("ai.newSession");
  const rows = useMemo(
    () => buildRows(sessions, history, controller.providerName(), newSessionKeys, width),
    [sessions, history, controller, newSessionKeys, width],
  );
  const firstSelectable = rows.findIndex(selectable);
  const [selected, setSelected] = useState(firstSelectable);
  const index = selectable(rows[selected]) ? selected : firstSelectable;
  const current = rows[index];

  const move = (target: number) => {
    // Section titles and notes are not selectable: keep going in the same direction.
    const step = target >= index ? 1 : -1;
    for (let i = target; i >= 0 && i < rows.length; i += step) {
      if (selectable(rows[i])) {
        setSelected(i);
        return;
      }
    }
  };
  const activate = (at: number) => {
    const row = rows[at];
    if (row?.kind === "live") controller.focusSession(row.session.id);
    else if (row?.kind === "history") void controller.launch({ kind: "resume", sessionId: row.summary.id });
  };

  useKeyHandler((stroke) => {
    if (current?.kind !== "live" || stroke.ctrl || stroke.alt) return false;
    const key = normalizeKey(stroke.key) ?? stroke.key;
    if (key === "f2") {
      void controller.rename(current.session.id);
      return true;
    }
    if (key === "delete" || key === "backspace") {
      void controller.close(current.session.id);
      return true;
    }
    return false;
  });

  const now = Date.now();
  return (
    <List
      items={rows}
      selectedIndex={index}
      focused={focused}
      onSelect={move}
      onActivate={activate}
      renderRow={(row, state) => {
        switch (row.kind) {
          case "section":
            return (
              <Label variant="section">
                {row.title.toUpperCase()}
                {row.count ? <Span tone="subtle">{`  ${row.count}`}</Span> : null}
              </Label>
            );
          case "note":
            return <Label tone={row.tone}>{row.text}</Label>;
          case "gap":
            return null;
          case "live":
            return (
              <TreeRowContent
                depth={0}
                state={state}
                icon={<Icon name="modified" tone={ACTIVITY_TONE[row.session.activity]} />}
                label={row.session.title}
                description={formatStartTime(row.session.createdAt, now)}
                status={activityLabel(row.session)}
                statusColor={toneColor(theme, ACTIVITY_TONE[row.session.activity])}
              />
            );
          case "history":
            return (
              <TreeRowContent
                depth={0}
                state={state}
                icon={<Icon name="refresh" tone="subtle" />}
                label={row.summary.title}
                status={formatRelative(row.summary.updatedAt, now)}
                statusColor={theme.colors.fg.subtle}
              />
            );
        }
      }}
    />
  );
}

function AiSessionsView({ visible, controller }: ViewProps & { controller: AiController }) {
  const density = useDensity();
  const { size, onSizeChange } = useMeasure();
  // Reading the history touches only Claude Code's files, read-only; refresh when shown.
  useEffect(() => {
    if (!visible) return;
    controller.sessionManager();
    void controller.refreshHistory();
  }, [controller, visible]);
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} onSizeChange={onSizeChange}>
      {visible || size.width > 0 ? (
        <SessionRows controller={controller} width={size.width - density.rowPaddingX * 2 - 1} />
      ) : null}
    </box>
  );
}

export function createAiSessionsView(controller: AiController): ViewComponent<ViewProps> {
  return (props) => <AiSessionsView {...props} controller={controller} />;
}
