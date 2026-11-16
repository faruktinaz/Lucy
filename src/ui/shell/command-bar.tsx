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
import { usePointer } from "../primitives/use-pointer";
import { useTheme } from "../theme/theme-context";

const PILL_WIDTH = 46;
const TOGGLES_WIDTH = 10;

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
  return (
    <box
      width={width}
      height={1}
      flexShrink={0}
      paddingX={1}
      backgroundColor={pointer.hovered ? c.state.hover : c.bg.raised}
      {...pointer.props}
    >
      <text fg={pointer.hovered ? c.fg.muted : c.fg.subtle} selectable={false} wrapMode="none">
        {`${icon("search", theme.icons)} `}
        {shownLabel}
        {" ".repeat(gap)}
        {keys}
      </text>
    </box>
  );
}

function LayoutToggles() {
  const app = useApp();
  const theme = useTheme();
  const state = useStore(app.layout.store);
  const hasAuxiliary = useStore(app.views.hasAuxiliary);
  const side = useStore(app.layout.effective, (effective) => effective.sidebarSide);
  const surface = theme.colors.bg.surface;
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
    <box
      visible={visible}
      height={1}
      flexShrink={0}
      flexDirection="row"
      backgroundColor={c.bg.surface}
      onSizeChange={onSizeChange}
    >
      <box flexGrow={1} flexBasis={0} flexDirection="row" paddingLeft={1} minWidth={0}>
        <text fg={c.fg.default} selectable={false} wrapMode="none">
          {truncateEnd(name, compact ? Math.max(8, size.width - 16) : nameWidth)}
          {app.env.demo ? <span fg={c.fg.subtle}>{"  demo"}</span> : null}
        </text>
      </box>
      {compact ? null : <SearchPill width={pillWidth} />}
      <box flexGrow={1} flexBasis={0} flexDirection="row" justifyContent="flex-end" minWidth={0}>
        {compact ? (
          <IconButton
            icon="search"
            surface={c.bg.surface}
            hint={{ text: "Search files and commands", keys: app.keybindingFor("file.quickOpen") }}
            onPress={() => app.quickPick.show("")}
          />
        ) : null}
        <LayoutToggles />
      </box>
    </box>
  );
}
