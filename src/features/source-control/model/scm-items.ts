/**
 * Sections and items of the Source Control list, derived from a `GitStatus`. Pure functions.
 *
 * Letters follow VS Code's Source Control view (M, A, D, R, C, T, U for untracked, ! for merge
 * conflicts) so users coming from VS Code read them the same way. Note that the explorer
 * decoration index in the Git layer uses Git's short-status letters (`?` untracked, `U`
 * conflicted); use `scmStatusLetter` wherever the two should agree.
 */
import type { GitChange, GitConflictKind, GitFileStatus, GitStatus } from "@/adapters/git";
import { sanitizeForDisplay } from "@/core/text";
import type { TokenPath } from "@/themes";

export type ScmGroup = "conflicts" | "staged" | "changes" | "untracked";

/** Display order; empty sections are omitted. */
export const SCM_SECTION_ORDER: readonly ScmGroup[] = ["conflicts", "staged", "changes", "untracked"];

export const SCM_SECTION_TITLES: Readonly<Record<ScmGroup, string>> = {
  conflicts: "Merge Changes",
  staged: "Staged Changes",
  changes: "Changes",
  untracked: "Untracked",
};

export interface ScmItem {
  /** Stable identity: group + path. */
  readonly key: string;
  readonly group: ScmGroup;
  readonly path: string;
  readonly origPath?: string;
  /** Last path segment (raw). */
  readonly fileName: string;
  /** Directory part without trailing slash (raw); `""` at the repository root. */
  readonly directory: string;
  /** `fileName` made safe for a single terminal row. */
  readonly label: string;
  /** `directory` (and `← origPath` for renames) made safe for a single terminal row. */
  readonly description: string;
  readonly status: GitFileStatus;
  readonly letter: string;
  /** Theme token to color the letter and name with. */
  readonly tokenName: TokenPath;
  /** The item belongs to the Staged Changes group. */
  readonly staged: boolean;
  readonly conflictKind?: GitConflictKind;
  readonly change: GitChange;
}

export interface ScmSection {
  readonly group: ScmGroup;
  readonly title: string;
  readonly count: number;
  readonly collapsed: boolean;
}

const LETTERS: Readonly<Record<GitFileStatus, string>> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  "type-changed": "T",
  untracked: "U",
  unmerged: "!",
};

const TOKENS: Readonly<Record<GitFileStatus, TokenPath>> = {
  modified: "git.modified",
  "type-changed": "git.modified",
  added: "git.added",
  deleted: "git.deleted",
  renamed: "git.renamed",
  copied: "git.renamed",
  untracked: "git.untracked",
  unmerged: "git.conflicted",
};

export function scmStatusLetter(status: GitFileStatus): string {
  return LETTERS[status];
}

export function scmStatusToken(status: GitFileStatus): TokenPath {
  return TOKENS[status];
}

/** The status an item shows in its group: the index side when staged, the working tree otherwise. */
export function statusInGroup(change: GitChange, group: ScmGroup): GitFileStatus {
  switch (group) {
    case "conflicts":
      return "unmerged";
    case "staged":
      return change.index ?? "modified";
    case "untracked":
      return "untracked";
    case "changes":
      return change.worktree ?? "modified";
  }
}

export function itemKey(group: ScmGroup, path: string): string {
  return `item:${group}:${path}`;
}

export function sectionKey(group: ScmGroup): string {
  return `section:${group}`;
}

export function splitPath(path: string): { fileName: string; directory: string } {
  const trailing = path.endsWith("/");
  const body = trailing ? path.slice(0, -1) : path;
  const slash = body.lastIndexOf("/");
  const name = slash === -1 ? body : body.slice(slash + 1);
  return { fileName: trailing ? `${name}/` : name, directory: slash === -1 ? "" : body.slice(0, slash) };
}

export function createScmItem(change: GitChange, group: ScmGroup): ScmItem {
  const status = statusInGroup(change, group);
  const { fileName, directory } = splitPath(change.path);
  const showOrig =
    change.origPath !== undefined && (group === "staged" ? change.index : change.worktree) === "renamed";
  const description = showOrig ? `${directory}${directory ? " " : ""}← ${change.origPath}` : directory;
  const item: ScmItem = {
    key: itemKey(group, change.path),
    group,
    path: change.path,
    fileName,
    directory,
    label: sanitizeForDisplay(fileName),
    description: sanitizeForDisplay(description),
    status,
    letter: LETTERS[status],
    tokenName: TOKENS[status],
    staged: group === "staged",
    change,
    ...(change.origPath !== undefined ? { origPath: change.origPath } : {}),
    ...(change.conflictKind !== undefined ? { conflictKind: change.conflictKind } : {}),
  };
  return item;
}

export type ScmItemsByGroup = Readonly<Record<ScmGroup, readonly ScmItem[]>>;

export function itemsFromStatus(status: GitStatus | null): ScmItemsByGroup {
  if (!status) return { conflicts: [], staged: [], changes: [], untracked: [] };
  return {
    conflicts: status.conflicts.map((change) => createScmItem(change, "conflicts")),
    staged: status.staged.map((change) => createScmItem(change, "staged")),
    changes: status.unstaged.map((change) => createScmItem(change, "changes")),
    untracked: status.untracked.map((change) => createScmItem(change, "untracked")),
  };
}
