/**
 * The workbench: command bar, the main row (activity bar, sidebar, editor column with the
 * bottom panel, auxiliary panel), status bar, and the overlay host. Structure comes from
 * color blocks: side regions on `bg.surface`, the editor canvas on `bg.base`, no lines.
 *
 * Every part stays mounted; hidden parts use `visible={false}`, so live terminals survive
 * panel toggles, zen mode, the narrow drawer and the "terminal too small" screen.
 */
import type { ReactNode } from "react";
import { useApp, useStore } from "@/app/react";
import { LAYOUT_LIMITS } from "@/app/workbench/layout-compute";
import { OverlayHost } from "../overlays/overlay-host";
import { attrs } from "../primitives/text";
import { LiveThemeProvider, useTheme } from "../theme/theme-context";
import { ActivityBar } from "./activity-bar";
import { CommandBar } from "./command-bar";
import { EditorArea } from "./editor-area";
import { AuxiliaryPanel, BottomPanel } from "./panels";
import { Sidebar } from "./sidebar";
import { StatusBar } from "./status-bar";

function TooSmall({ width, height }: { width: number; height: number }) {
  const theme = useTheme();
  const c = theme.colors;
  const { width: minWidth, height: minHeight } = LAYOUT_LIMITS.minViewport;
  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      zIndex={100}
      backgroundColor={c.bg.base}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
    >
      <text fg={c.fg.default} attributes={attrs({ bold: true })} selectable={false}>
        Terminal too small
      </text>
      <text fg={c.fg.muted} selectable={false} wrapMode="word" textAlign="center">
        {`Lucy needs ${minWidth} × ${minHeight}; this is ${width} × ${height}.`}
      </text>
    </box>
  );
}

function MainRow() {
  const app = useApp();
  const theme = useTheme();
  const layout = useStore(app.layout.effective);
  const left = layout.sidebarSide === "left";
  const drawer = layout.sidebar.drawer || layout.auxiliary.drawer;
  const activity = layout.activityBar.visible ? (
    <ActivityBar key="activity" side={layout.sidebarSide} />
  ) : null;
  const sidebar = (
    <Sidebar
      key="sidebar"
      visible={layout.sidebar.visible}
      width={layout.sidebar.width}
      side={layout.sidebarSide}
      resizable={!layout.sidebar.drawer}
    />
  );
  const editorColumn = (
    <box
      key="editor"
      visible={!drawer}
      flexGrow={1}
      flexShrink={1}
      minWidth={0}
      flexDirection="column"
      backgroundColor={theme.colors.bg.base}
    >
      <EditorArea visible={layout.editor.visible} />
      <BottomPanel
        visible={layout.bottom.visible}
        height={layout.bottom.height}
        maximized={layout.bottom.maximized}
      />
    </box>
  );
  const auxiliary = (
    <AuxiliaryPanel
      key="auxiliary"
      visible={layout.auxiliary.visible}
      width={layout.auxiliary.width}
      side={left ? "right" : "left"}
      resizable={!layout.auxiliary.drawer}
    />
  );
  const children: ReactNode[] = left
    ? [activity, sidebar, editorColumn, auxiliary]
    : [auxiliary, editorColumn, sidebar, activity];
  return (
    <box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="row">
      {children}
    </box>
  );
}

function WorkbenchFrame() {
  const app = useApp();
  const theme = useTheme();
  const layout = useStore(app.layout.effective);
  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.colors.bg.base}>
      <CommandBar visible={layout.commandBar} compact={layout.compactCommandBar} />
      <MainRow />
      <StatusBar visible={layout.statusBar} />
      <OverlayHost
        width={layout.width}
        height={layout.height}
        quickPickTop={layout.commandBar ? 1 : 0}
        toastBottom={layout.statusBar ? 2 : 1}
      />
      {layout.tooSmall ? <TooSmall width={layout.width} height={layout.height} /> : null}
    </box>
  );
}

/** The root element of the app, inside the app and theme providers. */
export function Workbench() {
  const app = useApp();
  return (
    <LiveThemeProvider source={app.themes.store}>
      <WorkbenchFrame />
    </LiveThemeProvider>
  );
}
