/**
 * The component gallery: every design-system primitive in every state, rendered with the
 * live theme. Open it with "Developer: Show Component Gallery"; `bun run screenshots`
 * captures it for each theme. States that need a pointer (hover, pressed) are forced here.
 */
import type { ReactNode } from "react";
import type { MenuItem } from "@/app/workbench/menus";
import type { Notification } from "@/app/workbench/notifications";
import { type IconName, UI_ICONS } from "@/themes/icons";
import { MenuPanel, menuWidth } from "../overlays/menu";
import { ToastCard } from "../overlays/toasts";
import { Badge, CountLabel } from "../primitives/badge";
import { Button, IconButton } from "../primitives/button";
import { PanelHeader, SectionHeader } from "../primitives/headers";
import { HighlightedText } from "../primitives/highlighted-text";
import { FileIcon, Icon } from "../primitives/icon";
import { formatKeys, KeyHint } from "../primitives/key-hint";
import { List, RowFrame, rowBackground } from "../primitives/list";
import { Spinner } from "../primitives/spinner";
import { EmptyState, ErrorState } from "../primitives/states";
import { Tabs } from "../primitives/tabs";
import { Label, Span } from "../primitives/text";
import { TextField } from "../primitives/text-field";
import { TreeRowContent } from "../primitives/tree";
import { useTheme } from "../theme/theme-context";

const COLUMN = 56;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <box flexDirection="column" flexShrink={0} marginBottom={1}>
      <Label variant="section">{title}</Label>
      <box flexDirection="column" marginTop={0} flexShrink={0}>
        {children}
      </box>
    </box>
  );
}

function Row({ children, gap = 1 }: { children: ReactNode; gap?: number }) {
  return (
    <box flexDirection="row" gap={gap} flexShrink={0} height={1}>
      {children}
    </box>
  );
}

function Caption({ children, width = 10 }: { children: string; width?: number }) {
  return (
    <Label tone="subtle" width={width}>
      {children}
    </Label>
  );
}

function TextSamples() {
  return (
    <Section title="Text">
      <Label>
        <Span>Body text</Span>
        <Span tone="muted"> · secondary</Span>
        <Span tone="subtle"> · hint</Span>
        <Span tone="disabled"> · disabled</Span>
      </Label>
      <Label>
        <Span bold>Title</Span>
        <Span tone="muted"> · </Span>
        <Span italic tone="muted">
          preview italic
        </Span>
        <Span tone="muted"> · </Span>
        <HighlightedText text="fuzzy match" positions={[0, 1, 6, 7]} color={useTheme().colors.fg.default} />
      </Label>
      <Label>
        <Span tone="accent">accent</Span>
        <Span tone="success"> success</Span>
        <Span tone="warning"> warning</Span>
        <Span tone="error"> error</Span>
        <Span tone="info"> info</Span>
      </Label>
    </Section>
  );
}

function IconSamples() {
  const theme = useTheme();
  const names = Object.keys(UI_ICONS[theme.icons]) as IconName[];
  const rows: IconName[][] = [];
  for (let i = 0; i < names.length; i += 18) rows.push(names.slice(i, i + 18));
  const files = [
    "main.ts",
    "app.js",
    "package.json",
    "README.md",
    "tool.py",
    "main.go",
    "run.sh",
    "ci.yml",
    "Cargo.toml",
    "index.html",
    "site.css",
    "logo.png",
    "bun.lock",
    ".gitignore",
    "LICENSE",
  ];
  return (
    <Section title={`Icons · ${theme.icons}`}>
      {rows.map((row) => (
        <Label key={row[0]} tone="muted">
          {row.map((name) => (
            <Icon key={name} name={name} tone="muted" />
          ))}
        </Label>
      ))}
      <Label>
        {files.map((file) => (
          <FileIcon key={file} name={file} />
        ))}
        <FileIcon name="src" kind="directory" />
        <FileIcon name="src" kind="directory-open" />
      </Label>
    </Section>
  );
}

function ButtonSamples() {
  const states = [
    ["default", {}],
    ["hover", { hovered: true }],
    ["pressed", { pressed: true }],
    ["focused", { focused: true }],
    ["disabled", { disabled: true }],
  ] as const;
  return (
    <Section title="Buttons">
      <Row gap={0}>
        <Caption>{""}</Caption>
        {states.map(([name]) => (
          <Caption key={name} width={9}>
            {name}
          </Caption>
        ))}
      </Row>
      {(["primary", "ghost", "danger"] as const).map((variant) => (
        <box key={variant} flexDirection="column" flexShrink={0}>
          <Row gap={0}>
            <Caption>{variant}</Caption>
            {states.map(([name, state]) => (
              <box key={name} width={9} flexShrink={0}>
                <Button
                  label="Save"
                  variant={variant}
                  focused={name === "focused"}
                  disabled={name === "disabled"}
                  forceState={state}
                />
              </box>
            ))}
          </Row>
          <box height={1} />
        </box>
      ))}
      <Row gap={0}>
        <Caption>icon</Caption>
        <IconButton icon="refresh" />
        <IconButton icon="refresh" forceHover />
        <IconButton icon="layoutPanel" active />
        <IconButton icon="close" disabled />
        <Label tone="subtle">{"  default · hover · on · disabled"}</Label>
      </Row>
    </Section>
  );
}

function FieldSamples() {
  return (
    <Section title="Inputs">
      <box flexDirection="column" gap={1} flexShrink={0}>
        <TextField icon="search" placeholder="Search files (placeholder)" width={COLUMN - 2} />
        <TextField icon="search" value="workspace-ş-ğ-İ" width={COLUMN - 2} />
        <TextField icon="branch" value="feature/bad name" invalid width={COLUMN - 2} />
      </box>
    </Section>
  );
}

function MiscSamples() {
  return (
    <Section title="Badges, keys, progress">
      <Label>
        <Badge count={3} />
        <Span> </Span>
        <Badge count={1280} width={4} />
        <Span tone="subtle">{"   count "}</Span>
        <CountLabel count={12} />
        <Span tone="subtle">{"   keys "}</Span>
        <KeyHint keys="ctrl+p" />
        <Span tone="subtle">{" · "}</Span>
        <KeyHint keys="ctrl+k ctrl+t" />
      </Label>
      <Label>
        <Spinner delayMs={0} label="Indexing files" />
      </Label>
    </Section>
  );
}

const ROW_STATES = [
  { label: "default", selected: false, focused: true, hovered: false },
  { label: "hover", selected: false, focused: true, hovered: true },
  { label: "selected", selected: true, focused: true, hovered: false },
  { label: "selected, list unfocused", selected: true, focused: false, hovered: false },
] as const;

function RowSamples() {
  const theme = useTheme();
  const c = theme.colors;
  const git = c.git;
  const tree = [
    { depth: 0, dir: true, open: true, name: "src", status: "", color: undefined },
    { depth: 1, dir: true, open: true, name: "features", status: "", color: undefined },
    { depth: 2, dir: false, open: false, name: "çalışma-notları.md", status: "M", color: git.modified },
    { depth: 2, dir: false, open: false, name: "İçerik.ts", status: "U", color: git.untracked },
    {
      depth: 1,
      dir: false,
      open: false,
      name: "a-very-long-file-name-that-will-not-fit-here.ts",
      status: "A",
      color: git.added,
    },
    { depth: 0, dir: false, open: false, name: "removed.ts", status: "D", color: git.deleted },
  ];
  return (
    <Section title="List and tree rows">
      {ROW_STATES.map((state) => {
        const fill = rowBackground(theme, state);
        const active = state.selected && state.focused;
        return (
          <RowFrame
            key={state.label}
            fill={fill}
            marker={theme.highContrast && state.selected}
            focused={state.focused}
            surface={theme.shell.panel}
            width={COLUMN}
          >
            <TreeRowContent
              depth={0}
              icon={<FileIcon name="main.ts" color={active ? c.state.selectedFg : undefined} />}
              label="main.ts"
              description={state.label}
              status="M"
              statusColor={git.modified}
              state={{
                index: 0,
                selected: state.selected,
                active,
                hovered: state.hovered,
                width: COLUMN - 4,
              }}
            />
          </RowFrame>
        );
      })}
      <box height={1} />
      {tree.map((row) => (
        <RowFrame key={row.name} fill={undefined} surface={theme.shell.panel} width={COLUMN}>
          <TreeRowContent
            depth={row.depth}
            expandable={row.dir}
            expanded={row.open}
            icon={
              <FileIcon
                name={row.name}
                kind={row.dir ? (row.open ? "directory-open" : "directory") : "file"}
              />
            }
            label={row.name}
            status={row.status}
            statusColor={row.color}
            strikethrough={row.status === "D"}
            state={{ index: 0, selected: false, active: false, hovered: false, width: COLUMN - 4 }}
          />
        </RowFrame>
      ))}
    </Section>
  );
}

const LONG_LIST = Array.from({ length: 40 }, (_, i) => `item-${String(i + 1).padStart(2, "0")}.ts`);

function ScrollingList() {
  const theme = useTheme();
  return (
    <Section title="Virtual list with scrollbar">
      <box
        height={5}
        width={COLUMN}
        flexShrink={0}
        backgroundColor={theme.colors.bg.surface}
        flexDirection="column"
      >
        <List
          items={LONG_LIST}
          selectedIndex={2}
          focused
          keyboard={false}
          surface={theme.colors.bg.surface}
          renderRow={(item, state) => (
            <TreeRowContent depth={0} icon={<FileIcon name={item} />} label={item} state={state} />
          )}
        />
      </box>
    </Section>
  );
}

function HeaderSamples() {
  const theme = useTheme();
  const surface = theme.colors.bg.surface;
  const actions = [
    { icon: "refresh" as const, onPress: () => {} },
    { icon: "collapseAll" as const, onPress: () => {} },
  ];
  return (
    <Section title="Headers">
      <box width={COLUMN} flexDirection="column" flexShrink={0} backgroundColor={surface}>
        <PanelHeader title="Explorer" focused={false} actions={actions} />
        <PanelHeader title="Source Control (focused)" focused actions={actions} />
        <SectionHeader title="Staged changes" expanded count={3} surface={surface} />
        <SectionHeader
          title="Changes (hover)"
          expanded
          count={12}
          actions={actions}
          forceHover
          surface={surface}
        />
        <SectionHeader title="Untracked" expanded={false} count={2} surface={surface} />
      </box>
    </Section>
  );
}

function TabSamples() {
  const theme = useTheme();
  const _c = theme.colors;
  return (
    <Section title="Tabs">
      <Tabs
        width={COLUMN}
        surface={theme.shell.panel}
        activeId="b"
        focused
        items={[
          { id: "a", title: "README.md", icon: <FileIcon name="README.md" />, iconWidth: 2 },
          { id: "b", title: "main.ts", icon: <FileIcon name="main.ts" />, iconWidth: 2, dirty: true },
          { id: "c", title: "app.yaml", icon: <FileIcon name="app.yaml" />, iconWidth: 2, italic: true },
          { id: "d", title: "LICENSE", icon: <FileIcon name="LICENSE" />, iconWidth: 2 },
        ]}
      />
      <Label tone="subtle">{"  active · dirty dot · italic preview · overflow +N"}</Label>
      <Tabs
        variant="panel"
        width={COLUMN}
        surface={theme.shell.panel}
        activeId="t"
        items={[
          { id: "t", title: "Terminal" },
          { id: "o", title: "Output" },
          { id: "p", title: "Problems" },
        ]}
      />
    </Section>
  );
}

const MENU_ITEMS: readonly MenuItem[] = [
  { id: "open", label: "Open to the Side", icon: "layoutSidebarRight", keybinding: "ctrl+enter" },
  { id: "rename", label: "Rename…", keybinding: "f2" },
  { id: "copy", label: "Copy Path", keybinding: "ctrl+k p" },
  { id: "sep", kind: "separator" },
  { id: "disabled", label: "Reveal in Finder", disabled: true },
  { id: "delete", label: "Delete", danger: true, keybinding: "delete" },
];

const menuKeys = (item: MenuItem): string =>
  "keybinding" in item && item.keybinding ? formatKeys(item.keybinding) : "";

const TOASTS: readonly Notification[] = [
  { id: "i", severity: "info", title: "Indexing 1,284 files", createdAt: 0 },
  { id: "s", severity: "success", title: "Committed 3 files", message: "main ⇡1", createdAt: 0 },
  {
    id: "w",
    severity: "warning",
    title: "A setting was ignored",
    message: "ui.density must be comfortable or compact.",
    createdAt: 0,
  },
  {
    id: "e",
    severity: "error",
    title: "Push failed",
    message: "The remote rejected the update.",
    createdAt: 0,
    actions: [{ label: "Show log", run: () => {} }],
  },
];

function OverlaySamples() {
  return (
    <Section title="Menu and toasts">
      <box flexDirection="row" gap={2} flexShrink={0}>
        <MenuPanel
          items={MENU_ITEMS}
          activeIndex={1}
          width={menuWidth(MENU_ITEMS, menuKeys)}
          keysFor={menuKeys}
        />
        <box flexDirection="column" gap={1} flexShrink={0}>
          {TOASTS.slice(0, 2).map((toast) => (
            <ToastCard
              key={toast.id}
              notification={toast}
              width={COLUMN - menuWidth(MENU_ITEMS, menuKeys) - 2}
            />
          ))}
        </box>
      </box>
      <box flexDirection="column" gap={1} marginTop={1} flexShrink={0}>
        {TOASTS.slice(2).map((toast) => (
          <ToastCard
            key={toast.id}
            notification={toast}
            width={COLUMN}
            forceHover={toast.severity === "error"}
          />
        ))}
      </box>
    </Section>
  );
}

function StateSamples() {
  const theme = useTheme();
  return (
    <Section title="Empty and error states">
      <box
        flexDirection="row"
        gap={2}
        flexShrink={0}
        backgroundColor={theme.colors.bg.surface}
        width={COLUMN}
      >
        <box width={27} flexShrink={0} flexDirection="column">
          <EmptyState
            title="No changes"
            description="Your working tree is clean."
            actions={[{ label: "Commit history", keys: "ctrl+k h" }]}
          />
        </box>
        <box width={27} flexShrink={0} flexDirection="column">
          <ErrorState
            title="Git failed"
            message="git is not installed."
            actions={[{ label: "Retry", onPress: () => {} }]}
          />
        </box>
      </box>
    </Section>
  );
}

export function ComponentGallery() {
  const theme = useTheme();
  return (
    <box
      flexGrow={1}
      flexDirection="row"
      gap={3}
      paddingX={2}
      paddingY={1}
      backgroundColor={theme.colors.bg.base}
      overflow="hidden"
    >
      <box width={COLUMN} flexShrink={0} flexDirection="column">
        <TextSamples />
        <IconSamples />
        <MiscSamples />
        <ButtonSamples />
        <FieldSamples />
        <StateSamples />
      </box>
      <box width={COLUMN} flexShrink={0} flexDirection="column">
        <RowSamples />
        <ScrollingList />
        <HeaderSamples />
        <TabSamples />
        <OverlaySamples />
      </box>
    </box>
  );
}
