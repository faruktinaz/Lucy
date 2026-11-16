/**
 * Toasts: bottom right, above the status bar, on the raised surface with a thin
 * status-colored edge. At most three, newest at the bottom. Hovering shows a close button.
 */
import { useApp, useStore } from "@/app/react";
import type { Notification } from "@/app/workbench/notifications";
import { sanitizeForDisplay, truncateEnd } from "@/core/text";
import { type IconName, icon } from "@/themes/icons";
import { attrs } from "../primitives/text";
import { usePointer } from "../primitives/use-pointer";
import { useDensity, useTheme } from "../theme/theme-context";
import type { UiTheme } from "../theme/ui-theme";
import { SIZE } from "../tokens/spacing";

const SEVERITY_ICON: Record<Notification["severity"], IconName> = {
  info: "info",
  success: "check",
  warning: "warning",
  error: "error",
};

function severityColor(theme: UiTheme, severity: Notification["severity"]) {
  const s = theme.colors.status;
  return severity === "success"
    ? s.success
    : severity === "warning"
      ? s.warning
      : severity === "error"
        ? s.error
        : s.info;
}

function ToastAction({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  const pointer = usePointer({ onClick: onPress });
  const c = theme.colors;
  return (
    <box
      height={1}
      paddingX={1}
      backgroundColor={pointer.hovered ? c.state.hover : undefined}
      {...pointer.props}
    >
      <text fg={pointer.hovered ? c.fg.default : c.accent.primary} selectable={false}>
        {label}
      </text>
    </box>
  );
}

/** One toast. Presentational: the stack and the component gallery both use it. */
export function ToastCard({
  notification,
  width,
  onDismiss,
  onAction,
  forceHover,
}: {
  notification: Notification;
  width: number;
  onDismiss?: () => void;
  onAction?: (action: NonNullable<Notification["actions"]>[number]) => void;
  forceHover?: boolean;
}) {
  const theme = useTheme();
  const density = useDensity();
  const c = theme.colors;
  const hover = usePointer({});
  const pointer = { ...hover, hovered: forceHover ?? hover.hovered };
  const close = usePointer({ onClick: () => onDismiss?.() });
  const edge = severityColor(theme, notification.severity);
  const actions = notification.actions ?? [];
  return (
    <box width={width} flexDirection="row" backgroundColor={c.bg.raised} flexShrink={0} {...pointer.props}>
      {/* A thin status-colored edge: a one-quarter block on every row. Absolute, so it
          follows the card's height instead of setting it. */}
      <box position="absolute" left={0} top={0} width={1} height="100%" overflow="hidden">
        <text fg={edge} selectable={false}>
          {"▎\n".repeat(16)}
        </text>
      </box>
      <box
        flexGrow={1}
        flexDirection="column"
        paddingLeft={2}
        paddingRight={1}
        paddingY={density.overlayPaddingY}
      >
        <box height={1} flexDirection="row" flexShrink={0}>
          <text flexGrow={1} fg={c.fg.default} selectable={false} wrapMode="none">
            <span fg={edge}>{`${icon(SEVERITY_ICON[notification.severity], theme.icons)} `}</span>
            <span attributes={attrs({ bold: true })}>
              {truncateEnd(sanitizeForDisplay(notification.title), Math.max(4, width - 7))}
            </span>
          </text>
          <box width={2} flexShrink={0} {...close.props}>
            <text fg={close.hovered ? c.fg.default : c.fg.subtle} selectable={false}>
              {pointer.hovered ? ` ${icon("close", theme.icons)}` : "  "}
            </text>
          </box>
        </box>
        {notification.message ? (
          <text fg={c.fg.muted} selectable={false} wrapMode="word" paddingLeft={2}>
            {notification.message}
          </text>
        ) : null}
        {actions.length > 0 ? (
          <box flexDirection="row" gap={1} marginLeft={1} flexShrink={0}>
            {actions.map((action) => (
              <ToastAction key={action.label} label={action.label} onPress={() => onAction?.(action)} />
            ))}
          </box>
        ) : null}
      </box>
    </box>
  );
}

export function ToastStack({ width: screenWidth, bottom }: { width: number; bottom: number }) {
  const app = useApp();
  const toasts = useStore(app.notifications.store, (state) => state.toasts);
  if (toasts.length === 0) return null;
  const width = Math.min(SIZE.toastWidth, screenWidth - 2);
  return (
    <box
      position="absolute"
      right={1}
      bottom={bottom}
      width={width}
      zIndex={50}
      flexDirection="column"
      gap={1}
    >
      {toasts.map((toast) => (
        <ToastCard
          key={toast.id}
          notification={toast}
          width={width}
          onDismiss={() => app.notifications.dismiss(toast.id)}
          onAction={(action) => {
            app.notifications.dismiss(toast.id);
            void Promise.resolve()
              .then(() => action.run())
              .catch((error: unknown) => app.log.error("Notification action failed", { error }));
          }}
        />
      ))}
    </box>
  );
}
