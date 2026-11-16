/**
 * The activity bar: one icon per sidebar view. The active view is marked by an accent bar on
 * the outer edge and default-colored icon; the others are subtle. Views with a badge (Source
 * Control's change count) show it as a filled pill under the icon (beside it when compact).
 * The bar sits on `bg.inset`, a column visibly apart from the sidebar. A gear at the bottom opens the
 * preferences menu.
 */
import { useApp, useStore } from "@/app/react";
import type { SidebarViewContribution } from "@/app/workbench/views";
import { icon } from "@/themes/icons";
import { formatCount } from "../primitives/badge";
import { attrs } from "../primitives/text";
import { usePointer } from "../primitives/use-pointer";
import { useDensity, useTheme } from "../theme/theme-context";
import { SIZE } from "../tokens/spacing";

const NO_BADGE = { get: () => undefined, subscribe: () => () => {} };

function ActivityItem({
  view,
  active,
  sidebarShown,
  side,
  tall,
}: {
  view: SidebarViewContribution;
  active: boolean;
  /** The sidebar is on screen (not just requested). */
  sidebarShown: boolean;
  side: "left" | "right";
  /** Comfortable density: a second row under the icon holds the badge. */
  tall: boolean;
}) {
  const app = useApp();
  const theme = useTheme();
  const c = theme.colors;
  const badge = useStore(view.badge ?? NO_BADGE) ?? 0;
  const pointer = usePointer({
    hint: { text: view.title, keys: view.command ? app.keybindingFor(view.command) : undefined },
    onClick: () => {
      // Clicking the active view's icon hides the sidebar, as in VS Code.
      if (active && sidebarShown) {
        app.layout.setSidebarVisible(false);
        app.focus.focus("editor");
        return;
      }
      app.layout.showSidebarView(view.id);
      app.focus.focus("sidebar");
    },
  });
  const marked = active && sidebarShown;
  const fg = marked || pointer.hovered ? c.fg.default : c.fg.subtle;
  // The marker hugs the outer edge of the window.
  const marker = marked ? (side === "left" ? "▎" : "▕") : " ";
  const count = badge > 0 ? formatCount(badge, 2) : "";
  const bg = pointer.hovered ? c.state.hover : undefined;
  const iconCell = (
    <text fg={fg} selectable={false} attributes={attrs({ bold: marked && theme.highContrast })}>
      {icon(view.icon, theme.icons)}
    </text>
  );
  const badgeCell = (
    <text selectable={false}>
      <span fg={c.badge.fg} bg={c.badge.bg} attributes={attrs({ bold: true })}>
        {count}
      </span>
    </text>
  );
  const markerCell = (
    <text fg={c.accent.primary} selectable={false} width={1} flexShrink={0}>
      {marker}
    </text>
  );
  if (!tall) {
    return (
      <box height={1} flexShrink={0} flexDirection="row" backgroundColor={bg} {...pointer.props}>
        {side === "left" ? markerCell : null}
        <box width={1} flexShrink={0}>
          {iconCell}
        </box>
        <box width={2} flexShrink={0} flexDirection="row">
          {count ? badgeCell : null}
        </box>
        {side === "right" ? markerCell : null}
      </box>
    );
  }
  return (
    <box height={2} flexShrink={0} flexDirection="column" backgroundColor={bg} {...pointer.props}>
      <box height={1} flexDirection="row">
        {side === "left" ? markerCell : null}
        <box width={3} flexShrink={0} justifyContent="center" flexDirection="row">
          {iconCell}
        </box>
        {side === "right" ? markerCell : null}
      </box>
      {/* The count hangs from the icon's column as a filled pill: plain digits at the left
          edge read as line numbers of the sidebar beside it. */}
      <box height={1} flexDirection="row" paddingLeft={side === "left" ? 2 : 1}>
        {count ? badgeCell : null}
      </box>
    </box>
  );
}

function GearItem() {
  const app = useApp();
  const theme = useTheme();
  const c = theme.colors;
  const pointer = usePointer({
    hint: { text: "Manage" },
    onClick: (event) => {
      app.menus.show({
        x: event.x,
        y: Math.max(0, event.y - 7),
        items: [
          { id: "palette", label: "Command Palette", command: "palette.show" },
          { id: "settings", label: "Settings", command: "settings.open" },
          { id: "keys", label: "Keyboard Shortcuts", command: "keybindings.open" },
          { id: "sep", kind: "separator" },
          { id: "theme", label: "Color Theme", command: "theme.select" },
        ],
      });
    },
  });
  return (
    <box
      height={1}
      flexShrink={0}
      flexDirection="row"
      backgroundColor={pointer.hovered ? c.state.hover : undefined}
      {...pointer.props}
    >
      <box width={4} flexShrink={0} justifyContent="center" flexDirection="row">
        <text fg={pointer.hovered ? c.fg.default : c.fg.subtle} selectable={false}>
          {icon("settings", theme.icons)}
        </text>
      </box>
    </box>
  );
}

export function ActivityBar({ side }: { side: "left" | "right" }) {
  const app = useApp();
  const theme = useTheme();
  const density = useDensity();
  const views = useStore(app.views.store, (state) => state.sidebar);
  const activeView = useStore(app.layout.store, (state) => state.sidebar.view);
  const shown = useStore(app.layout.effective, (state) => state.sidebar.visible);
  const tall = density.sectionGap > 0;
  return (
    <box
      width={SIZE.activityBarWidth}
      flexShrink={0}
      flexDirection="column"
      // A column of its own: the sunken fill sets the view switcher apart from the sidebar.
      backgroundColor={theme.colors.bg.inset}
    >
      {views.map((view) => (
        <ActivityItem
          key={view.id}
          view={view}
          active={activeView === view.id}
          sidebarShown={shown}
          side={side}
          tall={tall}
        />
      ))}
      <box flexGrow={1} />
      <GearItem />
      <box height={density.sectionGap} flexShrink={0} />
    </box>
  );
}
