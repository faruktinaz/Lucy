/**
 * The viewer's commands. Every action the view offers (keys, header actions, card buttons)
 * runs one of these, so all of them are in the palette and can be rebound.
 */
import { join } from "node:path";
import type { AppContext } from "@/app/app-context";
import type { CommandDefinition } from "@/core/commands";
import { errorMessage } from "@/core/errors";
import { type Disposable, DisposableStore } from "@/core/events";
import type { KeybindingDefinition } from "@/core/keybindings";
import { sanitizeForDisplay } from "@/core/text";
import { editInExternalEditor } from "./external-edit";
import type { FileSession } from "./file-session";
import type { FileSessions } from "./file-sessions";
import { canPreviewMarkdown } from "./model";
import { type ClipboardBridge, copyText, openWithDefaultApp } from "./system-actions";

/** Context key: the kind of the active editor tab (`file`, `diff`, `settings`, ...). */
export const ACTIVE_EDITOR_KEY = "activeEditor";

const fileFocused = `editorFocus && ${ACTIVE_EDITOR_KEY} == 'file'`;
const fileActive = `${ACTIVE_EDITOR_KEY} == 'file'`;

export const EDITOR_KEYBINDINGS: readonly KeybindingDefinition[] = [
  { command: "editor.findNext", keys: ["f3"], when: fileFocused },
  { command: "editor.findPrevious", keys: ["shift+f3"], when: fileFocused },
  // `e` like `v` in less(1): a single key while the read-only viewer has focus.
  { command: "editor.openInExternalEditor", keys: ["e", "ctrl+k o"], when: `${fileFocused} && !inputFocus` },
  { command: "editor.toggleWrap", keys: ["alt+z", "ctrl+k w"], when: fileFocused },
  { command: "editor.toggleMarkdownPreview", keys: ["ctrl+k v"], when: fileFocused },
  // Ctrl+K P / Ctrl+K R belong to the Explorer (copy path, reveal) everywhere.
  { command: "editor.copyPath", keys: ["ctrl+k shift+c"], when: fileFocused },
  { command: "editor.reload", keys: ["f5"], when: fileFocused },
];

export interface EditorCommandDeps {
  readonly sessions: FileSessions;
  readonly clipboard: ClipboardBridge;
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
      if (session) await editInExternalEditor(ctx, session);
    },
  });

  const copy = async (text: string, label: string) => {
    try {
      await copyText(text, deps.clipboard);
      ctx.hints.flash({ text: `Copied ${label}` });
    } catch (error) {
      ctx.notifications.show({ severity: "warning", title: "Could not copy", message: errorMessage(error) });
    }
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
      if (document.kind !== "unavailable") ctx.hints.flash({ text: `Reloaded ${baseName(session.path)}` });
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
