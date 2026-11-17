/**
 * The sidebar card. Its header is the view switcher: the active view as a pill with icon and
 * name, the other views as icons with their count, so navigation reads as words instead of
 * an icon column, and the four columns of the old activity bar go back to content. Views
 * with order 90 and above (Integrations) are utilities reached from the command bar and the
 * palette. The view's actions sit on the right; those that do not fit move into a menu.
 *
 * Every registered view stays mounted (hidden ones with `visible={false}`) so switching keeps
 * scroll positions and in-progress state.
 */

import { logFilePath } from "@/app/log-file";
import { useApp, useStore, useZoneFocused } from "@/app/react";
import type { SidebarViewContribution } from "@/app/workbench/views";
import { displayWidth } from "@/core/text";
import { icon } from "@/themes/icons";
import { formatCount } from "../primitives/badge";
import { IconButton } from "../primitives/button";
import { type HeaderAction, PanelHeader } from "../primitives/headers";
import { useMeasure } from "../primitives/measure";
import { PanelBoundary } from "../primitives/panel-boundary";
import { ResizeHandle } from "../primitives/resize-handle";
import { CapCell } from "../primitives/shape";
import { EmptyState } from "../primitives/states";
import { attrs } from "../primitives/text";
import { usePointer } from "../primitives/use-pointer";
import { useTheme } from "../theme/theme-context";
import { useViewActions } from "./view-actions";
import { ZoneBox } from "./zone";

/** Views from this order on are utilities: not in the switcher. */
export const UTILITY_VIEW_ORDER = 90;

/** Short names for the built-in views; others use their title. */
const SHORT_NAMES: Readonly<Record<string, string>> = {
  explorer: "Files",
  search: "Search",
  scm: "Changes",
  aiSessions: "Sessions",
};

export function viewLabel(view: SidebarViewContribution): string {
  return SHORT_NAMES[view.id] ?? view.title;
}

const NO_BADGE = { get: () => undefined, subscribe: () => () => {} };

function SwitcherItem({
  view,
  active,
  focused,
}: {
  view: SidebarViewContribution;
  active: boolean;
  focused: boolean;
}) {
  const app = useApp();
  const theme = useTheme();
  const c = theme.colors;
  const badge = useStore(view.badge ?? NO_BADGE) ?? 0;
  const pointer = usePointer({
    hint: { text: view.title, keys: view.command ? app.keybindingFor(view.command) : undefined },
    onClick: () => {
      app.layout.showSidebarView(view.id);
      app.focus.focus("sidebar");
    },
  });
  const glyph = icon(view.icon, theme.icons);
  if (active) {
    const fill = pointer.hovered ? c.state.hover : c.bg.raised;
    const fg = focused ? c.accent.primary : c.fg.default;
    return (
      <box height={1} flexDirection="row" flexShrink={0} {...pointer.props}>
        <CapCell side="left" color={fill} />
        <box height={1} backgroundColor={fill} flexDirection="row">
          <text fg={fg} selectable={false} attributes={attrs({ bold: focused || theme.highContrast })}>
            {`${glyph} ${viewLabel(view)}`}
          </text>
        </box>
        <CapCell side="right" color={fill} />
      </box>
    );
  }
  const count = badge > 0 ? formatCount(badge, 3) : "";
  const fill = pointer.hovered ? c.state.hover : undefined;
  return (
    <box height={1} flexDirection="row" flexShrink={0} {...pointer.props}>
      <CapCell side="left" color={fill} />
      <box height={1} backgroundColor={fill} flexDirection="row">
        <text fg={pointer.hovered ? c.fg.default : c.fg.subtle} selectable={false}>
          {glyph}
          {count ? <span fg={c.accent.primary}>{` ${count}`}</span> : null}
        </text>
      </box>
      <CapCell side="right" color={fill} />
    </box>
  );
}

/** Width of a switcher item in cells (caps included). */
function itemWidth(view: SidebarViewContribution, active: boolean, badge: number): number {
  if (active) return 2 + 2 + displayWidth(viewLabel(view));
  return 2 + 1 + (badge > 0 ? 1 + formatCount(badge, 3).length : 0);
}

function HeaderActions({ actions, room }: { actions: readonly HeaderAction[]; room: number }) {
  const app = useApp();
  const theme = useTheme();
  const surface = theme.shell.panel;
  const fits = Math.max(0, Math.floor(room / 3));
  if (actions.length <= fits) {
    return (
      <>
        {actions.map((action) => (
          <IconButton
            key={action.icon}
            icon={action.icon}
            hint={action.hint}
            onPress={action.onPress}
            surface={surface}
          />
        ))}
      </>
    );
  }
  const shown = actions.slice(0, Math.max(0, fits - 1));
  const rest = actions.slice(shown.length);
  return (
    <>
      {shown.map((action) => (
        <IconButton
          key={action.icon}
          icon={action.icon}
          hint={action.hint}
          onPress={action.onPress}
          surface={surface}
        />
      ))}
      <IconButton
        icon="more"
        surface={surface}
        hint={{ text: "More actions" }}
        onPress={() => {
          const width = app.layout.effective.get();
          app.menus.show({
            x:
              width.gap +
              (width.sidebarSide === "left" ? width.sidebar.width - 4 : width.width - width.sidebar.width),
            y: 2,
            items: rest.map((action, index) => ({
              id: `${index}`,
              label: action.hint?.text ?? "Action",
              icon: action.icon,
              keybinding: action.hint?.keys,
              run: action.onPress,
            })),
          });
        }}
      />
    </>
  );
}

function SidebarHeader() {
  const app = useApp();
  const focused = useZoneFocused();
  const views = useStore(app.views.store, (state) => state.sidebar);
  const active = useStore(app.layout.store, (state) => state.sidebar.view);
  const switcher = useStore(app.layout.effective, (state) => state.viewSwitcher);
  const view = views.find((v) => v.id === active) ?? views[0];
  const actions = useViewActions(view?.actions);
  const { size, onSizeChange } = useMeasure();
  const badges = views.map((v) => v.badge?.get() ?? 0);
  const listed = views.filter((v) => v.order < UTILITY_VIEW_ORDER || v === view);
  if (!switcher || !view) {
    return <PanelHeader title={view?.title ?? "Sidebar"} focused={focused} actions={actions} />;
  }
  const used = listed.reduce((sum, v) => sum + itemWidth(v, v === view, badges[views.indexOf(v)] ?? 0), 0);
  return (
    <box height={1} flexShrink={0} flexDirection="row" paddingX={1} onSizeChange={onSizeChange}>
      {listed.map((v) => (
        <SwitcherItem key={v.id} view={v} active={v === view} focused={focused} />
      ))}
      <box flexGrow={1} minWidth={0} />
      <HeaderActions actions={actions} room={size.width - 2 - used - 1} />
    </box>
  );
}

function SidebarViews() {
  const app = useApp();
  const focused = useZoneFocused();
  const views = useStore(app.views.store, (state) => state.sidebar);
  const active = useStore(app.layout.store, (state) => state.sidebar.view);
  const shown = views.find((v) => v.id === active) ?? views[0];
  if (views.length === 0) {
    return <EmptyState title="No views" description="No feature contributes a sidebar view." />;
  }
  return (
    <>
      {views.map((view) => {
        const visible = view === shown;
        const Component = view.component;
        return (
          <box key={view.id} visible={visible} flexGrow={1} flexDirection="column" minHeight={0}>
            <PanelBoundary name={view.title} log={app.log} logPath={logFilePath(app.dirs)}>
              <Component visible={visible} focused={visible && focused} />
            </PanelBoundary>
          </box>
        );
      })}
    </>
  );
}

export function Sidebar({
  visible,
  width,
  side,
  resizable,
}: {
  visible: boolean;
  width: number;
  side: "left" | "right";
  resizable: boolean;
}) {
  const app = useApp();
  const theme = useTheme();
  return (
    <ZoneBox
      zone="sidebar"
      visible={visible}
      width={width}
      backgroundColor={theme.shell.panel}
      edge={
        resizable ? (
          <ResizeHandle
            edge={side === "left" ? "right" : "left"}
            size={() => app.layout.effective.get().sidebar.width}
            onResize={(size) => app.layout.setSidebarWidth(size)}
            hint={{ text: "Drag to resize the sidebar", keys: app.keybindingFor("view.increaseViewSize") }}
          />
        ) : null
      }
    >
      <SidebarHeader />
      <SidebarViews />
    </ZoneBox>
  );
}
