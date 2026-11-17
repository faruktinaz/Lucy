/**
 * Editor feature: the read-only code viewer for `file` tabs (syntax colors, line numbers,
 * active line, find, go to line, Markdown preview, information cards for binary, oversized and
 * unavailable files), editing through the user's terminal editor, reload on file changes, and
 * the status bar items of the active file.
 */

import { detectLanguage } from "@/adapters/syntax/languages";
import type { AppContext } from "@/app/app-context";
import type { FeatureModule } from "@/app/feature";
import type { EditorTab } from "@/app/workbench/editors";
import type { ViewAction } from "@/app/workbench/views";
import { DisposableStore, toDisposable } from "@/core/events";
import { placeholderEditor } from "@/ui/shell/placeholders";
import { ACTIVE_EDITOR_KEY, EDITOR_KEYBINDINGS, registerEditorCommands } from "./commands";
import { externalEditorName } from "./external-edit";
import { FileSessions } from "./file-sessions";
import { isMarkdownLanguage } from "./model";
import { registerStatusItems } from "./status-items";
import { registerUnsavedGuards } from "./unsaved-guards";
import { createFileView } from "./views/file-view";

/** Breadcrumb actions of a file tab: the Markdown toggle and editing in the terminal editor. */
function fileActions(sessions: FileSessions, tab: EditorTab): ViewAction[] {
  if (!tab.resource) return [];
  const document = sessions.existing(tab.id)?.document;
  const actions: ViewAction[] = [];
  const markdown =
    document?.kind === "text" ? document.isMarkdown : isMarkdownLanguage(detectLanguage(tab.resource).id);
  if (markdown && (document === null || document === undefined || document.kind === "text")) {
    const preview = tab.viewState.markdownPreview === true;
    actions.push({
      command: "editor.toggleMarkdownPreview",
      icon: "file",
      label: preview ? "Source" : "Preview",
      title: preview ? "Show the Markdown source" : "Show the rendered Markdown",
      active: preview,
    });
  }
  // An editable file is edited right here; the terminal editor stays in the palette (Ctrl+K O).
  if (document?.actions.includes("edit-in-terminal-editor") && !sessions.existing(tab.id)?.edit) {
    actions.push({ command: "editor.openInExternalEditor", icon: "terminal", label: "Edit" });
  }
  return actions;
}

export const editorFeature: FeatureModule = {
  id: "editor",
  keybindings: EDITOR_KEYBINDINGS,
  activate(ctx: AppContext) {
    const store = new DisposableStore();
    const sessions = store.add(new FileSessions(ctx));

    // Resolving the editor reads PATH: once per setting change, not per render.
    let editorName: string | null | undefined;
    store.add(
      ctx.config.onDidChange((event) => {
        if (event.changed.includes("editor.external")) editorName = undefined;
      }),
    );
    const resolvedEditorName = () => {
      if (editorName === undefined) editorName = externalEditorName(ctx);
      return editorName;
    };

    store.add(
      ctx.views.registerEditorView({
        kind: "file",
        component: createFileView({ sessions, editorName: resolvedEditorName }),
        actions: (tab) => fileActions(sessions, tab),
      }),
    );
    // A placeholder at the default priority: the Source Control feature's diff view supersedes it.
    store.add(
      ctx.views.registerEditorView({
        kind: "diff",
        title: (input) => input.resource?.split("/").at(-1),
        component: placeholderEditor({
          description: "The diff viewer is not available yet.",
          details: ({ tab }) => (tab.resource && tab.resource !== tab.title ? [tab.resource] : []),
        }),
      }),
    );

    store.add(registerEditorCommands(ctx, { sessions }));
    store.add(registerUnsavedGuards(ctx, sessions));
    store.add(registerStatusItems(ctx, sessions));

    // `when` clauses read the active tab's kind (`activeEditor == 'file'`).
    const syncContext = () => ctx.contextKeys.set(ACTIVE_EDITOR_KEY, ctx.editors.active?.kind);
    syncContext();
    store.add(toDisposable(ctx.editors.store.subscribe(syncContext)));
    store.add(toDisposable(() => ctx.contextKeys.delete(ACTIVE_EDITOR_KEY)));
    return store;
  },
};
