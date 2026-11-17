/**
 * Empty and error states. An empty state is a short title, one muted sentence and the
 * relevant actions with their real keybinding labels. An error state says what happened and
 * what to do, with a way out (Retry, Show Log).
 */
import { useOptionalApp } from "@/app/react";
import type { IconName } from "@/themes/icons";
import { useDensity, useTheme } from "../theme/theme-context";
import { Icon } from "./icon";
import { KeyHint } from "./key-hint";
import { attrs } from "./text";
import { usePointer } from "./use-pointer";

export interface StateAction {
  readonly label: string;
  /** Runs this command, and shows its keybinding. */
  readonly command?: string;
  readonly args?: unknown;
  /** Runs instead of a command. */
  readonly onPress?: () => void;
  /** An explicit key sequence to show (overrides the command's). */
  readonly keys?: string;
  readonly icon?: IconName;
}

function ActionRow({ action, align }: { action: StateAction; align: "left" | "center" }) {
  const theme = useTheme();
  const app = useOptionalApp();
  const pointer = usePointer({
    onClick: () => {
      if (action.onPress) action.onPress();
      else if (action.command) void app?.run(action.command, action.args);
    },
  });
  const c = theme.colors;
  const fg = pointer.hovered ? c.fg.default : c.accent.primary;
  return (
    <box
      height={1}
      flexShrink={0}
      flexDirection="row"
      alignSelf={align === "center" ? "center" : "flex-start"}
      backgroundColor={pointer.hovered ? c.state.hover : undefined}
      paddingX={1}
      {...pointer.props}
    >
      <text
        fg={fg}
        selectable={false}
        attributes={attrs({ underline: pointer.hovered && theme.highContrast })}
      >
        {action.icon ? <Icon name={action.icon} color={fg} /> : null}
        {action.label}
      </text>
      {action.keys || action.command ? (
        <text selectable={false} fg={c.fg.subtle}>
          {"  "}
          <KeyHint keys={action.keys} command={action.command} />
        </text>
      ) : null}
    </box>
  );
}

export interface EmptyStateProps {
  title: string;
  description?: string;
  actions?: readonly StateAction[];
  icon?: IconName;
  align?: "left" | "center";
}

export function EmptyState({ title, description, actions = [], icon, align = "left" }: EmptyStateProps) {
  const theme = useTheme();
  const density = useDensity();
  const c = theme.colors;
  const textAlign = align === "center" ? "center" : "left";
  return (
    <box
      flexDirection="column"
      paddingX={align === "center" ? 2 : density.rowPaddingX + 1}
      paddingTop={density.emptyStateTop}
      flexShrink={0}
    >
      <text
        fg={c.fg.default}
        attributes={attrs({ bold: true })}
        textAlign={textAlign}
        selectable={false}
        wrapMode="word"
      >
        {icon ? <Icon name={icon} tone="subtle" /> : null}
        {title}
      </text>
      {description ? (
        <text
          fg={c.fg.muted}
          textAlign={textAlign}
          selectable={false}
          wrapMode="word"
          marginTop={density.sectionGap > 0 ? 1 : 0}
        >
          {description}
        </text>
      ) : null}
      {actions.length > 0 ? (
        <box flexDirection="column" marginTop={1} marginLeft={align === "center" ? 0 : -1}>
          {actions.map((action) => (
            <ActionRow key={action.label} action={action} align={align} />
          ))}
        </box>
      ) : null}
    </box>
  );
}

export interface ErrorStateProps {
  title: string;
  /** What happened, in one or two sentences. */
  message?: string;
  /** What to do. */
  actions?: readonly StateAction[];
}

export function ErrorState({ title, message, actions = [] }: ErrorStateProps) {
  const theme = useTheme();
  const density = useDensity();
  const c = theme.colors;
  return (
    <box
      flexDirection="column"
      paddingX={density.rowPaddingX + 1}
      paddingTop={density.emptyStateTop}
      flexShrink={0}
    >
      <text fg={c.fg.default} attributes={attrs({ bold: true })} selectable={false} wrapMode="word">
        <Icon name="error" color={c.status.error} />
        {title}
      </text>
      {message ? (
        <text fg={c.fg.muted} selectable={false} wrapMode="word" marginTop={1}>
          {message}
        </text>
      ) : null}
      {actions.length > 0 ? (
        <box flexDirection="column" marginTop={1} marginLeft={-1}>
          {actions.map((action) => (
            <ActionRow key={action.label} action={action} align="left" />
          ))}
        </box>
      ) : null}
    </box>
  );
}
