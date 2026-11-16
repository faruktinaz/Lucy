/**
 * Diff tabs: kind "diff", the repo-relative path as the resource and `{ staged: true }` for the
 * staged side, the identity `EditorService` persists and restores. Whether the diff is of an
 * untracked or conflicted file is decided by Git when the tab loads, so it is not part of the
 * identity and a tab stays valid when a file moves between groups.
 */
import type { GitDiffTarget, GitStatus } from "@/adapters/git";
import type { EditorInput, EditorTab } from "@/app/workbench/editors";

export const DIFF_KIND = "diff";

export function diffInput(path: string, staged: boolean): EditorInput {
  return { kind: DIFF_KIND, resource: path, params: staged ? { staged: true } : undefined };
}

export function isDiffTab(tab: EditorTab | null | undefined): tab is EditorTab & { resource: string } {
  return tab?.kind === DIFF_KIND && typeof tab.resource === "string" && tab.resource.length > 0;
}

/** The Git target of a diff tab; the rename source comes from the current status. */
export function diffTargetOf(tab: EditorTab & { resource: string }, status: GitStatus | null): GitDiffTarget {
  const staged = tab.params.staged === true;
  const change = status?.changes.find((candidate) => candidate.path === tab.resource);
  const origPath =
    staged && change?.origPath && (change.index === "renamed" || change.index === "copied")
      ? change.origPath
      : undefined;
  return { path: tab.resource, staged, ...(origPath ? { origPath } : {}) };
}

/** "Staged", "Working Tree", ... for the diff header and tab tooltips. */
export function diffSideLabel(mode: "unstaged" | "staged" | "untracked" | "conflict"): string {
  switch (mode) {
    case "staged":
      return "Staged";
    case "untracked":
      return "Untracked";
    case "conflict":
      return "Merge Conflict";
    case "unstaged":
      return "Working Tree";
  }
}
