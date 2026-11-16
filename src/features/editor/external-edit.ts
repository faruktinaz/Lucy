/**
 * "Open in External Editor": the viewer is read-only, so editing happens in the user's own
 * terminal editor. Lucy hands it the terminal (suspend), waits, takes the terminal back
 * (resume, always), reloads the file and says plainly what happened.
 */
import { type EditorEnv, openInExternalEditor, type ResolvedEditor, resolveEditor } from "@/adapters/editor";
import type { AppContext } from "@/app/app-context";
import { errorMessage, isLucyError } from "@/core/errors";
import { sanitizeForDisplay } from "@/core/text";
import { characterColumn } from "./display-text";
import type { FileSession } from "./file-session";

const SETTING_HINT = 'Choose an editor with the "editor.external" setting.';

/** The resolved editor's name for buttons and hints ("micro", "Helix"), or null when none is usable. */
export function externalEditorName(ctx: AppContext, env: EditorEnv = process.env): string | null {
  const resolution = resolveEditor(ctx.config.get("editor.external"), env);
  return resolution.ok ? resolution.editor.displayName : null;
}

function openSettingsAction(ctx: AppContext) {
  return { label: "Open Settings", run: () => ctx.run("settings.open") };
}

export async function editInExternalEditor(
  ctx: AppContext,
  session: FileSession,
  env: EditorEnv = process.env,
): Promise<void> {
  const name = sanitizeForDisplay(session.path.split("/").at(-1) ?? session.path);
  const resolution = resolveEditor(ctx.config.get("editor.external"), env);
  if (!resolution.ok) {
    ctx.notifications.show({
      severity: "warning",
      title: "No terminal editor to open",
      message: `${resolution.message} ${SETTING_HINT}`,
      actions: ctx.commands.get("settings.open") ? [openSettingsAction(ctx)] : undefined,
      key: "editor.external",
    });
    return;
  }
  const editor: ResolvedEditor = resolution.editor;
  const viewer = session.tab.viewer.get();
  const lines = session.lines();
  const lineText = lines[viewer.activeLine] ?? "";
  let result: Awaited<ReturnType<typeof openInExternalEditor>>;
  try {
    result = await openInExternalEditor({
      editor,
      file: session.path,
      line: viewer.activeLine + 1,
      column: characterColumn(lineText, session.ui.get().column),
      cwd: ctx.workspace.root,
      terminal: {
        suspend: () => ctx.lifecycle.suspendTerminal(),
        resume: () => ctx.lifecycle.resumeTerminal(),
      },
    });
  } catch (error) {
    const outside = isLucyError(error, "OUTSIDE_WORKSPACE");
    ctx.notifications.show({
      severity: "error",
      title: outside ? `${name} is outside the workspace` : `${editor.displayName} could not start`,
      message: outside
        ? "Lucy only opens files inside the workspace in an external editor."
        : `${sanitizeForDisplay(errorMessage(error))} ${SETTING_HINT}`,
      actions: !outside && ctx.commands.get("settings.open") ? [openSettingsAction(ctx)] : undefined,
      key: "editor.external",
    });
    return;
  }

  // The watcher may be off or slow: reload now, keeping the active line and scroll.
  await session.tab.checkForChanges();
  if (result.exitCode !== 0 && result.exitCode !== null) {
    ctx.notifications.show({
      severity: "warning",
      title: `${editor.displayName} exited with code ${result.exitCode}`,
      message: result.changed ? `${name} was changed and has been reloaded.` : `${name} is unchanged.`,
      key: "editor.external",
    });
    return;
  }
  if (result.signal) {
    ctx.notifications.show({
      severity: "warning",
      title: `${editor.displayName} was stopped (${result.signal})`,
      message: result.changed ? `${name} was changed and has been reloaded.` : `${name} is unchanged.`,
      key: "editor.external",
    });
    return;
  }
  ctx.hints.flash({
    text: result.deleted
      ? `${name} was deleted in ${editor.displayName}`
      : result.changed
        ? `${name} saved in ${editor.displayName} and reloaded`
        : `No changes to ${name}`,
  });
}
