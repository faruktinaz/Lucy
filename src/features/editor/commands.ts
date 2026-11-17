/**
 * The viewer's commands. Every action the view offers (keys, header actions, card buttons)
 * runs one of these, so all of them are in the palette and can be rebound.
 */

import { join } from "node:path";
import type { AppContext } from "@/app/app-context";
import { copiedLabel } from "@/app/clipboard";
import type { CommandDefinition } from "@/core/commands";
import { errorMessage } from "@/core/errors";
import { type Disposable, DisposableStore } from "@/core/events";
import type { KeybindingDefinition } from "@/core/keybindings";
import { sanitizeForDisplay } from "@/core/text";
import { registerEditingCommands } from "./editing-commands";
import { editInExternalEditor } from "./external-edit";
import type { FileSession } from "./file-session";
import type { FileSessions } from "./file-sessions";
import { canPreviewMarkdown } from "./model";
import { openWithDefaultApp } from "./system-actions";

/** Context key: the kind of the active editor tab (`file`, `diff`, `settings`, ...). */
export const ACTIVE_EDITOR_KEY = "activeEditor";

/** Context key: the active file tab is being edited in place (not read-only). */
export const EDITABLE_KEY = "editorEditable";

const fileFocused = `editorFocus && ${ACTIVE_EDITOR_KEY} == 'file'`;
const editing = `${fileFocused} && ${EDITABLE_KEY}`;
const fileActive = `${ACTIVE_EDITOR_KEY} == 'file'`;

export const EDITOR_KEYBINDINGS: readonly KeybindingDefinition[] = [
  { command: "editor.findNext", keys: ["f3"], when: fileFocused },
  { command: "editor.findPrevious", keys: ["shift+f3"], when: fileFocused },
  // `e` like `v` in less(1), only in a read-only file: in an editable one, typing must type.
  {
    command: "editor.openInExternalEditor",
    keys: ["e", "ctrl+k o"],
    when: `${fileFocused} && !inputFocus && !${EDITABLE_KEY}`,
  },
  { command: "editor.openInExternalEditor", keys: ["ctrl+k o"], when: `${fileFocused} && ${EDITABLE_KEY}` },
  { command: "editor.save", keys: ["ctrl+s", "ctrl+k s"], when: fileFocused },
  { command: "editor.undo", keys: ["ctrl+z"], when: editing },
  { command: "editor.redo", keys: ["ctrl+shift+z", "ctrl+y"], when: editing },
  { command: "editor.copy", keys: ["ctrl+c"], when: editing },
  { command: "editor.cut", keys: ["ctrl+x"], when: editing },
  { command: "editor.paste", keys: ["ctrl+v"], when: editing },
  { command: "editor.toggleWrap", keys: ["alt+z", "ctrl+k w"], when: fileFocused },
  { command: "editor.toggleMarkdownPreview", keys: ["ctrl+k v"], when: fileFocused },
  // Ctrl+K P / Ctrl+K R belong to the Explorer (copy path, reveal) everywhere.
  { command: "editor.copyPath", keys: ["ctrl+k shift+c"], when: fileFocused },
  { command: "editor.reload", keys: ["f5"], when: fileFocused },
];

export interface EditorCommandDeps {
  readonly sessions: FileSessions;
}

function baseName(path: string): string {
  return sanitizeForDisplay(path.split("/").at(-1) ?? path);
}

export function registerEditorCommands(ctx: AppContext, deps: EditorCommandDeps): Disposable {
  const store = new DisposableStore();
  const { sessions } = deps;
  const activeSession = (): FileSession | undefined => sessions.active();
  const hasText = () => activeSession()?.document?.kind === "text";

  const register = (definition: Omit<CommandDefinition, "category">) =>
    store.add(ctx.commands.register({ category: "Editor", when: fileActive, ...definition }));

  register({
    id: "editor.find",
    title: "Find in File",
    keywords: ["search", "find"],
    enabled: hasText,
    run: () => {
      const session = activeSession();
      if (!session) return;
      ctx.focus.focus("editor");
      session.openFind();
    },
  });

  const step = (direction: 1 | -1) => {
    const session = activeSession();
    if (!session) return;
    if (!session.ui.get().findOpen) session.openFind();
    const match = direction === 1 ? session.find.next() : session.find.previous();
    if (match) session.revealOffset(match.line, match.start);
  };
  register({ id: "editor.findNext", title: "Find Next", enabled: hasText, run: () => step(1) });
  register({ id: "editor.findPrevious", title: "Find Previous", enabled: hasText, run: () => step(-1) });

  register({
    id: "editor.goToLine",
    title: "Go to Line",
    keywords: ["line", "jump"],
    enabled: hasText,
    run: () => ctx.quickPick.show(":"),
  });

  register({
    id: "editor.toggleWrap",
    title: "Toggle Word Wrap",
    keywords: ["wrap", "long lines"],
    enabled: hasText,
    run: () => activeSession()?.tab.toggleWrap(),
  });

  register({
    id: "editor.toggleMarkdownPreview",
    title: "Toggle Markdown Preview",
    keywords: ["markdown", "preview", "render"],
    enabled: () => canPreviewMarkdown(activeSession()?.document),
    run: () => activeSession()?.tab.toggleMarkdownPreview(),
  });

  register({
    id: "editor.openInExternalEditor",
    title: "Open in External Editor",
    description: "Edit the file in your terminal editor (micro, Helix, Neovim, Vim)",
    keywords: ["edit", "micro", "vim", "nvim", "helix", "nano"],
    enabled: () => {
      const document = activeSession()?.document;
      return document?.actions.includes("edit-in-terminal-editor") === true;
    },
    run: async () => {
      const session = activeSession();
      if (!session) return;
      // The external editor reads the file from disk: unsaved edits go there first.
      if (session.edit?.state.get().dirty && !(await session.edit.save())) {
        ctx.notifications.show({
          severity: "warning",
          title: "Save the file first",
          message: "The external editor opens the file on disk, and saving the changes failed.",
        });
        return;
      }
      await editInExternalEditor(ctx, session);
    },
  });

  registerEditingCommands(ctx, sessions, register);

  const copy = async (text: string, label: string) => {
    const result = await ctx.clipboard.copy(text);
    if (result.ok) ctx.hints.flash({ text: copiedLabel(result, `Copied ${label}`) });
    else ctx.notifications.show({ severity: "warning", title: "Could not copy", message: result.reason });
  };
  register({
    id: "editor.copyPath",
    title: "Copy Path",
    keywords: ["clipboard", "absolute"],
    run: async () => {
      const session = activeSession();
      if (session) await copy(join(ctx.workspace.root, ...session.path.split("/")), "path");
    },
  });
  register({
    id: "editor.copyRelativePath",
    title: "Copy Relative Path",
    keywords: ["clipboard"],
    run: async () => {
      const session = activeSession();
      if (session) await copy(session.path, "relative path");
    },
  });

  register({
    id: "editor.reload",
    title: "Reload File",
    keywords: ["refresh", "revert"],
    run: async () => {
      const session = activeSession();
      if (!session) return;
      const document = await session.reload();
      // A dirty buffer is not replaced: the changed-on-disk prompt says what happened instead.
      if (document.kind !== "unavailable" && !session.edit?.state.get().conflict) {
        ctx.hints.flash({ text: `Reloaded ${baseName(session.path)}` });
      }
    },
  });

  register({
    id: "editor.openWithDefaultApp",
    title: "Open with Default Application",
    keywords: ["open", "external", "finder", "preview"],
    enabled: () => {
      const document = activeSession()?.document;
      return document?.actions.includes("open-externally") === true;
    },
    run: async () => {
      const session = activeSession();
      if (!session) return;
      try {
        await openWithDefaultApp(join(ctx.workspace.root, ...session.path.split("/")));
        ctx.hints.flash({ text: `Opened ${baseName(session.path)} outside Lucy` });
      } catch (error) {
        ctx.notifications.show({
          severity: "warning",
          title: `Could not open ${baseName(session.path)}`,
          message: errorMessage(error),
        });
      }
    },
  });

  return store;
}
