/**
 * Commands for in-place editing: save, undo/redo, clipboard, and the answers to the
 * changed-on-disk prompt. They act on the active file tab's edit session.
 */
import type { AppContext } from "@/app/app-context";
import { copiedLabel } from "@/app/clipboard";
import type { CommandDefinition } from "@/core/commands";
import { sanitizeForDisplay } from "@/core/text";
import type { EditSession } from "./edit-session";
import type { FileSession } from "./file-session";
import type { FileSessions } from "./file-sessions";
import { readClipboard } from "./system-actions";

type Register = (definition: Omit<CommandDefinition, "category">) => unknown;

function nameOf(path: string): string {
  return sanitizeForDisplay(path.split("/").at(-1) ?? path);
}

/** Saves and tells the user when it did not work (the buffer stays dirty). */
export async function saveWithFeedback(
  ctx: AppContext,
  session: FileSession,
  edit: EditSession,
): Promise<boolean> {
  // Saving after the file was deleted on disk recreates it: that is what the user asked for.
  const saved = await edit.save({ force: edit.state.get().conflict === "deleted" });
  const state = edit.state.get();
  if (saved) return true;
  if (state.conflict) {
    ctx.notifications.show({
      severity: "warning",
      title: `${nameOf(session.path)} changed on disk`,
      message: "Choose Reload from Disk or Keep My Changes first; nothing was overwritten.",
      key: `editor.save.${session.path}`,
    });
  } else if (state.status === "failed") {
    ctx.notifications.show({
      severity: "error",
      title: `Could not save ${nameOf(session.path)}`,
      message: `${state.error ?? "The file could not be written."} Your changes are still in the editor.`,
      key: `editor.save.${session.path}`,
    });
  }
  return false;
}

export function registerEditingCommands(ctx: AppContext, sessions: FileSessions, register: Register): void {
  const active = (): { session: FileSession; edit: EditSession } | null => {
    const session = sessions.active();
    return session?.edit ? { session, edit: session.edit } : null;
  };
  const editable = () => active() !== null;

  register({
    id: "editor.save",
    title: "Save",
    keywords: ["write", "save file"],
    enabled: editable,
    run: async () => {
      const target = active();
      if (!target) {
        if (sessions.active()) ctx.hints.flash({ text: "This file is read-only", tone: "muted" });
        return;
      }
      if (await saveWithFeedback(ctx, target.session, target.edit)) {
        ctx.hints.flash({ text: `Saved ${nameOf(target.session.path)}` });
      }
    },
  });

  register({
    id: "editor.undo",
    title: "Undo",
    enabled: editable,
    run: () => void active()?.edit.textarea?.undo(),
  });
  register({
    id: "editor.redo",
    title: "Redo",
    enabled: editable,
    run: () => void active()?.edit.textarea?.redo(),
  });

  /** The selection, or the whole current line (with its break) when nothing is selected. */
  const selectionOrLine = (edit: EditSession): { text: string; line: boolean } => {
    const textarea = edit.textarea;
    if (!textarea) return { text: "", line: false };
    if (textarea.hasSelection()) return { text: textarea.getSelectedText(), line: false };
    const line = textarea.plainText.split("\n")[textarea.logicalCursor.row] ?? "";
    return { text: `${line}\n`, line: true };
  };

  const copy = async (text: string) => {
    const result = await ctx.clipboard.copy(text);
    if (result.ok) ctx.hints.flash({ text: copiedLabel(result, "Copied") });
    else ctx.notifications.show({ severity: "warning", title: "Could not copy", message: result.reason });
    return result.ok;
  };

  register({
    id: "editor.copy",
    title: "Copy",
    enabled: editable,
    run: async () => {
      const target = active();
      if (target) await copy(selectionOrLine(target.edit).text);
    },
  });

  register({
    id: "editor.cut",
    title: "Cut",
    enabled: editable,
    run: async () => {
      const target = active();
      const textarea = target?.edit.textarea;
      if (!target || !textarea) return;
      const { text, line } = selectionOrLine(target.edit);
      if (!(await copy(text))) return;
      if (line) textarea.deleteLine();
      else textarea.deleteSelection();
    },
  });

  register({
    id: "editor.paste",
    title: "Paste",
    enabled: editable,
    run: async () => {
      const textarea = active()?.edit.textarea;
      if (!textarea) return;
      const text = await readClipboard();
      if (text === null) {
        ctx.hints.flash({ text: "Paste with your terminal's paste key (the clipboard cannot be read here)" });
        return;
      }
      textarea.deleteSelection();
      textarea.insertText(text.replace(/\r\n/g, "\n"));
    },
  });

  register({
    id: "editor.reloadFromDisk",
    title: "Reload from Disk (Discard Changes)",
    keywords: ["revert", "conflict"],
    enabled: () => active()?.edit.state.get().conflict === "changed",
    run: async () => {
      const target = active();
      if (!target) return;
      const document = await target.session.reload();
      target.edit.reloadFromDisk(document);
    },
  });

  register({
    id: "editor.keepMine",
    title: "Keep My Changes (Overwrite on Save)",
    keywords: ["conflict"],
    enabled: () => active()?.edit.state.get().conflict === "changed",
    run: async () => {
      const target = active();
      if (!target) return;
      await target.edit.keepMine();
      if (ctx.config.get("editor.autosave") !== "off")
        await saveWithFeedback(ctx, target.session, target.edit);
    },
  });
}
