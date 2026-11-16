/**
 * The sidebar: a header with the view's title and actions, then the view. Every registered
 * view stays mounted (hidden ones with `visible={false}`) so switching views keeps their
 * scroll position and in-progress state.
 */

import { logFilePath } from "@/app/log-file";
import { useApp, useStore, useZoneFocused } from "@/app/react";
import { PanelHeader } from "../primitives/headers";
import { PanelBoundary } from "../primitives/panel-boundary";
import { ResizeHandle } from "../primitives/resize-handle";
import { EmptyState } from "../primitives/states";
import { useTheme } from "../theme/theme-context";
import { useViewActions } from "./view-actions";
import { ZoneBox } from "./zone";

function SidebarHeader() {
  const app = useApp();
  const focused = useZoneFocused();
  const views = useStore(app.views.store, (state) => state.sidebar);
  const active = useStore(app.layout.store, (state) => state.sidebar.view);
  const view = views.find((v) => v.id === active) ?? views[0];
  const actions = useViewActions(view?.actions);
  const drawer = useStore(app.layout.effective, (state) => state.sidebar.drawer);
  return (
    <PanelHeader
      title={view?.title ?? "Sidebar"}
      focused={focused}
      actions={actions}
      detail={drawer ? "Esc returns to the editor" : undefined}
    />
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
    <ZoneBox zone="sidebar" visible={visible} width={width} backgroundColor={theme.colors.bg.surface}>
      <SidebarHeader />
      <SidebarViews />
      {resizable ? (
        <ResizeHandle
          edge={side === "left" ? "right" : "left"}
          size={() => app.layout.effective.get().sidebar.width}
          onResize={(size) => app.layout.setSidebarWidth(size)}
          hint={{ text: "Drag to resize the sidebar", keys: app.keybindingFor("view.increaseViewSize") }}
        />
      ) : null}
    </ZoneBox>
  );
}
