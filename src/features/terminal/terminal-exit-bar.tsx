/**
 * The calm notice over the bottom of a terminal whose process ended: what happened (exit code,
 * signal or start failure) and how to go on. The terminal's last output stays visible above.
 */
import type { TerminalSession, TerminalSessionState } from "@/adapters/pty";
import { useStore } from "@/app/react";
import { truncateEnd } from "@/core/text";
import type { IconName } from "@/themes/icons";
import { Icon } from "@/ui/primitives/icon";
import { KeyHint } from "@/ui/primitives/key-hint";
import { Span, type TextTone } from "@/ui/primitives/text";
import { usePointer } from "@/ui/primitives/use-pointer";
import { useTheme } from "@/ui/theme/theme-context";

export interface ExitSummary {
  readonly icon: IconName;
  readonly tone: TextTone;
  readonly title: string;
  /** A second line with details (the start error). */
  readonly detail?: string;
}

/** How a terminal's end is described. Exported for the AI panel header and for tests. */
export function describeExit(name: string, state: TerminalSessionState): ExitSummary {
  if (state.status === "failed") {
    return {
      icon: "error",
      tone: "error",
      title: `Could not start ${name}`,
      detail: state.error?.message,
    };
  }
  // Restored as ended (for example after a reboot): say why instead of a code.
  if (state.error && state.exitCode === null && !state.signal) {
    return { icon: "info", tone: "muted", title: `${name} ended`, detail: state.error.message };
  }
  if (state.signal) return { icon: "info", tone: "muted", title: `${name} was stopped (${state.signal})` };
  if (state.exitCode === 0) return { icon: "check", tone: "success", title: `${name} exited` };
  return { icon: "warning", tone: "warning", title: `${name} exited with code ${state.exitCode ?? "?"}` };
}

function ExitAction({ label, keys, onPress }: { label: string; keys: string; onPress: () => void }) {
  const theme = useTheme();
  const pointer = usePointer({ onClick: onPress, hint: { text: label, keys } });
  const c = theme.colors;
  return (
    <box
      height={1}
      flexShrink={0}
      paddingX={1}
      backgroundColor={pointer.hovered ? c.state.hover : undefined}
      {...pointer.props}
    >
      <text fg={pointer.hovered ? c.fg.default : c.accent.primary} selectable={false} wrapMode="none">
        {label}
        <Span tone="subtle">{"  "}</Span>
        <KeyHint keys={keys} />
      </text>
    </box>
  );
}

export function TerminalExitBar({
  name,
  session,
  onRestart,
  onClose,
  restartLabel = "Restart",
}: {
  name: string;
  session: TerminalSession;
  onRestart: () => void;
  onClose: () => void;
  restartLabel?: string;
}) {
  const theme = useTheme();
  const state = useStore(session.state);
  const summary = describeExit(name, state);
  const c = theme.colors;
  return (
    <box
      position="absolute"
      left={0}
      right={0}
      bottom={0}
      flexDirection="column"
      backgroundColor={c.bg.raised}
      paddingTop={1}
      paddingBottom={1}
    >
      <box flexDirection="row" paddingLeft={1}>
        <text fg={c.fg.default} selectable={false} wrapMode="none" flexShrink={1}>
          <Icon name={summary.icon} tone={summary.tone} />
          {summary.title}
        </text>
      </box>
      {summary.detail ? (
        <box paddingLeft={3}>
          <text fg={c.fg.muted} selectable={false} wrapMode="word">
            {truncateEnd(summary.detail.replace(/\s+/g, " "), 240)}
          </text>
        </box>
      ) : null}
      <box flexDirection="row" paddingLeft={2} marginTop={1}>
        <ExitAction label={restartLabel} keys="enter" onPress={onRestart} />
        <ExitAction label="Close" keys="ctrl+w" onPress={onClose} />
      </box>
    </box>
  );
}
