/**
 * The Integrations sidebar view: an honest overview of what Lucy works with on this machine.
 * External tools (found or not, version, what Lucy uses each for, a one-line hint when
 * missing; Lucy installs nothing), the terminal's capabilities and the built-in modules. It
 * says plainly that there is no plugin system yet.
 *
 * Keyboard: Up/Down move through the tools (the selected one shows its details), Enter
 * checks again. The header's refresh button does the same.
 */
import { type ReactNode, useEffect, useState } from "react";
import { useKeyHandler, useStore } from "@/app/react";
import type { ViewProps } from "@/app/workbench/views";
import { normalizeKey } from "@/core/keybindings";
import { tildify } from "@/core/paths";
import { sanitizeForDisplay, truncateEnd, truncateMiddle } from "@/core/text";
import { icon } from "@/themes/icons";
import { useMeasure } from "@/ui/primitives/measure";
import { Spinner } from "@/ui/primitives/spinner";
import { attrs } from "@/ui/primitives/text";
import { usePointer } from "@/ui/primitives/use-pointer";
import { useDensity, useTheme } from "@/ui/theme/theme-context";
import type { ToolRow } from "../model/integrations-model";
import { useRendererBridge, useSettingsServices } from "./shared";
import { wrapText } from "./text-layout";

const INTRO = "Lucy has no plugin system yet. This is what it works with on this machine.";

function ToolLine({
  tool,
  selected,
  focused,
  width,
  onPress,
}: {
  tool: ToolRow;
  selected: boolean;
  focused: boolean;
  width: number;
  onPress: () => void;
}) {
  const theme = useTheme();
  const c = theme.colors;
  const pointer = usePointer({ onClick: onPress });
  const active = selected && focused;
  const bg = selected
    ? focused
      ? c.state.selectedBg
      : c.state.selectedInactiveBg
    : pointer.hovered
      ? c.state.hover
      : undefined;
  const found = tool.status === "found";
  const statusIcon =
    tool.status === "checking"
      ? null
      : found
        ? "check"
        : tool.status === "error" || tool.required
          ? "warning"
          : "close";
  const statusColor =
    tool.status === "checking"
      ? c.fg.subtle
      : found
        ? c.status.success
        : tool.required || tool.status === "error"
          ? c.status.warning
          : c.fg.subtle;
  const right =
    tool.status === "missing"
      ? "not found"
      : tool.status === "error"
        ? "check failed"
        : tool.versionStatus === "ok" && tool.version
          ? tool.version
          : tool.versionStatus === "timeout"
            ? "no answer"
            : tool.versionStatus === "pending"
              ? ""
              : tool.versionStatus === "cancelled"
                ? "stopped"
                : "found";
  const nameWidth = Math.max(6, width - right.length - 4);
  return (
    <box height={1} flexShrink={0} flexDirection="row" backgroundColor={bg} paddingX={1} {...pointer.props}>
      <text width={2} flexShrink={0} selectable={false} fg={active ? c.state.selectedFg : statusColor}>
        {statusIcon ? `${icon(statusIcon, theme.icons)} ` : <Spinner active />}
      </text>
      <text
        flexGrow={1}
        flexShrink={1}
        selectable={false}
        wrapMode="none"
        fg={active ? c.state.selectedFg : found ? c.fg.default : c.fg.muted}
      >
        {truncateEnd(tool.title, nameWidth)}
      </text>
      <text flexShrink={0} selectable={false} wrapMode="none" fg={active ? c.fg.default : c.fg.subtle}>
        {right}
      </text>
    </box>
  );
}

function ToolDetails({ tool, width }: { tool: ToolRow; width: number }) {
  const theme = useTheme();
  const c = theme.colors;
  const lines = wrapText(tool.purpose, width, 3);
  const extra: { text: string; tone: "subtle" | "warning" }[] = [];
  if (tool.path) extra.push({ text: truncateMiddle(tildify(tool.path), width), tone: "subtle" });
  if (tool.note) {
    for (const line of wrapText(tool.note, width, 3))
      extra.push({ text: line, tone: tool.status === "missing" && !tool.required ? "subtle" : "warning" });
  }
  if (tool.required && tool.status === "missing")
    extra.unshift({ text: "Required for Source Control.", tone: "warning" });
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={4} paddingRight={1}>
      {lines.map((line) => (
        <text key={line} selectable={false} wrapMode="none" fg={c.fg.muted}>
          {line}
        </text>
      ))}
      {extra.map((line) => (
        <text
          key={line.text}
          selectable={false}
          wrapMode="none"
          fg={line.tone === "warning" ? c.status.warning : c.fg.subtle}
        >
          {line.text}
        </text>
      ))}
    </box>
  );
}

function SectionTitle({ title, detail }: { title: string; detail?: string }) {
  const theme = useTheme();
  const c = theme.colors;
  return (
    <box height={1} flexShrink={0} paddingX={1}>
      <text selectable={false} wrapMode="none" fg={c.fg.muted} attributes={attrs({ bold: true })}>
        {title.toUpperCase()}
        {detail ? <span fg={c.fg.subtle} attributes={0}>{`  ${detail}`}</span> : null}
      </text>
    </box>
  );
}

export function IntegrationsView({ visible, focused }: ViewProps) {
  const services = useSettingsServices();
  useRendererBridge(services);
  const model = services.integrations();
  const state = useStore(model.store);
  const theme = useTheme();
  const density = useDensity();
  const c = theme.colors;
  const { size, onSizeChange } = useMeasure();
  const [selected, setSelected] = useState(0);
  const [top, setTop] = useState(0);

  // Checking starts the first time the view is shown, never at startup.
  useEffect(() => {
    if (visible && state.checkedAt === null && !state.loading) {
      model.setTerminal(services.terminalCapabilities());
      void model.refresh();
    }
  }, [visible, state.checkedAt, state.loading, model, services]);

  useKeyHandler(
    (stroke) => {
      if (stroke.ctrl || stroke.alt || stroke.super) return false;
      const key = normalizeKey(stroke.key) ?? stroke.key;
      if (key === "down" || key === "j") setSelected((i) => Math.min(state.tools.length - 1, i + 1));
      else if (key === "up" || key === "k") setSelected((i) => Math.max(0, i - 1));
      else if (key === "home") setSelected(0);
      else if (key === "end") setSelected(state.tools.length - 1);
      else if (key === "enter") void model.refresh({ force: true });
      else return false;
      return true;
    },
    { enabled: focused && visible },
  );

  const width = Math.max(10, size.width - 2);
  const found = state.tools.filter((t) => t.status === "found").length;
  const toolsDetail = state.loading ? "checking" : `${found} of ${state.tools.length} found`;
  const intro = wrapText(INTRO, width);
  const gap = density.sectionGap;

  // One flat list of lines, so the view scrolls by rows and keeps the selection visible.
  const lines: { key: string; node: ReactNode; tool?: number }[] = [];
  const push = (key: string, node: ReactNode, tool?: number) => lines.push({ key, node, tool });
  for (const line of intro) {
    push(
      `intro-${line}`,
      <box height={1} flexShrink={0} paddingX={1}>
        <text selectable={false} wrapMode="none" fg={c.fg.muted}>
          {line}
        </text>
      </box>,
    );
  }
  for (let i = 0; i < gap; i++) push(`gap-a-${i}`, <box height={1} flexShrink={0} />);
  push("tools", <SectionTitle title="Tools" detail={toolsDetail} />);
  state.tools.forEach((tool, index) => {
    push(
      `tool-${tool.id}`,
      <ToolLine
        tool={tool}
        selected={index === selected}
        focused={focused}
        width={width}
        onPress={() => setSelected(index)}
      />,
      index,
    );
    if (index === selected) {
      push(`details-${tool.id}`, <ToolDetails tool={tool} width={Math.max(8, width - 4)} />, index);
    }
  });
  for (let i = 0; i < gap; i++) push(`gap-b-${i}`, <box height={1} flexShrink={0} />);
  push(
    "terminal",
    <SectionTitle
      title="Terminal"
      detail={truncateEnd(sanitizeForDisplay(state.terminalName), Math.max(4, width - 12))}
    />,
  );
  for (const capability of state.capabilities) {
    push(
      `cap-${capability.id}`,
      <box height={1} flexShrink={0} paddingX={1} flexDirection="row">
        <text
          width={2}
          flexShrink={0}
          selectable={false}
          fg={capability.supported ? c.status.success : c.fg.subtle}
        >
          {`${icon(capability.supported ? "check" : "close", theme.icons)} `}
        </text>
        <text selectable={false} wrapMode="none" fg={capability.supported ? c.fg.default : c.fg.muted}>
          {truncateEnd(capability.title, width - 2)}
        </text>
      </box>,
    );
  }
  const kitty = state.capabilities.find((cap) => cap.id === "kittyKeyboard");
  if (kitty && !kitty.supported) {
    for (const line of wrapText(kitty.note, width - 2, 2)) {
      push(
        `kitty-${line}`,
        <box height={1} flexShrink={0} paddingLeft={3}>
          <text selectable={false} wrapMode="none" fg={c.fg.subtle}>
            {line}
          </text>
        </box>,
      );
    }
  }
  for (let i = 0; i < gap; i++) push(`gap-c-${i}`, <box height={1} flexShrink={0} />);
  push("modules", <SectionTitle title="Built in" detail={`${state.features.length}`} />);
  for (const feature of state.features) {
    push(
      `module-${feature.id}`,
      <box height={1} flexShrink={0} paddingX={1}>
        <text selectable={false} wrapMode="none" fg={c.fg.muted}>
          <span fg={c.fg.subtle}>{`${icon("check", theme.icons)} `}</span>
          {truncateEnd(feature.title, width - 2)}
        </text>
      </box>,
    );
  }

  // Keep the selected tool and its details on screen.
  const height = Math.max(1, size.height);
  const firstSelected = lines.findIndex((line) => line.tool === selected);
  let lastSelected = firstSelected;
  while (lines[lastSelected + 1]?.tool === selected) lastSelected++;
  let start = Math.max(0, Math.min(top, Math.max(0, lines.length - height)));
  // Before the first layout there is no height; revealing then would scroll the intro away.
  if (size.height > 0) {
    if (firstSelected >= 0 && firstSelected < start) start = firstSelected;
    if (lastSelected >= start + height) start = lastSelected - height + 1;
  }
  useEffect(() => {
    if (start !== top) setTop(start);
  });

  return (
    <box
      flexGrow={1}
      flexDirection="column"
      minHeight={0}
      overflow="hidden"
      onSizeChange={onSizeChange}
      paddingTop={gap}
      onMouseScroll={(event) => {
        const direction = event.scroll?.direction;
        if (direction === "down") setTop(Math.min(Math.max(0, lines.length - height), start + 2));
        if (direction === "up") setTop(Math.max(0, start - 2));
      }}
    >
      {lines.slice(start, start + height).map((line) => (
        <box key={line.key} flexShrink={0} flexDirection="column">
          {line.node}
        </box>
      ))}
    </box>
  );
}
