/**
 * The command bar: workspace name on the left, a quiet centered "search files and commands"
 * pill that opens Quick Open (with its keybinding), and the layout toggles on the right.
 * Below 80 columns the pill collapses to an icon.
 */
import { useApp, useStore } from "@/app/react";
import { displayWidth, sanitizeForDisplay, truncateEnd } from "@/core/text";
import { icon } from "@/themes/icons";
import { IconButton } from "../primitives/button";
import { formatKeys } from "../primitives/key-hint";
import { useMeasure } from "../primitives/measure";
import { CapCell } from "../primitives/shape";
import { attrs } from "../primitives/text";
import { usePointer } from "../primitives/use-pointer";
import { useTheme } from "../theme/theme-context";

const PILL_WIDTH = 46;
const TOGGLES_WIDTH = 17;

function SearchPill({ width }: { width: number }) {
  const app = useApp();
  const theme = useTheme();
  const c = theme.colors;
  const sequence = app.keybindingFor("file.quickOpen");
  const keys = sequence ? formatKeys(sequence) : "";
  const pointer = usePointer({
    onClick: () => app.quickPick.show(""),
    hint: { text: "Go to a file, or type > for commands", keys: sequence },
  });
  const label = "Search files and commands";
  const inner = width - 2;
  const shownLabel = truncateEnd(label, Math.max(4, inner - 2 - displayWidth(keys) - 2));
  const gap = Math.max(1, inner - 2 - displayWidth(shownLabel) - displayWidth(keys));
  const fill = pointer.hovered ? c.state.hover : c.bg.raised;
  return (
    <box width={width} height={1} flexShrink={0} flexDirection="row" {...pointer.props}>
      <CapCell side="left" color={fill} />
      <box flexGrow={1} height={1} backgroundColor={fill}>
        <text fg={pointer.hovered ? c.fg.muted : c.fg.subtle} selectable={false} wrapMode="none">
          {`${icon("search", theme.icons)} `}
          {shownLabel}
          {" ".repeat(gap)}
          {keys}
        </text>
      </box>
      <CapCell side="right" color={fill} />
    </box>
  );
}

/** Settings and Integrations live here now that there is no activity bar. */
function UtilityButtons() {
  const app = useApp();
  const theme = useTheme();
  const surface = theme.shell.canvas;
  const integrations = useStore(app.views.store, (state) =>
    state.sidebar.find((view) => view.id === "integrations"),
  );
  return (
    <box flexDirection="row" flexShrink={0} marginLeft={1}>
      {integrations ? (
        <IconButton
          icon={integrations.icon}
          surface={surface}
          hint={{
            text: integrations.title,
            keys: integrations.command ? app.keybindingFor(integrations.command) : undefined,
          }}
          onPress={() => {
            app.layout.showSidebarView(integrations.id);
            app.focus.focus("sidebar");
          }}
        />
      ) : null}
      {app.commands.has("settings.open") ? (
        <IconButton
          icon="settings"
          surface={surface}
          hint={{ text: "Settings", keys: app.keybindingFor("settings.open") }}
          onPress={() => void app.run("settings.open")}
        />
      ) : null}
    </box>
  );
}

function LayoutToggles() {
  const app = useApp();
  const theme = useTheme();
  const state = useStore(app.layout.store);
  const hasAuxiliary = useStore(app.views.hasAuxiliary);
  const side = useStore(app.layout.effective, (effective) => effective.sidebarSide);
  const surface = theme.shell.canvas;
  const sidebarIcon = side === "left" ? "layoutSidebarLeft" : "layoutSidebarRight";
  const auxiliaryIcon = side === "left" ? "layoutSidebarRight" : "layoutSidebarLeft";
  return (
    <box flexDirection="row" flexShrink={0}>
      <IconButton
        icon={sidebarIcon}
        active={state.sidebar.visible}
        surface={surface}
        hint={{
          text: state.sidebar.visible ? "Hide sidebar" : "Show sidebar",
          keys: app.keybindingFor("view.toggleSidebar"),
        }}
        onPress={() => void app.run("view.toggleSidebar")}
      />
      <IconButton
        icon="layoutPanel"
        active={state.bottom.visible}
        surface={surface}
        hint={{
          text: state.bottom.visible ? "Hide panel" : "Show panel",
          keys: app.keybindingFor("view.toggleBottomPanel"),
        }}
        onPress={() => void app.run("view.toggleBottomPanel")}
      />
      {hasAuxiliary ? (
        <IconButton
          icon={auxiliaryIcon}
          active={state.auxiliary.visible}
          surface={surface}
          hint={{
            text: state.auxiliary.visible ? "Hide AI panel" : "Show AI panel",
            keys: app.keybindingFor("view.toggleAiPanel"),
          }}
          onPress={() => void app.run("view.toggleAiPanel")}
        />
      ) : null}
    </box>
  );
}

export function CommandBar({ visible, compact }: { visible: boolean; compact: boolean }) {
  const app = useApp();
  const theme = useTheme();
  const c = theme.colors;
  const { size, onSizeChange } = useMeasure();
  const name = sanitizeForDisplay(app.workspace.name);
  const nameWidth = Math.max(8, Math.floor((size.width - PILL_WIDTH) / 2) - 3);
  const pillWidth = Math.max(20, Math.min(PILL_WIDTH, size.width - 2 * (TOGGLES_WIDTH + 2)));
  return (
    <box visible={visible} height={1} flexShrink={0} flexDirection="row" onSizeChange={onSizeChange}>
      <box flexGrow={1} flexBasis={0} flexDirection="row" paddingLeft={2} minWidth={0}>
        <text fg={c.fg.default} selectable={false} wrapMode="none" attributes={attrs({ bold: true })}>
          {truncateEnd(name, compact ? Math.max(8, size.width - 16) : nameWidth)}
          {app.env.demo ? <span fg={c.fg.subtle}>{"  demo"}</span> : null}
        </text>
      </box>
      {compact ? null : <SearchPill width={pillWidth} />}
      <box flexGrow={1} flexBasis={0} flexDirection="row" justifyContent="flex-end" minWidth={0}>
        {compact ? (
          <IconButton
            icon="search"
            surface={theme.shell.canvas}
            hint={{ text: "Search files and commands", keys: app.keybindingFor("file.quickOpen") }}
            onPress={() => app.quickPick.show("")}
          />
        ) : null}
        <LayoutToggles />
        <UtilityButtons />
        <box width={1} flexShrink={0} />
      </box>
    </box>
  );
}
