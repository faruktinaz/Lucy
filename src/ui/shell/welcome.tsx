/**
 * The editor area when nothing is open: the name, the workspace, and the core loop as
 * actions, with the keybindings this terminal can actually send (read from the registry).
 */
import { useApp, useStore } from "@/app/react";
import { tildify } from "@/core/paths";
import { displayWidth, plural, truncateEnd, truncateMiddle } from "@/core/text";
import { formatKeys, KeyHint } from "../primitives/key-hint";
import { CapCell } from "../primitives/shape";
import { attrs } from "../primitives/text";
import { usePointer } from "../primitives/use-pointer";
import { useTheme } from "../theme/theme-context";

interface WelcomeAction {
  label: string;
  command: string;
  /** The first step of the loop: drawn in the accent color. */
  primary?: boolean;
  /** Quiet text after the label (the number of changes). */
  detail?: string;
}

const COLUMN_WIDTH = 48;

const NO_COUNT = { get: () => undefined, subscribe: () => () => {} };

function WelcomeRow({ action, width }: { action: WelcomeAction; width: number }) {
  const app = useApp();
  const theme = useTheme();
  const c = theme.colors;
  const pointer = usePointer({ onClick: () => void app.run(action.command) });
  const sequence = app.keybindingFor(action.command);
  const keys = sequence ? formatKeys(sequence) : "";
  const detail = action.detail ? `  ${action.detail}` : "";
  // Row: margin, cap, label, detail, padding, key pill (two caps), cap, margin.
  const pad = Math.max(
    2,
    width - 4 - displayWidth(action.label) - displayWidth(detail) - displayWidth(keys) - 2,
  );
  const fill = pointer.hovered ? c.state.hover : undefined;
  const fg = action.primary ? c.accent.primary : pointer.hovered ? c.fg.default : c.fg.muted;
  return (
    <box height={1} flexShrink={0} width={width} flexDirection="row" {...pointer.props}>
      <box width={1} flexShrink={0} />
      <CapCell side="left" color={fill} />
      <box flexGrow={1} height={1} backgroundColor={fill}>
        <text selectable={false} fg={fg} attributes={attrs({ bold: action.primary === true })}>
          {action.label}
          <span fg={c.fg.subtle} attributes={0}>
            {detail}
          </span>
          {" ".repeat(pad)}
          {keys ? <KeyHint keys={sequence} /> : null}
        </text>
      </box>
      <CapCell side="right" color={fill} />
      <box width={1} flexShrink={0} />
    </box>
  );
}

/**
 * Leads with the loop Lucy is built around: start an agent, review what it changed, then the
 * everyday ways in. Actions whose feature is not registered are left out.
 */
function useWelcomeActions(): WelcomeAction[] {
  const app = useApp();
  // The Source Control view's own count, so the Welcome view and the view switcher agree.
  const scm = useStore(app.views.store, (state) => state.sidebar.find((view) => view.id === "scm"));
  const badge = useStore(scm?.badge ?? NO_COUNT);
  // The badge hides zero; Git's state tells "clean" apart from "not read yet".
  const loaded = useStore(app.services.git.store, (state) => state.status !== null);
  const changes = loaded ? (badge ?? 0) : null;
  const actions: WelcomeAction[] = [
    { label: "Start Claude Code", command: "ai.newSession", primary: true },
    {
      label: "Review changes",
      command: "view.showSourceControl",
      detail: changes === null ? undefined : changes === 0 ? "nothing to review" : plural(changes, "change"),
    },
    { label: "Open a file", command: "file.quickOpen" },
    { label: "Search", command: "view.showSearch" },
    { label: "All commands", command: "palette.show" },
  ];
  return actions.filter((action) => app.commands.has(action.command));
}

export function Welcome({ width, height }: { width: number; height: number }) {
  const app = useApp();
  const theme = useTheme();
  const c = theme.colors;
  const columnWidth = Math.max(26, Math.min(COLUMN_WIDTH, width - 4));
  const actions = useWelcomeActions().slice(0, height < 18 ? 3 : 5);
  // The demo lives in a long temporary path that says nothing to the reader; name it instead.
  const location = app.env.demo
    ? "Temporary copy, removed on quit"
    : truncateMiddle(tildify(app.workspace.root), columnWidth - 4);
  return (
    <box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
      <box width={columnWidth} flexDirection="column" flexShrink={0}>
        <box paddingX={2} flexShrink={0}>
          <text fg={c.fg.default} attributes={attrs({ bold: true })} selectable={false}>
            lucy
          </text>
        </box>
        <box paddingX={2} flexShrink={0}>
          <text fg={c.fg.subtle} selectable={false} wrapMode="none">
            {truncateEnd("The workspace around your coding agents", columnWidth - 4)}
          </text>
        </box>
        <box height={1} flexShrink={0} />
        <box paddingX={2} flexShrink={0}>
          <text fg={c.fg.default} selectable={false}>
            {app.workspace.name}
            {app.env.demo ? <span fg={c.fg.subtle}>{"  demo project"}</span> : null}
          </text>
        </box>
        <box paddingX={2} flexShrink={0}>
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
