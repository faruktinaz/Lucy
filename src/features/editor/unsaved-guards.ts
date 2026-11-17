/**
 * Closing a tab or quitting with unsaved edits (auto save off, or a save that failed) asks:
 * save, don't save, or cancel. The answer is a three-item picker; Escape cancels.
 */
import type { AppContext } from "@/app/app-context";
import { type Disposable, DisposableStore } from "@/core/events";
import { sanitizeForDisplay } from "@/core/text";
import { saveWithFeedback } from "./editing-commands";
import type { FileSession } from "./file-session";
import type { FileSessions } from "./file-sessions";

export type UnsavedAnswer = "save" | "discard" | "cancel";

export async function askAboutUnsaved(
  ctx: AppContext,
  sessions: readonly FileSession[],
): Promise<UnsavedAnswer> {
  const first = sessions[0];
  const name = first ? sanitizeForDisplay(first.path.split("/").at(-1) ?? first.path) : "";
  const item = await ctx.quickPick.pick({
    title: sessions.length === 1 ? `Save changes to ${name}?` : `Save changes to ${sessions.length} files?`,
    placeholder: "Your changes are lost if you don't save them",
    items: [
      { id: "save", label: sessions.length === 1 ? "Save" : "Save All" },
      { id: "discard", label: "Don't Save" },
      { id: "cancel", label: "Cancel" },
    ],
  });
  return item?.id === "save" || item?.id === "discard" ? item.id : "cancel";
}

/** Saves every session; false (and a toast from `saveWithFeedback`) when one fails. */
async function saveAll(ctx: AppContext, sessions: readonly FileSession[]): Promise<boolean> {
  let ok = true;
  for (const session of sessions) {
    if (session.edit && !(await saveWithFeedback(ctx, session, session.edit))) ok = false;
  }
  return ok;
}

export function registerUnsavedGuards(ctx: AppContext, sessions: FileSessions): Disposable {
  const store = new DisposableStore();
  store.add(
    ctx.editors.setCloseGuard(async (tab) => {
      const session = sessions.existing(tab.id);
      if (!session?.edit?.state.get().dirty) return true;
      const answer = await askAboutUnsaved(ctx, [session]);
      if (answer === "cancel") return false;
      if (answer === "discard") {
        session.edit.discard();
        return true;
      }
      return saveAll(ctx, [session]);
    }),
  );
  store.add(
    ctx.lifecycle.addQuitGuard(async () => {
      const dirty = sessions.dirty().map((entry) => entry.session);
      if (dirty.length === 0) return true;
      const answer = await askAboutUnsaved(ctx, dirty);
      if (answer === "cancel") return false;
      if (answer === "discard") return true;
      return saveAll(ctx, dirty);
    }),
  );
  return store;
}
