/**
 * The editor area: tab strip, breadcrumb, and the active tab's editor view from the
 * registry; the Welcome view when nothing is open.
 */

import { logFilePath } from "@/app/log-file";
import { useApp, useStore, useZoneFocused } from "@/app/react";
import type { EditorTab } from "@/app/workbench/editors";
import type { ViewAction } from "@/app/workbench/views";
import { displayWidth, sanitizeForDisplay, truncateStart } from "@/core/text";
import { icon } from "@/themes/icons";
import { FileIcon, Icon } from "../primitives/icon";
import { useMeasure } from "../primitives/measure";
import { PanelBoundary } from "../primitives/panel-boundary";
import { EmptyState } from "../primitives/states";
import { type TabItem, Tabs } from "../primitives/tabs";
import { attrs } from "../primitives/text";
import { usePointer } from "../primitives/use-pointer";
import { useTheme } from "../theme/theme-context";
import { Welcome } from "./welcome";
import { ZoneBox } from "./zone";

function parentName(path: string): string {
  const parts = path.split("/");
  return parts.length > 1 ? (parts[parts.length - 2] ?? "") : "";
}

function TabStrip({ tabs, activeId }: { tabs: readonly EditorTab[]; activeId: string | null }) {
  const app = useApp();
  const theme = useTheme();
  const focused = useZoneFocused();
  const views = useStore(app.views.store, (state) => state.editors);
  const { size, onSizeChange } = useMeasure();
  const titles = new Map<string, number>();
  for (const tab of tabs) titles.set(tab.title, (titles.get(tab.title) ?? 0) + 1);
  const items: TabItem[] = tabs.map((tab) => {
    const isFile = (tab.kind === "file" || tab.kind === "diff") && tab.resource;
    const providerIcon = views[tab.kind]?.icon;
    return {
      id: tab.id,
      title: tab.kind === "diff" ? `${tab.title}${tab.params.staged ? " (staged)" : ""}` : tab.title,
      icon: isFile ? (
        <FileIcon name={tab.resource ?? tab.title} />
      ) : providerIcon ? (
        <Icon name={providerIcon} />
      ) : null,
      iconWidth: isFile || providerIcon ? 2 : 0,
      italic: tab.preview,
      dirty: tab.dirty,
      description:
        tab.description ??
        ((titles.get(tab.title) ?? 0) > 1 && tab.resource
          ? parentName(tab.resource) || undefined
          : undefined),
    };
  });
  return (
    <box height={1} flexShrink={0} backgroundColor={theme.colors.bg.surface} onSizeChange={onSizeChange}>
      <Tabs
        items={items}
        activeId={activeId}
        width={size.width}
        surface={theme.colors.bg.surface}
        focused={focused}
        onSelect={(id) => app.editors.activate(id)}
        onClose={(id) => app.editors.close(id)}
        onDoubleClick={(id) => app.editors.keep(id)}
        onContextMenu={(id, event) => {
          const tab = app.editors.get(id);
          app.menus.show({
            x: event.x,
            y: event.y,
            items: [
              {
                id: "close",
                label: "Close",
                run: () => void app.editors.close(id),
                keybinding: app.keybindingFor("editor.closeTab"),
              },
              {
                id: "others",
                label: "Close Others",
                run: () => app.editors.closeOthers(id),
                disabled: tabs.length < 2,
              },
              { id: "all", label: "Close All", run: () => app.editors.closeAll() },
              { id: "sep", kind: "separator" },
              { id: "keep", label: "Keep Open", run: () => app.editors.keep(id), disabled: !tab?.preview },
            ],
          });
        }}
        onOverflow={(hidden) => {
          void app.quickPick
            .pick({
              title: "Open Editors",
              placeholder: "Go to an open editor",
              items: hidden.map((item) => ({
                id: item.id,
                label: item.title,
                description: item.description,
              })),
            })
            .then((item) => {
              if (item) app.editors.activate(item.id);
            });
        }}
      />
    </box>
  );
}

/** A quiet text action in the breadcrumb row (editor views contribute them). */
function BreadcrumbAction({ action }: { action: ViewAction }) {
  const app = useApp();
  const theme = useTheme();
  const c = theme.colors;
  const pointer = usePointer({
    onClick: () => void app.run(action.command, action.args),
    hint: {
      text: action.title ?? app.commands.get(action.command)?.title ?? action.command,
      keys: app.keybindingFor(action.command),
    },
  });
  const fg = pointer.hovered || action.active ? c.fg.default : c.fg.subtle;
  const bg = pointer.pressed ? c.state.active : pointer.hovered ? c.state.hover : undefined;
  return (
    <box height={1} flexShrink={0} paddingX={1} backgroundColor={bg} {...pointer.props}>
      <text
        fg={fg}
        selectable={false}
        wrapMode="none"
        attributes={attrs({ bold: action.active === true && theme.highContrast })}
      >
        {action.label ? action.label : <Icon name={action.icon} color={fg} space={false} />}
      </text>
    </box>
  );
}

/** Width of a breadcrumb action: its label or one icon cell, plus one cell of padding each side. */
function actionWidth(action: ViewAction): number {
  return (action.label ? displayWidth(action.label) : 1) + 2;
}

function Breadcrumb({ tab }: { tab: EditorTab }) {
  const app = useApp();
  const theme = useTheme();
  const c = theme.colors;
  const { size, onSizeChange } = useMeasure();
  const provider = app.views.editorView(tab.kind);
  const segments = provider?.breadcrumb?.(tab) ?? (tab.resource ? tab.resource.split("/") : [tab.title]);
  const actions = provider?.actions?.(tab) ?? [];
  const actionsWidth = actions.reduce((sum, action) => sum + actionWidth(action), 0);
  const separator = ` ${icon("chevronRight", theme.icons)} `;
  const text = truncateStart(
    segments.map((s) => sanitizeForDisplay(s)).join(separator),
    Math.max(8, size.width - 4 - actionsWidth),
  );
  const last = segments.at(-1) ?? "";
  const lastIndex = text.lastIndexOf(sanitizeForDisplay(last));
  const head = lastIndex > 0 ? text.slice(0, lastIndex) : "";
  const tail = lastIndex > 0 ? text.slice(lastIndex) : text;
  return (
    <box
      height={1}
      flexShrink={0}
      flexDirection="row"
      paddingLeft={2}
      paddingRight={1}
      backgroundColor={c.bg.base}
      onSizeChange={onSizeChange}
    >
      <text flexGrow={1} flexShrink={1} fg={c.fg.subtle} selectable={false} wrapMode="none">
        {head}
        <span fg={c.fg.muted}>{tail}</span>
      </text>
      {actions.map((action) => (
        <BreadcrumbAction key={action.command} action={action} />
      ))}
    </box>
  );
}

function EditorContent({ tab }: { tab: EditorTab }) {
  const app = useApp();
  const focused = useZoneFocused();
  const provider = useStore(app.views.store, (state) => state.editors[tab.kind]);
  if (!provider) {
    return (
      <EmptyState
        title="This tab cannot be shown"
        description={`No editor is registered for "${tab.kind}" tabs yet.`}
        actions={[{ label: "Close tab", command: "editor.closeTab" }]}
      />
    );
  }
  const Component = provider.component;
  return (
    <PanelBoundary key={tab.id} name={tab.title} log={app.log} logPath={logFilePath(app.dirs)}>
      <Component tab={tab} focused={focused} />
    </PanelBoundary>
  );
}

export function EditorArea({ visible }: { visible: boolean }) {
  const app = useApp();
  const theme = useTheme();
  const { tabs, activeId } = useStore(app.editors.store);
  const { size, onSizeChange } = useMeasure();
  const active = tabs.find((tab) => tab.id === activeId);
  return (
    <ZoneBox zone="editor" visible={visible} flexGrow={1} backgroundColor={theme.colors.bg.base}>
      <box flexGrow={1} flexDirection="column" minHeight={0} onSizeChange={onSizeChange}>
        {active ? (
          <>
            <TabStrip tabs={tabs} activeId={activeId} />
            <Breadcrumb tab={active} />
            <box flexGrow={1} flexDirection="column" minHeight={0} backgroundColor={theme.colors.bg.base}>
              <EditorContent tab={active} />
            </box>
          </>
        ) : (
          <Welcome width={size.width} height={size.height} />
        )}
      </box>
    </ZoneBox>
  );
}
