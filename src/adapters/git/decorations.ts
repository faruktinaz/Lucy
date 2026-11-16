/**
 * Path → change lookup for explorer decorations, built once per status snapshot.
 *
 * Every ancestor directory of a changed path gets an aggregate entry, so "this folder contains
 * changes" is an O(1) lookup. Keys are NFC-normalized: on macOS the explorer may read NFD names
 * from disk while Git reports NFC.
 */
import type { GitChange, GitFileStatus, GitStatus } from "./types";

export interface GitDecoration {
  kind: "file" | "directory";
  /** Most significant status (for a directory: across all descendants). */
  status: GitFileStatus;
  /** Short status letter as in `git status --short`: M A D R C T U ? */
  letter: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
  /** 1 for a file; number of changed descendants for a directory. */
  changeCount: number;
  /** The status entry, for files. */
  change?: GitChange;
}

/** Display precedence when one item has several statuses (conflicts first, deletions last). */
const PRIORITY: Readonly<Record<GitFileStatus, number>> = {
  unmerged: 8,
  modified: 7,
  "type-changed": 6,
  renamed: 5,
  copied: 4,
  added: 3,
  untracked: 2,
  deleted: 1,
};

const LETTERS: Readonly<Record<GitFileStatus, string>> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  "type-changed": "T",
  unmerged: "U",
  untracked: "?",
};

export function statusLetter(status: GitFileStatus): string {
  return LETTERS[status];
}

function stronger(a: GitFileStatus | undefined, b: GitFileStatus | undefined): GitFileStatus | undefined {
  if (!a) return b;
  if (!b) return a;
  return PRIORITY[b] > PRIORITY[a] ? b : a;
}

/** The status a single change is displayed with: conflict, else working tree, else index. */
export function displayStatus(change: GitChange): GitFileStatus {
  if (change.conflicted) return "unmerged";
  return change.worktree ?? change.index ?? "modified";
}

function fileDecoration(change: GitChange): GitDecoration {
  const status = displayStatus(change);
  return {
    kind: "file",
    status,
    letter: LETTERS[status],
    staged: !change.conflicted && change.index !== undefined,
    unstaged: !change.conflicted && change.worktree !== undefined && change.worktree !== "untracked",
    untracked: change.worktree === "untracked",
    conflicted: change.conflicted,
    changeCount: 1,
    change,
  };
}

function key(path: string): string {
  return path.normalize("NFC").replace(/\/+$/, "");
}

/** Adds every ancestor directory of `path`, including the root `""`. */
function collectAncestors(path: string, into: Set<string>): void {
  let slash = path.lastIndexOf("/");
  while (slash > 0) {
    into.add(path.slice(0, slash));
    slash = path.lastIndexOf("/", slash - 1);
  }
  into.add("");
}

export class GitDecorationIndex {
  private readonly files = new Map<string, GitDecoration>();
  private readonly directories = new Map<string, GitDecoration>();

  constructor(changes: readonly GitChange[]) {
    for (const change of changes) {
      const file = fileDecoration(change);
      const path = key(change.path);
      this.files.set(path, file);
      const ancestors = new Set<string>();
      collectAncestors(path, ancestors);
      // The source folder of a rename changed too, even though the old path is gone.
      if (change.origPath) collectAncestors(key(change.origPath), ancestors);
      for (const directory of ancestors) this.addToDirectory(directory, file);
    }
  }

  static fromStatus(status: GitStatus | null): GitDecorationIndex {
    return new GitDecorationIndex(status?.changes ?? []);
  }

  private addToDirectory(directory: string, file: GitDecoration): void {
    const existing = this.directories.get(directory);
    if (!existing) {
      this.directories.set(directory, {
        kind: "directory",
        status: file.status,
        letter: file.letter,
        staged: file.staged,
        unstaged: file.unstaged,
        untracked: file.untracked,
        conflicted: file.conflicted,
        changeCount: 1,
      });
      return;
    }
    const status = stronger(existing.status, file.status) ?? file.status;
    existing.status = status;
    existing.letter = LETTERS[status];
    existing.staged ||= file.staged;
    existing.unstaged ||= file.unstaged;
    existing.untracked ||= file.untracked;
    existing.conflicted ||= file.conflicted;
    existing.changeCount++;
  }

  /** Decoration for a repo-relative path (`""` is the repository root). */
  get(repoPath: string): GitDecoration | undefined {
    const path = key(repoPath);
    return this.files.get(path) ?? this.directories.get(path);
  }

  /** Whether a repo-relative directory contains any change. */
  hasChangesUnder(repoPath: string): boolean {
    return this.directories.has(key(repoPath));
  }

  get size(): number {
    return this.files.size;
  }
}
