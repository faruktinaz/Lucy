/**
 * Review-first defaults for a workspace without a saved layout. Lucy is built around the
 * loop "run the agent, review what it changed, commit", so a fresh workspace opens with the
 * agent panel beside the editor (when the terminal is wide enough) and the sidebar on
 * Changes when there is something to review. A saved layout is never touched: these apply
 * only when nothing was restored.
 */

import type { GitState } from "@/adapters/git";
import { type Disposable, toDisposable } from "@/core/events";
import type { LayoutService } from "./layout";
import type { Readable } from "./readable";

/** The agent panel opens by default from this terminal width. */
export const AGENT_PANEL_DEFAULT_MIN_WIDTH = 120;

export interface ReviewFirstInput {
  layout: LayoutService;
  hasAuxiliaryView: () => boolean;
  /** Git state; the first status decides the sidebar view. */
  git: Readable<GitState> | null;
}

export function applyReviewFirstLayout({ layout, hasAuxiliaryView, git }: ReviewFirstInput): Disposable {
  if (hasAuxiliaryView() && layout.viewport.get().width >= AGENT_PANEL_DEFAULT_MIN_WIDTH) {
    layout.setAuxiliaryVisible(true);
    // When the terminal later narrows, the sidebar keeps its place beside the editor.
    layout.noteSide("sidebar");
  }
  if (!git) return toDisposable(() => {});
  const initialView = layout.state.sidebar.view;
  let done = false;
  let unsubscribe: () => void = () => {};
  const decide = () => {
    if (done) return;
    const state = git.get();
    // The user chose a view before Git answered: their choice wins.
    if (layout.state.sidebar.view !== initialView) done = true;
    else if (state.status) {
      done = true;
      if (state.status.changes.length > 0) layout.showSidebarView("scm");
    } else if (state.error) done = true;
    if (done) unsubscribe();
  };
  unsubscribe = git.subscribe(decide);
  decide();
  return toDisposable(() => unsubscribe());
}
