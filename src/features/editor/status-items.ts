/**
 * Status bar items while a file tab is active: position, language, encoding, line endings,
 * and the quiet read-only hint with the key for editing. Diff tabs keep the language.
 */

import { detectLanguage } from "@/adapters/syntax/languages";
import type { AppContext } from "@/app/app-context";
import { type Disposable, DisposableStore, toDisposable } from "@/core/events";
import { characterColumn } from "./display-text";
import { externalEditorName } from "./external-edit";
import type { FileSession } from "./file-session";
import type { FileSessions } from "./file-sessions";

export function registerStatusItems(ctx: AppContext, sessions: FileSessions): Disposable {
  const store = new DisposableStore();
  const item = (id: string, priority: number, extra: { command?: string; tooltip?: string } = {}) =>
    store.add(
      ctx.statusBar.register({ id, alignment: "right", priority, text: "", visible: false, ...extra }),
    );

  const readOnly = item("editor.readOnly", 55, { command: "editor.openInExternalEditor" });
  const position = item("editor.position", 50, { command: "editor.goToLine", tooltip: "Go to Line" });
  const language = item("editor.language", 40);
  const encoding = item("editor.encoding", 34);
  const lineEnding = item("editor.lineEnding", 33);
  const all = [readOnly, position, language, encoding, lineEnding];

  // Resolving the editor looks at PATH: do it once per setting change, not per scroll.
  let editorName: string | null | undefined;
  const editor = () => {
    if (editorName === undefined) editorName = externalEditorName(ctx);
    return editorName;
  };
  let watched: FileSession | undefined;
  let unwatch: (() => void) | undefined;

  const render = () => {
    const tab = ctx.editors.active;
    if (!tab?.resource || (tab.kind !== "file" && tab.kind !== "diff")) {
      for (const handle of all) handle.update({ visible: false });
      return;
    }
    const session = tab.kind === "file" ? sessions.forTab(tab) : undefined;
    const document = session?.document;
    if (!session || document?.kind !== "text") {
      for (const handle of [readOnly, position, encoding, lineEnding]) handle.update({ visible: false });
      // A diff names its language; a binary or missing file has none worth showing.
      if (tab.kind === "diff")
        language.update({ visible: true, text: detectLanguage(tab.resource).displayName });
      else language.update({ visible: false });
      return;
    }
    const viewer = session.tab.viewer.get();
    const line = viewer.activeLine;
    const column = characterColumn(session.lines()[line] ?? "", session.ui.get().column);
    position.update({ visible: true, text: `Ln ${line + 1}, Col ${column}` });
    language.update({ visible: true, text: document.language.displayName });
    encoding.update({ visible: true, text: document.encodingLabel });
    lineEnding.update({ visible: true, text: document.lineEndingLabel });
    const key = ctx.keybindingLabel("editor.openInExternalEditor");
    const editable = document.actions.includes("edit-in-terminal-editor");
    readOnly.update({
      visible: true,
      text: editable && key ? `Read-only · ${key} to edit` : "Read-only",
      tooltip: editable
        ? `The viewer is read-only. Edit in ${editor() ?? "your terminal editor"}`
        : "The viewer is read-only",
      command: editable ? "editor.openInExternalEditor" : undefined,
    });
  };

  const follow = () => {
    const tab = ctx.editors.active;
    const session = tab?.kind === "file" ? sessions.forTab(tab) : undefined;
    if (session !== watched) {
      unwatch?.();
      watched = session;
      if (session) {
        const offs = [
          session.tab.state.subscribe(render),
          session.tab.viewer.subscribe(render),
          session.ui.subscribe(render),
        ];
        unwatch = () => {
          for (const off of offs) off();
        };
      } else {
        unwatch = undefined;
      }
    }
    render();
  };

  follow();
  store.add(toDisposable(ctx.editors.store.subscribe(follow)));
  store.add(toDisposable(sessions.generation.subscribe(follow)));
  store.add(
    ctx.config.onDidChange((event) => {
      if (event.changed.includes("editor.external")) editorName = undefined;
      if (event.changed.some((path) => path.startsWith("keybindings.") || path === "editor.external"))
        render();
    }),
  );
  store.add(toDisposable(() => unwatch?.()));
  return store;
}
