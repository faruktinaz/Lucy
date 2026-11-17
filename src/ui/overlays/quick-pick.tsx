/**
 * The quick pick overlay: one input, a fuzzy-highlighted result list with keybinding hints
 * on the right, and a footer with key hints. Keys are handled by `QuickPickService` (the
 * overlay layer of the key router); this component only renders its state.
 */
import { useApp, useStore } from "@/app/react";
import type { QuickPickItem } from "@/app/workbench/quick-pick";
import { displayWidth, sanitizeForDisplay, truncateEnd } from "@/core/text";
import { HighlightedText } from "../primitives/highlighted-text";
import { FileIcon, Icon } from "../primitives/icon";
import { formatKeys } from "../primitives/key-hint";
import { List, type ListRowState } from "../primitives/list";
import { Spinner } from "../primitives/spinner";
import { attrs } from "../primitives/text";
import { useDensity, useTheme } from "../theme/theme-context";
import { SIZE } from "../tokens/spacing";
import { OverlayFrame } from "./overlay-frame";

function QuickPickRow({
  item,
  state,
  showGroup,
}: {
  item: QuickPickItem;
  state: ListRowState;
  showGroup: boolean;
}) {
  const theme = useTheme();
  const c = theme.colors;
  const labelColor = item.disabled ? c.fg.disabled : state.active ? c.state.selectedFg : c.fg.default;
  const keys = item.keybinding ? formatKeys(item.keybinding) : "";
  const right = showGroup && item.group ? item.group : keys;
  const rightWidth = right ? displayWidth(right) + 2 : 0;
  const iconWidth = item.icon || item.fileIcon ? 2 : 0;
  const label = sanitizeForDisplay(item.label);
  const labelRoom = Math.max(4, state.width - rightWidth - iconWidth);
  const shownLabel = truncateEnd(label, labelRoom);
  const descriptionRoom = labelRoom - displayWidth(shownLabel) - 2;
  const description =
    item.description && descriptionRoom >= 6
      ? truncateEnd(sanitizeForDisplay(item.description), descriptionRoom)
      : "";
  return (
    <>
      <text flexGrow={1} flexShrink={1} selectable={false} wrapMode="none">
        {item.fileIcon ? (
          <FileIcon name={item.fileIcon} />
        ) : item.icon ? (
          <Icon name={item.icon} tone="subtle" />
        ) : null}
        <HighlightedText text={shownLabel} positions={item.highlights} color={labelColor} />
        {description ? (
          <>
            <span fg={c.fg.subtle}>{"  "}</span>
            <HighlightedText
              text={description}
              positions={item.descriptionHighlights}
              color={state.active ? c.fg.muted : c.fg.subtle}
            />
          </>
        ) : null}
        {item.current ? <span fg={c.fg.subtle}>{"  current"}</span> : null}
      </text>
      {right ? (
        <text
          flexShrink={0}
          selectable={false}
          fg={showGroup && item.group && !keys ? c.fg.subtle : c.fg.subtle}
          attributes={attrs({ italic: showGroup && !!item.group })}
        >
          {`  ${right}`}
        </text>
      ) : null}
    </>
  );
}

export function QuickPickOverlay({
  width: screenWidth,
  height: screenHeight,
  top,
}: {
  width: number;
  height: number;
  top: number;
}) {
  const app = useApp();
  const theme = useTheme();
  const density = useDensity();
  const state = useStore(app.quickPick.store);
  if (!state.open) return null;
  const c = theme.colors;
  const width = Math.min(SIZE.quickPickWidth, screenWidth - 4);
  const left = Math.floor((screenWidth - width) / 2);
  const maxRows = Math.max(3, Math.min(SIZE.quickPickMaxRows, screenHeight - top - 7));
  const rows = Math.max(1, Math.min(state.items.length, maxRows));
  const showFooter = screenHeight >= 20;
  const title = state.title ? ` ${state.title} ` : undefined;
  const items = state.items;
  return (
    <box position="absolute" left={left} top={top} zIndex={60}>
      <OverlayFrame width={width}>
        <box
          height={1}
          flexShrink={0}
          flexDirection="row"
          paddingX={1}
          marginTop={density.overlayPaddingY > 0 ? 0 : 0}
        >
          <text fg={c.accent.primary} selectable={false} flexShrink={0}>
            <Icon name="search" color={c.accent.primary} />
          </text>
          <input
            flexGrow={1}
            focused
            value={state.value}
            placeholder={state.placeholder}
            backgroundColor={c.bg.overlay}
            focusedBackgroundColor={c.bg.overlay}
            textColor={c.fg.default}
            focusedTextColor={c.fg.default}
            placeholderColor={c.fg.subtle}
            cursorColor={c.accent.primary}
            onInput={(value: string) => app.quickPick.setValue(value)}
          />
          <text flexShrink={0} selectable={false}>
            <Spinner active={state.loading} />
          </text>
          {title ? (
            <text flexShrink={0} fg={c.fg.subtle} selectable={false} wrapMode="none">
              {` ${title.trim()}`}
            </text>
          ) : null}
        </box>
        <text height={1} fg={c.border.subtle} selectable={false} flexShrink={0}>
          {"─".repeat(Math.max(0, width - 2))}
        </text>
        {items.length === 0 ? (
          <box height={1} paddingX={2} flexShrink={0}>
            <text fg={c.fg.muted} selectable={false}>
              {state.loading ? "" : state.emptyText}
            </text>
          </box>
        ) : (
          <box height={rows} flexShrink={0} flexDirection="column">
            <List
              items={items}
              selectedIndex={state.activeIndex}
              focused
              keyboard={false}
              onSelect={(index) => app.quickPick.setActiveIndex(index)}
              onActivate={(index) => void app.quickPick.accept(index)}
              activateOnClick
              renderRow={(item, rowState) => (
                <QuickPickRow
                  item={item}
                  state={rowState}
                  showGroup={
                    item.group !== undefined &&
                    (rowState.index === 0 || items[rowState.index - 1]?.group !== item.group)
                  }
                />
              )}
            />
          </box>
        )}
        {showFooter ? (
          <box
            height={1}
            flexShrink={0}
            paddingX={1}
            marginTop={density.sectionGap}
            backgroundColor={c.bg.overlay}
          >
            <text fg={c.fg.subtle} selectable={false}>
              <span fg={c.fg.muted}>↑↓</span>
              {" move   "}
              <span fg={c.fg.muted}>Enter</span>
              {state.mode === "pick" ? " choose   " : state.prefix === ">" ? " run   " : " open   "}
              <span fg={c.fg.muted}>Esc</span>
              {" close"}
              {state.mode === "provider" && state.prefix === "" ? (
                <>
                  {"   "}
                  <span fg={c.fg.muted}>{">"}</span>
                  {" commands   "}
                  <span fg={c.fg.muted}>:</span>
                  {" line"}
                </>
              ) : null}
            </text>
          </box>
        ) : null}
      </OverlayFrame>
    </box>
  );
}
