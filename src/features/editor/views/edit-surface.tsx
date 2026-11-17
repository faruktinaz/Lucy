/**
 * The editing surface: mounts the session's live `<line-number>` + textarea (owned by the
 * `EditSession`, re-parented here), and adds what the textarea does not do itself: Tab and
 * Shift+Tab indentation in the file's own style, Enter keeping the indentation, Page Up/Down,
 * find matches, reveals, theme colors, and the changed-on-disk prompt.
 */
import type { BoxRenderable, TextareaRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useEffect, useRef } from "react";
import { useApp, useFocusTarget, useKeyHandler, useStore } from "@/app/react";
import type { KeyStroke } from "@/core/keybindings";
import { Button } from "@/ui/primitives/button";
import { Icon } from "@/ui/primitives/icon";
import { useTheme } from "@/ui/theme/theme-context";
import { BufferCells } from "../buffer-cells";
import type { EditSession } from "../edit-session";
import type { FileSession } from "../file-session";
import { leadingWhitespace, outdentLength } from "../indent";
import { useSetting } from "./use-setting";

export interface EditSurfaceProps {
  readonly session: FileSession;
  readonly edit: EditSession;
  readonly focused: boolean;
}

/** Rows of the selection (or the cursor's row). The selection comes in buffer cells. */
function selectedRows(
  textarea: TextareaRenderable,
  cells: BufferCells,
): { first: number; last: number; selection: boolean } {
  const selection = textarea.getSelection();
  if (!selection || selection.start === selection.end) {
    const row = textarea.logicalCursor.row;
    return { first: row, last: row, selection: false };
  }
  const first = cells.rowOfDocumentCell(selection.start);
  // A selection that ends at the start of a line does not include that line.
  let last = cells.rowOfDocumentCell(Math.max(selection.start, selection.end - 1));
  if (last < first) last = first;
  return { first, last, selection: true };
}

function bufferCells(textarea: TextareaRenderable): BufferCells {
  return new BufferCells(textarea.plainText, textarea.editBuffer.getTabWidth());
}

function indentRows(textarea: TextareaRenderable, unit: string, outdent: boolean): void {
  const { first, last } = selectedRows(textarea, bufferCells(textarea));
  const lines = textarea.plainText.split("\n");
  for (let row = last; row >= first; row--) {
    const line = lines[row] ?? "";
    if (outdent) {
      const remove = outdentLength(line, unit);
      if (remove > 0) textarea.deleteRange(row, 0, row, remove);
    } else if (line.trim() !== "" || first === last) {
      textarea.setCursor(row, 0);
      textarea.insertText(unit);
    }
  }
  // Keep the edited block selected (in buffer cells), so Tab can be pressed again.
  if (first !== last) {
    const cells = bufferCells(textarea);
    const start = cells.documentCellOfLineStart(first);
    textarea.setSelection(start, cells.documentCellOfLineStart(last) + cells.width(last));
  }
}

function ConflictBar({ edit, session }: { edit: EditSession; session: FileSession }) {
  const app = useApp();
  const theme = useTheme();
  const c = theme.colors;
  const conflict = useStore(edit.state, (state) => state.conflict);
  if (!conflict) return null;
  const deleted = conflict === "deleted";
  return (
    <box height={1} flexShrink={0} flexDirection="row" backgroundColor={c.bg.raised} paddingLeft={2} gap={1}>
      <text flexGrow={1} flexShrink={0} fg={c.fg.default} selectable={false} wrapMode="none">
        <Icon name="warning" color={c.status.warning} />
        {/* Short, so the answers stay visible in a narrow editor; the status bar repeats it. */}
        {deleted ? "Deleted on disk" : "Changed on disk"}
      </text>
      <Button
        label={deleted ? "Save Again" : "Reload"}
        onPress={() => void app.run(deleted ? "editor.save" : "editor.reloadFromDisk")}
      />
      <Button
        label={deleted ? "Discard" : "Keep Mine"}
        onPress={() => {
          if (deleted) {
            edit.discard();
            void session.reload();
          } else void app.run("editor.keepMine");
        }}
      />
    </box>
  );
}

export function EditSurface({ session, edit, focused }: EditSurfaceProps) {
  const app = useApp();
  const renderer = useRenderer();
  const theme = useTheme();
  const c = theme.colors;
  const host = useRef<BoxRenderable>(null);
  const textareaRef = useRef<TextareaRenderable | null>(null);
  const heightRef = useRef(1);
  const ui = useStore(session.ui);
  const viewer = useStore(session.tab.viewer);
  const find = useStore(session.find.store);
  const tabWidth = useSetting("editor.tabWidth");
  const showNumbers = useSetting("editor.lineNumbers");
  const highlightActive = useSetting("editor.highlightActiveLine");
  const style = theme.syntaxStyle;
  const colors = {
    text: c.fg.default,
    bg: c.editor.bg,
    lineNumber: c.editor.lineNumber,
    activeLineBg: c.editor.activeLineBg,
    selectionBg: c.editor.selectionBg,
    cursor: c.accent.primary,
    findMatchBg: c.editor.findMatchBg,
    findMatchActiveBg: c.editor.findMatchActiveBg,
  };

  // Mount the session's live renderables; unmounting only detaches them (text, cursor and
  // undo history survive a tab switch). Leaving the tab counts as a focus change for auto save.
  // biome-ignore lint/correctness/useExhaustiveDependencies: colors and style are applied below.
  useEffect(() => {
    const box = host.current;
    if (!box || !style) return;
    const gutter = edit.ensureRenderables(renderer, style, colors);
    textareaRef.current = edit.textarea;
    box.add(gutter);
    const cursor = session.tab.viewer.get();
    if (edit.textarea && cursor.activeLine > 0 && edit.textarea.logicalCursor.row === 0) {
      edit.textarea.setCursor(cursor.activeLine, session.ui.get().column);
    }
    app.focus.restore();
    return () => {
      if (!gutter.isDestroyed) box.remove(gutter);
      edit.focusLost();
    };
  }, [edit, renderer]);

  useFocusTarget(textareaRef);

  useEffect(() => {
    if (style) edit.applyTheme(style, colors);
  });

  useEffect(() => {
    const textarea = edit.textarea;
    if (!textarea) return;
    textarea.wrapMode = viewer.wrap ? "word" : "none";
    textarea.editBuffer.setTabWidth(tabWidth);
    if (edit.gutter) edit.gutter.showLineNumbers = showNumbers;
    edit.showActiveLine = highlightActive;
  }, [edit, viewer.wrap, tabWidth, showNumbers, highlightActive]);

  // Auto save "on focus change": the editor zone lost focus.
  useEffect(() => {
    const subscription = app.focus.onDidChange((event) => {
      if (event.previous === "editor" && event.zone !== "editor") edit.focusLost();
    });
    return () => subscription.dispose();
  }, [app, edit]);

  // Find matches are highlights in the buffer.
  useEffect(() => {
    edit.showFindMatches(ui.findOpen ? find.matches : [], find.current);
  }, [edit, ui.findOpen, find.matches, find.current]);

  // Reveal requests (go to line, find, search results) move the cursor there.
  useEffect(() => {
    const textarea = edit.textarea;
    if (!textarea || ui.revealRequest === session.centeredRequest) return;
    session.centeredRequest = ui.revealRequest;
    textarea.setCursor(session.tab.viewer.get().activeLine, session.ui.get().column);
  }, [edit, session, ui.revealRequest]);

  useKeyHandler(
    (key: KeyStroke) => {
      const textarea = edit.textarea;
      // The widget handles most keys after this handler: report where the cursor went.
      queueMicrotask(() => edit.syncCursor());
      if (!textarea?.focused) {
        if (key.key === "escape" && session.ui.get().findOpen) {
          session.closeFind();
          return true;
        }
        return false;
      }
      if (key.key === "tab" && !key.ctrl && !key.alt) {
        const { selection } = selectedRows(textarea, bufferCells(textarea));
        if (key.shift || selection) indentRows(textarea, edit.indent.unit, key.shift);
        else textarea.insertText(edit.indent.unit);
        return true;
      }
      if ((key.key === "enter" || key.key === "return") && !key.ctrl && !key.alt && !key.shift) {
        const { row, col } = textarea.logicalCursor;
        const line = textarea.plainText.split("\n")[row] ?? "";
        const indent = leadingWhitespace(line.slice(0, col));
        textarea.deleteSelection();
        textarea.insertText(`\n${indent}`);
        return true;
      }
      if ((key.key === "pageup" || key.key === "pagedown") && !key.ctrl && !key.alt) {
        const rows = Math.max(1, heightRef.current - 1);
        for (let i = 0; i < rows; i++) {
          const moved =
            key.key === "pageup"
              ? textarea.moveCursorUp({ select: key.shift })
              : textarea.moveCursorDown({ select: key.shift });
          if (!moved) break;
        }
        return true;
      }
      if (key.key === "escape" && session.ui.get().findOpen) {
        session.closeFind();
        return true;
      }
      return false;
    },
    { enabled: focused, whileInputFocused: true },
  );

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} backgroundColor={c.editor.bg}>
      <ConflictBar edit={edit} session={session} />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: an OpenTUI renderable, not a DOM element. */}
      <box
        ref={host}
        flexGrow={1}
        minHeight={0}
        backgroundColor={c.editor.bg}
        onMouseUp={() => queueMicrotask(() => edit.syncCursor())}
        onSizeChange={function (this: BoxRenderable) {
          heightRef.current = this.height;
          session.tab.setViewportHeight(this.height);
        }}
      />
    </box>
  );
}
