/**
 * The auxiliary panel (right side, where the AI feature lives) and the bottom panel (tabs:
 * terminal, ...). Both stay mounted while hidden (`visible={false}`), because a live
 * terminal inside them is destroyed on unmount (docs/dev/PTY_NOTES.md §5.1).
 */

import { logFilePath } from "@/app/log-file";
import { useApp, useStore, useZoneFocused } from "@/app/react";
import { IconButton } from "../primitives/button";
import { PanelHeader } from "../primitives/headers";
import { useMeasure } from "../primitives/measure";
import { PanelBoundary } from "../primitives/panel-boundary";
import { ResizeHandle, useDragResize } from "../primitives/resize-handle";
import { Tabs } from "../primitives/tabs";
import { useTheme } from "../theme/theme-context";
import { useViewActions } from "./view-actions";
import { ZoneBox } from "./zone";

function AuxiliaryContent() {
  const app = useApp();
  const focused = useZoneFocused();
  const views = useStore(app.views.store, (state) => state.auxiliary);
  const selected = useStore(app.layout.store, (state) => state.auxiliary.view);
  const panelVisible = useStore(app.layout.effective, (state) => state.auxiliary.visible);
  const shown = views.find((v) => v.id === selected) ?? views[0];
  const actions = useViewActions(shown?.actions);
  return (
    <>
      <PanelHeader
        title={shown?.title ?? "Panel"}
        focused={focused}
        actions={[
          ...actions,
          {
            icon: "close",
            hint: { text: "Hide panel", keys: app.keybindingFor("view.toggleAiPanel") },
            onPress: () => {
              app.layout.setAuxiliaryVisible(false);
              if (focused) app.focus.focus("editor");
            },
          },
        ]}
      />
      {views.map((view) => {
        const visible = view === shown;
        const Component = view.component;
        return (
          <box key={view.id} visible={visible} flexGrow={1} flexDirection="column" minHeight={0}>
            <PanelBoundary name={view.title} log={app.log} logPath={logFilePath(app.dirs)}>
              <Component visible={visible && panelVisible} focused={visible && focused} />
            </PanelBoundary>
          </box>
        );
      })}
    </>
  );
}

export function AuxiliaryPanel({
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
      zone="auxiliary"
      visible={visible}
      width={width}
      backgroundColor={theme.shell.panel}
      edge={
        resizable ? (
          <ResizeHandle
            edge={side === "right" ? "left" : "right"}
            size={() => app.layout.effective.get().auxiliary.width}
            onResize={(size) => app.layout.setAuxiliaryWidth(size)}
            hint={{ text: "Drag to resize the panel" }}
          />
        ) : null
      }
    >
      <AuxiliaryContent />
    </ZoneBox>
  );
}

function BottomHeader() {
  const app = useApp();
  const theme = useTheme();
  const focused = useZoneFocused();
  const tabs = useStore(app.views.store, (state) => state.bottom);
  const selected = useStore(app.layout.store, (state) => state.bottom.tab);
  const maximized = useStore(app.layout.effective, (state) => state.bottom.maximized);
  const { size, onSizeChange } = useMeasure();
  const shown = tabs.find((t) => t.id === selected) ?? tabs[0];
  const actions = useViewActions(shown?.actions);
  // The header row doubles as the drag handle: dragging it up grows the panel.
  const drag = useDragResize({
    axis: "y",
    sign: -1,
    size: () => app.layout.effective.get().bottom.height,
    onResize: (height) => app.layout.setBottomHeight(height),
  });
  const surface = drag.dragging ? theme.colors.state.hover : theme.shell.panel;
  return (
    <box
      height={1}
      flexShrink={0}
      flexDirection="row"
      backgroundColor={surface}
      {...(maximized ? {} : drag.props)}
    >
      <box flexGrow={1} onSizeChange={onSizeChange} minWidth={0}>
        <Tabs
          variant="panel"
          items={tabs.map((tab) => ({ id: tab.id, title: tab.title }))}
          activeId={shown?.id ?? null}
          width={size.width}
          surface={surface}
          focused={focused}
          onSelect={(id) => {
            app.layout.showBottomTab(id);
            app.focus.focus("bottom");
          }}
        />
      </box>
      {actions.map((action) => (
        <IconButton
          key={action.icon}
          icon={action.icon}
          hint={action.hint}
          onPress={action.onPress}
          surface={surface}
        />
      ))}
      <IconButton
        icon={maximized ? "restore" : "maximize"}
        hint={{
          text: maximized ? "Restore panel size" : "Maximize panel",
          keys: app.keybindingFor("view.toggleMaximizedPanel"),
        }}
        onPress={() => app.layout.toggleBottomMaximized()}
        surface={surface}
      />
      <IconButton
        icon="close"
        hint={{ text: "Hide panel", keys: app.keybindingFor("view.toggleBottomPanel") }}
        onPress={() => {
          app.layout.setBottomVisible(false);
          if (focused) app.focus.focus("editor");
        }}
        surface={surface}
      />
    </box>
  );
}

function BottomContent() {
  const app = useApp();
  const focused = useZoneFocused();
  const tabs = useStore(app.views.store, (state) => state.bottom);
  const selected = useStore(app.layout.store, (state) => state.bottom.tab);
  const panelVisible = useStore(app.layout.effective, (state) => state.bottom.visible);
  const shown = tabs.find((t) => t.id === selected) ?? tabs[0];
  return (
    <>
      {tabs.map((tab) => {
        const visible = tab === shown;
        const Component = tab.component;
        return (
          <box key={tab.id} visible={visible} flexGrow={1} flexDirection="column" minHeight={0}>
            <PanelBoundary name={tab.title} log={app.log} logPath={logFilePath(app.dirs)}>
              <Component visible={visible && panelVisible} focused={visible && focused} />
            </PanelBoundary>
          </box>
        );
      })}
    </>
  );
}

export function BottomPanel({
  visible,
  height,
  maximized,
}: {
  visible: boolean;
  height: number;
  maximized: boolean;
}) {
  const theme = useTheme();
  return (
    <ZoneBox
      zone="bottom"
      visible={visible}
      height={maximized ? undefined : height}
      flexGrow={maximized ? 1 : undefined}
      backgroundColor={theme.shell.panel}
    >
      <BottomHeader />
      <BottomContent />
    </ZoneBox>
  );
}
