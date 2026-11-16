/**
 * The Explorer sidebar view: an optional filter field, then the virtualized tree.
 *
 * Rendering pulls only the visible window from `ExplorerViewModel` (`getRow` per slot); the
 * `List` gets an array of row indices, rebuilt only when the row count changes. All keys go
 * through the model's transitions (type-ahead needs every letter, so the list's own j/k
 * navigation is off). Clicks follow VS Code: a click previews a file or toggles a folder, a
 * double-click keeps the file open, a right click opens the context menu.
 */
import type { BoxRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useApp, useFocusTarget, useKeyHandler, useStore } from "@/app/react";
import type { MenuItem } from "@/app/workbench/menus";
import type { ViewComponent, ViewProps } from "@/app/workbench/views";
import { normalizeKey } from "@/core/keybindings";
import type { KeyStroke } from "@/core/keybindings/key-stroke";
import { menuWidth } from "@/ui/overlays/menu";
import { IconButton } from "@/ui/primitives/button";
import { formatKeys } from "@/ui/primitives/key-hint";
import { List } from "@/ui/primitives/list";
import { useMeasure } from "@/ui/primitives/measure";
import { Spinner, useDelayedFlag } from "@/ui/primitives/spinner";
import { EmptyState, ErrorState } from "@/ui/primitives/states";
import { Label } from "@/ui/primitives/text";
import { TextField, type TextFieldHandle } from "@/ui/primitives/text-field";
import { DOUBLE_CLICK_MS, usePointer } from "@/ui/primitives/use-pointer";
import { useDensity, useTheme } from "@/ui/theme/theme-context";
import type { ExplorerController } from "./explorer-controller";
import {
  EditRowContent,
  EntryRowContent,
  MessageRowContent,
  MoreRowContent,
  prefixWidth,
  wrapMessage,
} from "./explorer-row";

/** List items: a model row index (>= 0) or a validation-message line (`-1 - line`). */
type Item = number;

function typedCharacter(stroke: KeyStroke): string | null {
  if (stroke.ctrl || stroke.alt || stroke.super) return null;
  const text = stroke.text && [...stroke.text].length === 1 ? stroke.text : null;
  const key = [...stroke.key].length === 1 ? stroke.key : null;
  const char = text ?? key;
  return char && char !== " " && char >= " " ? char : null;
}

function FilterBar({
  controller,
  focused,
  focusRequest,
  onFocusChange,
}: {
  controller: ExplorerController;
  focused: boolean;
  focusRequest: number;
  onFocusChange: (focused: boolean) => void;
}) {
  const theme = useTheme();
  const density = useDensity();
  const filter = useStore(controller.model.store, (state) => state.filter);
  const field = useRef<TextFieldHandle>(null);
  useFocusTarget(field, focused);
  useEffect(() => {
    if (focusRequest > 0) {
      onFocusChange(true);
      field.current?.focus();
    }
  }, [focusRequest, onFocusChange]);
  const summary = filter.active ? filter.summary : "";
  return (
    <box
      height={1}
      flexShrink={0}
      flexDirection="row"
      paddingLeft={density.rowPaddingX}
      paddingRight={density.rowPaddingX}
      backgroundColor={theme.colors.bg.surface}
    >
      <box flexGrow={1} flexShrink={1} flexDirection="row">
        <TextField
          ref={field}
          icon="search"
          placeholder="Filter files"
          focused={focused}
          width="100%"
          invalid={filter.active && !filter.pending && filter.matchCount === 0}
          onInput={(value) => void controller.model.setFilter(value)}
        />
      </box>
      {summary ? (
        <text flexShrink={0} selectable={false} fg={theme.colors.fg.muted}>
          {` ${summary} `}
        </text>
      ) : null}
      <IconButton
        icon="close"
        hint={{ text: "Clear filter", keys: "escape" }}
        onPress={() => void controller.closeFilter()}
        surface={theme.colors.bg.surface}
      />
    </box>
  );
}

function ExplorerPanel({ controller, visible, focused }: ViewProps & { controller: ExplorerController }) {
  const app = useApp();
  const theme = useTheme();
  const density = useDensity();
  const renderer = useRenderer();
  const model = controller.model;
  const state = useStore(model.store);
  const ui = useStore(controller.ui);
  const { size, onSizeChange } = useMeasure();
  const root = useRef<BoxRenderable>(null);
  const selectedRow = useRef<BoxRenderable>(null);
  const editField = useRef<TextFieldHandle>(null);
  const lastClick = useRef({ index: -1, at: 0 });
  const [filterFocused, setFilterFocused] = useState(false);
  // While renaming or creating, focusing the explorer puts the cursor back in the input.
  useFocusTarget(editField, state.edit !== null);
  const loadingShown = useDelayedFlag(!ui.loaded || state.loading);

  // Start reading the folder once the first frame is on screen (never during startup).
  useEffect(() => {
    void app.lifecycle.firstPaint.then(() => controller.load());
  }, [app, controller]);

  useEffect(() => {
    if (!ui.filterOpen) setFilterFocused(false);
  }, [ui.filterOpen]);

  useEffect(() => {
    const keysFor = (item: MenuItem) => {
      if (item.kind === "separator") return "";
      if (item.keybinding) return formatKeys(item.keybinding);
      return item.command ? (app.keybindingLabel(item.command) ?? "") : "";
    };
    const registration = controller.attachView(
      {
        headerAnchor: () => {
          const box = root.current;
          return box ? { x: box.screenX + box.width - 1, y: box.screenY - 1 } : null;
        },
        selectionAnchor: () => {
          const box = selectedRow.current;
          return box ? { x: box.screenX + 2, y: box.screenY } : null;
        },
        copy: (text) => {
          try {
            return renderer.copyToClipboardOSC52(text);
          } catch {
            // The test renderer and some terminals throw instead of returning false.
            return false;
          }
        },
      },
      (items) => menuWidth(items, keysFor),
    );
    return () => registration.dispose();
  }, [app, controller, renderer]);

  // Validation message lines go right under the inline input.
  const edit = state.edit;
  const contentWidth = Math.max(0, size.width - density.rowPaddingX * 2);
  const editIndex = edit ? state.selectedIndex : -1;
  const editDepth = editIndex >= 0 ? (model.getRow(editIndex)?.depth ?? 0) : 0;
  const messageLines = useMemo(
    () =>
      edit?.message && editIndex >= 0
        ? wrapMessage(edit.message.text, contentWidth - prefixWidth(editDepth))
        : [],
    [edit?.message, editIndex, contentWidth, editDepth],
  );
  const items = useMemo(() => {
    const out: Item[] = new Array(state.rowCount + messageLines.length);
    let write = 0;
    for (let index = 0; index < state.rowCount; index++) {
      out[write++] = index;
      if (index === editIndex)
        for (let line = 0; line < messageLines.length; line++) out[write++] = -1 - line;
    }
    return out;
  }, [state.rowCount, editIndex, messageLines.length]);
  const toItem = (index: number) =>
    editIndex >= 0 && index > editIndex ? index + messageLines.length : index;
  const toRow = (item: number) =>
    item < 0 ? -1 : editIndex >= 0 && item > editIndex ? item - messageLines.length : item;

  const pageSize = Math.max(1, size.height);
  useKeyHandler(
    (stroke) => {
      if (stroke.ctrl || stroke.alt || stroke.super) return false;
      const key = normalizeKey(stroke.key) ?? stroke.key;
      switch (key) {
        case "up":
          model.moveUp();
          return true;
        case "down":
          model.moveDown();
          return true;
        case "pageup":
          model.pageUp(pageSize);
          return true;
        case "pagedown":
          model.pageDown(pageSize);
          return true;
        case "home":
          model.home();
          return true;
        case "end":
          model.end();
          return true;
        case "left":
          void model.left();
          return true;
        case "right":
          void model.right();
          return true;
        case "enter":
          void model.enter();
          return true;
        case "space":
          void model.space();
          return true;
        case "escape":
          if (!ui.filterOpen) return false;
          void controller.closeFilter();
          return true;
      }
      const char = typedCharacter(stroke);
      if (char === null) return false;
      model.typeAhead(char);
      return true;
    },
    { enabled: visible && !edit },
  );

  // Keys for the text inputs (inline edit, filter) that must work while they have focus.
  useKeyHandler(
    (stroke) => {
      const key = normalizeKey(stroke.key) ?? stroke.key;
      if (edit) {
        if (key !== "escape") return false;
        model.cancelEdit();
        return true;
      }
      if (!ui.filterOpen || !filterFocused) return false;
      if (key === "escape") {
        void controller.closeFilter();
        return true;
      }
      if (key === "down" || key === "enter" || key === "tab") {
        // Hand the keyboard to the matches.
        setFilterFocused(false);
        if (state.selectedIndex < 0 || key === "down") model.moveDown();
        return true;
      }
      return false;
    },
    { whileInputFocused: true, enabled: visible && (edit !== null || ui.filterOpen) },
  );

  const background = usePointer({
    onClick: () => {
      setFilterFocused(false);
      model.select(null);
    },
    onContextMenu: (event) => {
      model.select(null);
      controller.showContextMenu({ x: event.x, y: event.y });
    },
  });

  const onActivate = (item: number) => {
    const index = toRow(item);
    const row = index >= 0 ? model.getRow(index) : undefined;
    if (!row || row.type === "edit") return;
    const now = Date.now();
    const double = lastClick.current.index === index && now - lastClick.current.at <= DOUBLE_CLICK_MS;
    lastClick.current = double ? { index: -1, at: 0 } : { index, at: now };
    if (row.type === "entry" && row.kind === "file") {
      void model.activate(index, !double);
      return;
    }
    // The second click of a double-click on a folder would only fold it back up.
    if (!double) void model.activate(index, true);
  };

  let content: ReactNode;
  if (!ui.loaded || (state.loading && state.rowCount === 0)) {
    content = loadingShown ? (
      <box paddingX={density.rowPaddingX} paddingTop={density.emptyStateTop} flexShrink={0}>
        <Label variant="secondary">
          <Spinner delayMs={0} label="Reading the workspace" />
        </Label>
      </box>
    ) : null;
  } else if (state.rootError) {
    content = (
      <ErrorState
        title="Cannot read the workspace folder"
        message={state.rootError}
        actions={[{ label: "Retry", command: "explorer.refresh" }]}
      />
    );
  } else if (state.rowCount === 0 && state.filter.active && !state.filter.pending) {
    content = (
      <EmptyState
        title="No matching files"
        description={`Nothing matches “${state.filter.text}”.`}
        actions={[{ label: "Clear filter", onPress: () => void controller.closeFilter(), keys: "escape" }]}
      />
    );
  } else if (state.rowCount === 0 && !state.filter.active) {
    content = (
      <EmptyState
        title="This folder is empty"
        description="Create a file or a folder to get started."
        actions={[
          { label: "New File", command: "explorer.newFile" },
          { label: "New Folder", command: "explorer.newFolder" },
        ]}
      />
    );
  } else {
    content = (
      <List<Item>
        items={items}
        selectedIndex={state.selectedIndex >= 0 ? toItem(state.selectedIndex) : -1}
        focused={focused && !filterFocused}
        keyboard={false}
        activateOnClick
        surface={theme.colors.bg.surface}
        onSelect={(item) => {
          setFilterFocused(false);
          const index = toRow(item);
          if (index >= 0) model.selectIndex(index);
        }}
        onActivate={onActivate}
        onContextMenu={(item, event) => {
          if (toRow(item) >= 0) controller.showContextMenu({ x: event.x, y: event.y });
        }}
        renderRow={(item, listState) => {
          if (item < 0) {
            const line = -1 - item;
            const message = edit?.message;
            return message ? (
              <MessageRowContent
                message={message}
                line={messageLines[line] ?? ""}
                first={line === 0}
                depth={editDepth}
              />
            ) : null;
          }
          const row = model.getRow(item);
          const rowRef = listState.selected ? selectedRow : undefined;
          if (!row) return null;
          if (row.type === "entry") return <EntryRowContent row={row} state={listState} rowRef={rowRef} />;
          if (row.type === "more") return <MoreRowContent row={row} state={listState} rowRef={rowRef} />;
          return (
            <EditRowContent
              row={row}
              initialValue={row.value}
              fieldRef={editField}
              rowRef={rowRef}
              onInput={(value) => model.setEditValue(value)}
              onSubmit={() => void model.commitEdit()}
            />
          );
        }}
      />
    );
  }

  return (
    <box ref={root} flexGrow={1} flexShrink={1} minHeight={0} flexDirection="column">
      {ui.filterOpen ? (
        <FilterBar
          controller={controller}
          focused={visible && filterFocused}
          focusRequest={ui.filterFocusRequest}
          onFocusChange={setFilterFocused}
        />
      ) : null}
      <box
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        flexDirection="column"
        onSizeChange={onSizeChange}
        {...background.props}
      >
        {content}
      </box>
    </box>
  );
}

/** The registered view component, bound to the feature's controller. */
export function createExplorerView(controller: ExplorerController): ViewComponent<ViewProps> {
  // Called once per feature activation, so the component identity is stable for the app's
  // lifetime; the shell renders registered components without providers, hence the closure.
  // biome-ignore lint/correctness/noComponentHookFactories: one stable component per activation.
  return function ExplorerView(props: ViewProps) {
    return <ExplorerPanel controller={controller} {...props} />;
  };
}
