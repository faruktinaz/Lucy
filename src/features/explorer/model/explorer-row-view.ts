/**
 * Maps `FileTree` rows to display rows: sanitized names, icons, Git badges and colors.
 */
import type { TreeEntry, TreeRow } from "@/adapters/filesystem";
import type { GitDecoration } from "@/adapters/git";
import { sanitizeForDisplay } from "@/core/text";
import { type IconTier, icon, iconForFile, type TokenPath } from "@/themes";
import type { DecorationLookup, ExplorerEntryRow, ExplorerGitBadge, ExplorerMoreRow } from "./explorer-types";

const numberFormat = new Intl.NumberFormat("en-US");

export function formatCount(value: number): string {
  return numberFormat.format(value);
}

/** Theme token for a Git status (conflicts and untracked files win over index states). */
export function gitColor(decoration: GitDecoration): TokenPath {
  if (decoration.conflicted || decoration.status === "unmerged") return "git.conflicted";
  switch (decoration.status) {
    case "untracked":
      return "git.untracked";
    case "added":
      return "git.added";
    case "deleted":
      return "git.deleted";
    case "renamed":
    case "copied":
      return "git.renamed";
    default:
      return "git.modified";
  }
}

export function gitBadge(decoration: GitDecoration | undefined, tier: IconTier): ExplorerGitBadge | null {
  if (!decoration) return null;
  const color = gitColor(decoration);
  if (decoration.kind === "directory") {
    // VS Code style: a folder only hints that something inside changed.
    return { text: icon("modified", tier), color, quiet: true, count: decoration.changeCount };
  }
  return { text: decoration.letter, color, quiet: false, count: 1 };
}

export interface RowViewContext {
  readonly tier: IconTier;
  readonly decorations: DecorationLookup | null;
  readonly selectedKey: string | null;
  readonly activePath: string | null;
}

export function entryRowView(
  row: { key: string; depth: number; guides: readonly boolean[]; isLast: boolean },
  entry: TreeEntry,
  context: RowViewContext,
): ExplorerEntryRow {
  const decoration = context.decorations?.(entry.path);
  const git = gitBadge(decoration, context.tier);
  const isDirectory = entry.kind === "directory";
  const nameColor: TokenPath = git ? git.color : entry.isIgnored ? "git.ignored" : "fg.default";
  return {
    type: "entry",
    key: row.key,
    depth: row.depth,
    guides: row.guides,
    isLast: row.isLast,
    selected: row.key === context.selectedKey,
    path: entry.path,
    name: sanitizeForDisplay(entry.name),
    kind: entry.kind,
    expanded: isDirectory && entry.expanded,
    loading: entry.loading,
    error: entry.error ? sanitizeForDisplay(entry.error.message) : null,
    dimmed: entry.isIgnored,
    hidden: entry.isHidden,
    symlink: entry.isSymlink ? entry.symlinkTarget : null,
    external: entry.isExternal,
    icon: iconForFile(
      entry.name,
      isDirectory ? (entry.expanded ? "directory-open" : "directory") : "file",
      context.tier,
    ),
    nameColor,
    git,
    active: !isDirectory && entry.path === context.activePath,
  };
}

export function moreRowView(
  row: Extract<TreeRow, { type: "more" }>,
  selectedKey: string | null,
): ExplorerMoreRow {
  return {
    type: "more",
    key: row.key,
    depth: row.depth,
    guides: row.guides,
    isLast: row.isLast,
    selected: row.key === selectedKey,
    parentPath: row.parentPath,
    hiddenCount: row.hiddenCount,
    label: `${formatCount(row.hiddenCount)} more…`,
  };
}
