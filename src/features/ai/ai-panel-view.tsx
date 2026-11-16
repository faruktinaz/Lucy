/**
 * The AI panel (auxiliary view): the start screen while no session exists, otherwise a
 * session header (title, activity, changed files, actions), tabs when there are several
 * sessions, and one terminal pane per session. Every pane stays mounted for its session's
 * lifetime, so hiding the panel or switching tabs never loses Claude Code's screen.
 */
import type { BoxRenderable, MouseEvent } from "@opentui/core";
import { useEffect, useRef } from "react";
import type { AgentSession } from "@/adapters/agents";
import { useApp, useStore } from "@/app/react";
import type { MenuItem } from "@/app/workbench/menus";
import type { ViewComponent, ViewProps } from "@/app/workbench/views";
import { displayWidth, sanitizeForDisplay, truncateEnd } from "@/core/text";
import { TerminalPane } from "@/features/terminal";
import { IconButton } from "@/ui/primitives/button";
import { Icon } from "@/ui/primitives/icon";
import { KeyHint } from "@/ui/primitives/key-hint";
import { useMeasure } from "@/ui/primitives/measure";
import { type TabItem, Tabs } from "@/ui/primitives/tabs";
import { Span } from "@/ui/primitives/text";
import { usePointer } from "@/ui/primitives/use-pointer";
import { useDensity, useTheme } from "@/ui/theme/theme-context";
import type { AiController, PanelClosePolicy } from "./ai-controller";
import { AiStartScreen } from "./ai-start-screen";
import { ACTIVITY_TONE, activityLabel } from "./presentation";

/** Rows above and below the terminal: the session header and the policy footer. */
const CHROME_ROWS = 2;

function sessionMenu(session: AgentSession): MenuItem[] {
  const args = { id: session.id };
  return [
    { id: "rename", label: "Rename…", command: "ai.renameSession", args },
    { id: "restart", label: "Restart", command: "ai.restartSession", args },
    { id: "template", label: "Insert Prompt Template…", command: "ai.insertPromptTemplate" },
    { kind: "separator", id: "sep" },
    {
      id: "close",
      label: session.terminal.isRunning ? "Stop and Close" : "Close",
      command: "ai.closeSession",
      args,
      danger: true,
    },
  ];
}

/** Changed files in the working tree; activating it shows Source Control. */
function ChangesChip() {
  const app = useApp();
  const theme = useTheme();
  const count = useStore(app.services.git.store, (state) => state.status?.changes.length ?? 0);
  const pointer = usePointer({
    onClick: () => void app.run("view.showSourceControl"),
    hint: {
      text: `${count} changed ${count === 1 ? "file" : "files"} · Show Source Control`,
      keys: app.keybindingFor("view.showSourceControl"),
    },
  });
  if (count === 0) return null;
  const c = theme.colors;
  return (
    <box
      height={1}
      flexShrink={0}
      paddingX={1}
      backgroundColor={pointer.hovered ? c.state.hover : undefined}
      {...pointer.props}
    >
      <text fg={pointer.hovered ? c.fg.default : c.fg.muted} selectable={false} wrapMode="none">
        <Icon name="sourceControl" tone={pointer.hovered ? "default" : "muted"} />
        {String(count)}
      </text>
    </box>
  );
}

function SessionHeader({ session, controller }: { session: AgentSession; controller: AiController }) {
  const app = useApp();
  const theme = useTheme();
  const density = useDensity();
  const row = useRef<BoxRenderable>(null);
  const { size, onSizeChange } = useMeasure();
  // Re-render on the terminal's own changes too (exit code, start failure).
  useStore(session.terminal.state, (state) => state.status);
  const state = activityLabel(session);
  const fixed = density.rowPaddingX + 2 + displayWidth(state) + 2 + 6 + 6;
  const title = truncateEnd(sanitizeForDisplay(session.title), Math.max(4, size.width - fixed));
  const c = theme.colors;
  const openMenu = () => {
    const box = row.current;
    const x = box ? box.x + box.width - 26 : 0;
    const y = box ? box.y + 1 : 0;
    app.menus.show({ x, y, items: sessionMenu(session) });
  };
  return (
    <box
      ref={row}
      height={1}
      flexShrink={0}
      flexDirection="row"
      paddingLeft={density.rowPaddingX}
      backgroundColor={c.bg.surface}
      onSizeChange={onSizeChange}
    >
      <text flexGrow={1} flexShrink={1} selectable={false} wrapMode="none" fg={c.fg.default}>
        <Icon name="modified" tone={ACTIVITY_TONE[session.activity]} />
        <Span bold={theme.highContrast}>{title}</Span>
        <Span tone={session.activity === "attention" ? "warning" : "subtle"}>{`  ${state}`}</Span>
      </text>
      <ChangesChip />
      <IconButton
        icon="ai"
        hint={{ text: "Insert prompt template", keys: app.keybindingFor("ai.insertPromptTemplate") }}
        onPress={() => void controller.insertTemplate()}
        surface={c.bg.surface}
      />
      <IconButton icon="more" hint={{ text: "Session actions" }} onPress={openMenu} surface={c.bg.surface} />
    </box>
  );
}

function SessionTabs({
  sessions,
  active,
  controller,
}: {
  sessions: readonly AgentSession[];
  active: AgentSession;
  controller: AiController;
}) {
  const app = useApp();
  const theme = useTheme();
  const { size, onSizeChange } = useMeasure();
  const items: TabItem[] = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    icon: <Icon name="modified" tone={ACTIVITY_TONE[session.activity]} />,
    iconWidth: 2,
    closable: true,
  }));
  return (
    <box height={1} flexShrink={0} onSizeChange={onSizeChange} backgroundColor={theme.colors.bg.surface}>
      <Tabs
        items={items}
        activeId={active.id}
        width={size.width}
        surface={theme.colors.bg.surface}
        onSelect={(id) => controller.focusSession(id)}
        onClose={(id) => void controller.close(id)}
        onContextMenu={(id, event: MouseEvent) => {
          const session = controller.get(id);
          if (session) app.menus.show({ x: event.x, y: event.y, items: sessionMenu(session) });
        }}
        maxTitleWidth={22}
      />
    </box>
  );
}

const POLICY_TEXT: Readonly<Record<PanelClosePolicy, string>> = {
  "keep-running": "Hide panel: sessions keep running",
  terminate: "Hide panel: sessions are stopped",
  ask: "Hide panel: asks before stopping",
};

/** States plainly what hiding the panel will do (`ai.onPanelClose`); the key goes first when space is short. */
function PolicyFooter() {
  const app = useApp();
  const theme = useTheme();
  const density = useDensity();
  const policy = useStore(app.config.store, (config) => config.ai.onPanelClose);
  const { size, onSizeChange } = useMeasure();
  const room = Math.max(4, size.width - density.rowPaddingX);
  const full = POLICY_TEXT[policy];
  const keys = app.keybindingLabel("view.toggleAiPanel");
  const showKeys = keys !== undefined && displayWidth(full) + 2 + displayWidth(keys) <= room;
  return (
    <box
      height={1}
      flexShrink={0}
      paddingLeft={density.rowPaddingX}
      onSizeChange={onSizeChange}
      backgroundColor={theme.colors.bg.surface}
    >
      <text selectable={false} wrapMode="none" fg={theme.colors.fg.subtle}>
        {truncateEnd(full, room)}
        {showKeys ? <Span tone="subtle">{"  "}</Span> : null}
        {showKeys ? <KeyHint command="view.toggleAiPanel" /> : null}
      </text>
    </box>
  );
}

function Sessions({
  sessions,
  visible,
  controller,
}: {
  sessions: readonly AgentSession[];
  visible: boolean;
  controller: AiController;
}) {
  const activeId = useStore(controller.store, (state) => state.activeId);
  const active = sessions.find((session) => session.id === activeId) ?? sessions.at(-1);
  if (!active) return null;
  const name = controller.providerName();
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <SessionHeader session={active} controller={controller} />
      {sessions.length > 1 ? (
        <SessionTabs sessions={sessions} active={active} controller={controller} />
      ) : null}
      <box flexDirection="column" flexGrow={1} minHeight={0}>
        {sessions.map((session) => (
          <TerminalPane
            key={session.id}
            session={session.terminal}
            visible={visible && session === active}
            active={session === active}
            name={name}
            onRestart={() => void controller.restart(session.id)}
            onClose={() => void controller.close(session.id)}
          />
        ))}
      </box>
      <PolicyFooter />
    </box>
  );
}

function AiPanelView({ visible, controller }: ViewProps & { controller: AiController }) {
  const density = useDensity();
  const sessions = useStore(controller.sessions);
  const { size, onSizeChange } = useMeasure();

  // New sessions start at the size of the terminal area (no resize right after start).
  useEffect(() => {
    const tabs = sessions.length > 1 ? 1 : 0;
    controller.noteArea(size.width - density.rowPaddingX, size.height - CHROME_ROWS - tabs);
  }, [controller, size.width, size.height, sessions.length, density.rowPaddingX]);

  // Looking for the CLI runs `claude --version`: only once the panel is actually shown.
  useEffect(() => {
    if (visible && sessions.length === 0) void controller.ensureDetection();
  }, [controller, visible, sessions.length]);

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} onSizeChange={onSizeChange}>
      {sessions.length === 0 ? (
        <AiStartScreen controller={controller} />
      ) : (
        <Sessions sessions={sessions} visible={visible} controller={controller} />
      )}
    </box>
  );
}

export function createAiPanelView(controller: AiController): ViewComponent<ViewProps> {
  return (props) => <AiPanelView {...props} controller={controller} />;
}
