/**
 * Commit box rules, as a pure function of the inputs, so every rule is unit-testable.
 *
 * VS Code-like behavior when nothing is staged: the button still says "Commit" and is enabled
 * if there are unstaged or untracked changes, but pressing it never commits directly; it asks
 * for confirmation to stage everything first (`action: "stage-all-and-commit"`). With no changes
 * at all the button reads "Nothing to commit". Unresolved conflicts disable committing, because
 * Git refuses to commit unmerged files. During a merge, committing with nothing staged is allowed
 * (it concludes the merge).
 */
import type { GitOperation } from "@/adapters/git";

export const COMMIT_SUBJECT_SOFT_LIMIT = 72;

export type CommitAction = "commit" | "stage-all-and-commit" | "none";

export interface CommitButton {
  readonly label: string;
  readonly enabled: boolean;
  readonly action: CommitAction;
  /** Why the button is disabled, for a tooltip or status line. */
  readonly reason: string | null;
}

export interface CommitBoxState {
  readonly message: string;
  readonly amend: boolean;
  /** Amend needs an existing commit. */
  readonly canAmend: boolean;
  /** Length of the first line, in characters. */
  readonly subjectLength: number;
  /** A gentle hint (long subject, nothing staged); never blocks committing. */
  readonly hint: string | null;
  readonly button: CommitButton;
  /** A commit (or any Git operation) is running. */
  readonly busy: boolean;
}

export interface CommitBoxInput {
  message: string;
  amend: boolean;
  canAmend: boolean;
  repositoryReady: boolean;
  staged: number;
  /** Unstaged plus untracked changes. */
  unstaged: number;
  conflicts: number;
  operation: GitOperation | null;
  /** A commit initiated from the box is running. */
  committing: boolean;
  /** Any other Git operation is running. */
  busy: boolean;
}

function subjectOf(message: string): string {
  const newline = message.indexOf("\n");
  return (newline === -1 ? message : message.slice(0, newline)).replace(/\r$/, "");
}

export function computeCommitBox(input: CommitBoxInput): CommitBoxState {
  const subjectLength = [...subjectOf(input.message)].length;
  const hasMessage = input.message.trim().length > 0;
  let hint: string | null =
    subjectLength > COMMIT_SUBJECT_SOFT_LIMIT
      ? `The subject line has ${subjectLength} characters; ${COMMIT_SUBJECT_SOFT_LIMIT} or fewer is conventional.`
      : null;

  const base = input.amend ? "Commit (amend)" : "Commit";
  const button = (
    action: CommitAction,
    enabled: boolean,
    reason: string | null,
    label = base,
  ): CommitButton => ({
    label,
    enabled,
    action,
    reason,
  });

  let result: CommitButton;
  if (input.committing) {
    result = button("none", false, "A commit is in progress.", "Committing…");
  } else if (input.busy) {
    result = button("none", false, "Another Git operation is running.");
  } else if (!input.repositoryReady) {
    result = button("none", false, "There is no Git repository.");
  } else if (input.conflicts > 0) {
    result = button("none", false, "Resolve all merge conflicts before committing.");
  } else if (input.amend) {
    if (!input.canAmend) result = button("none", false, "There is no commit to amend yet.");
    else if (!hasMessage) result = button("none", false, "Enter a commit message.");
    else result = button("commit", true, null);
  } else if (input.staged > 0 || input.operation === "merge") {
    result = hasMessage ? button("commit", true, null) : button("none", false, "Enter a commit message.");
  } else if (input.unstaged > 0) {
    hint ??= "Nothing is staged. Committing will ask to stage all changes first.";
    result = hasMessage
      ? button("stage-all-and-commit", true, null)
      : button("none", false, "Enter a commit message.");
  } else {
    result = button("none", false, "There are no changes to commit.", "Nothing to commit");
  }

  return {
    message: input.message,
    amend: input.amend,
    canAmend: input.canAmend,
    subjectLength,
    hint,
    button: result,
    busy: input.committing || input.busy,
  };
}
