/**
 * The Terminal tab of the bottom panel: a tab strip with one tab per shell (close kills it,
 * after confirmation while it runs), and one pane per shell below. Every pane stays mounted
 * for its session's lifetime; only the active one is visible.
 */
import { useEffect } from "react";
import { useApp, useStore } from "@/app/react";
import type { ViewComponent, ViewProps } from "@/app/workbench/views";
import { Icon } from "@/ui/primitives/icon";
import { useMeasure } from "@/ui/primitives/measure";
import { EmptyState } from "@/ui/primitives/states";
import { type TabItem, Tabs } from "@/ui/primitives/tabs";
import { Label } from "@/ui/primitives/text";
import { usePointer } from "@/ui/primitives/use-pointer";
import { useTheme } from "@/ui/theme/theme-context";
import { type ShellTerminal, type ShellTerminals, terminalTitle } from "./shell-terminals";
import { TerminalPane } from "./terminal-pane";

function TerminalTabs({
  terminals,
  activeId,
  controller,
  focused,
}: {
  terminals: readonly ShellTerminal[];
  activeId: string | null;
  controller: ShellTerminals;
  focused: boolean;
}) {
  const app = useApp();
  const theme = useTheme();
  const { size, onSizeChange } = useMeasure();
  // Titles follow OSC 0/2 and the exit state of every session.
  useStore(controller.revision);
  const items: TabItem[] = terminals.map((terminal) => {
    const status = terminal.session.state.get().status;
    const ended = status === "exited" || status === "failed";
    return {
      id: terminal.id,
      title: terminalTitle(terminal, terminals),
      icon: <Icon name="terminal" tone={ended ? "subtle" : "muted"} />,
      iconWidth: 2,
      closable: true,
      description: ended ? (status === "failed" ? "failed" : "exited") : undefined,
    };
  });
  const persistent = terminals.some((terminal) => terminal.session.persistent);
  return (
    <box
      height={1}
      flexShrink={0}
      flexDirection="row"
      onSizeChange={onSizeChange}
      backgroundColor={theme.colors.bg.surface}
    >
      <Tabs
        items={items}
        activeId={activeId}
        width={Math.max(0, size.width - (persistent ? PERSISTENT_WIDTH : 0))}
        focused={focused}
        surface={theme.colors.bg.surface}
        onSelect={(id) => {
          controller.activate(id);
          app.focus.focus("bottom");
        }}
        onClose={(id) => void controller.kill(id)}
        maxTitleWidth={24}
      />
      {persistent ? <PersistentBadge /> : null}
    </box>
  );
}

const PERSISTENT_WIDTH = 12;

/** Says that these sessions survive quitting Lucy (they run in Lucy's private tmux server). */
export function PersistentBadge() {
  const app = useApp();
  const pointer = usePointer({
    hint: {
      text: "Runs in Lucy's background tmux server: keeps running when Lucy quits",
      keys: app.keybindingFor("terminal.endBackgroundSessions"),
    },
  });
  return (
    <box height={1} flexShrink={0} paddingX={1} {...pointer.props}>
      <Label variant="hint">persistent</Label>
    </box>
  );
}

/** Reports the active pane's size, so the next shell starts at the size it will be shown at. */
function SizeReporter({ terminal, controller }: { terminal: ShellTerminal; controller: ShellTerminals }) {
  const cols = useStore(terminal.session.state, (state) => state.cols);
  const rows = useStore(terminal.session.state, (state) => state.rows);
  useEffect(() => controller.noteSize(cols, rows), [controller, cols, rows]);
  return null;
}

function TerminalView({ visible, focused, controller }: ViewProps & { controller: ShellTerminals }) {
  const app = useApp();
  const { terminals, activeId } = useStore(controller.store);
  const active = terminals.find((terminal) => terminal.id === activeId) ?? terminals[0];

  if (terminals.length === 0) {
    return (
      <EmptyState
        title="No terminal is open"
        description={`New shells start in ${app.workspace.name}.`}
        actions={[{ label: "New Terminal", command: "terminal.new" }]}
      />
    );
  }
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <TerminalTabs
        terminals={terminals}
        activeId={active?.id ?? null}
        controller={controller}
        focused={focused}
      />
      {active ? <SizeReporter terminal={active} controller={controller} /> : null}
      {terminals.map((terminal) => (
        <TerminalPane
          key={terminal.id}
          session={terminal.session}
          visible={visible && terminal === active}
          active={terminal === active}
          name={terminal.shellName}
          onRestart={() => void controller.restart(terminal.id)}
          onClose={() => void controller.kill(terminal.id)}
        />
      ))}
    </box>
  );
}

export function createTerminalView(controller: ShellTerminals): ViewComponent<ViewProps> {
  return (props) => <TerminalView {...props} controller={controller} />;
}
