/**
 * The editor area when nothing is open: the name, the workspace, and a few key actions with
 * the keybindings this terminal can actually send (read from the registry).
 */
import { useApp } from "@/app/react";
import { tildify } from "@/core/paths";
import { displayWidth, truncateMiddle } from "@/core/text";
import { formatKeys } from "../primitives/key-hint";
import { attrs } from "../primitives/text";
import { usePointer } from "../primitives/use-pointer";
import { useTheme } from "../theme/theme-context";

interface WelcomeAction {
  label: string;
  command: string;
}

const ACTIONS: readonly WelcomeAction[] = [
  { label: "Open a file", command: "file.quickOpen" },
  { label: "Show all commands", command: "palette.show" },
  { label: "Search in files", command: "view.showSearch" },
  { label: "Source control", command: "view.showSourceControl" },
  { label: "Ask Claude", command: "view.focusAiPanel" },
  { label: "Open a terminal", command: "terminal.toggle" },
];

const COLUMN_WIDTH = 44;

function WelcomeRow({ action, width }: { action: WelcomeAction; width: number }) {
  const app = useApp();
  const theme = useTheme();
  const c = theme.colors;
  const pointer = usePointer({ onClick: () => void app.run(action.command) });
  const sequence = app.keybindingFor(action.command);
  const keys = sequence ? formatKeys(sequence) : "";
  const pad = Math.max(2, width - 2 - displayWidth(action.label) - displayWidth(keys));
  return (
    <box
      height={1}
      flexShrink={0}
      paddingX={1}
      width={width}
      backgroundColor={pointer.hovered ? c.state.hover : undefined}
      {...pointer.props}
    >
      <text selectable={false} fg={pointer.hovered ? c.fg.default : c.fg.muted}>
        {action.label}
        {" ".repeat(pad)}
        <span fg={c.fg.subtle}>{keys}</span>
      </text>
    </box>
  );
}

export function Welcome({ width, height }: { width: number; height: number }) {
  const app = useApp();
  const theme = useTheme();
  const c = theme.colors;
  const columnWidth = Math.max(24, Math.min(COLUMN_WIDTH, width - 4));
  const actions = ACTIONS.filter((action) => app.commands.has(action.command)).slice(0, height < 20 ? 4 : 6);
  const location = truncateMiddle(tildify(app.workspace.root), columnWidth - 2);
  return (
    <box
      flexGrow={1}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      backgroundColor={c.bg.base}
    >
      <box width={columnWidth} flexDirection="column" flexShrink={0}>
        <box paddingX={1} flexShrink={0}>
          <text fg={c.fg.default} attributes={attrs({ bold: true })} selectable={false}>
            lucy
          </text>
        </box>
        <box paddingX={1} flexShrink={0}>
          <text fg={c.fg.muted} selectable={false}>
            {app.workspace.name}
            {app.env.demo ? <span fg={c.fg.subtle}>{"  demo workspace"}</span> : null}
          </text>
        </box>
        <box paddingX={1} flexShrink={0}>
          <text fg={c.fg.subtle} selectable={false}>
            {location}
          </text>
        </box>
        <box height={height < 20 ? 1 : 2} flexShrink={0} />
        {actions.map((action) => (
          <WelcomeRow key={action.command} action={action} width={columnWidth} />
        ))}
      </box>
      {/* Optical centering: the block sits a little above the middle. */}
      <box height={Math.max(0, Math.floor(height / 8))} flexShrink={0} />
    </box>
  );
}
