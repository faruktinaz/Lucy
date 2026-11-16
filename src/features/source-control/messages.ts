/**
 * Toast wording for Git results. Success says what happened in a few words; failure says what
 * went wrong in Git's own terms (already summarized by the Git layer) and, for the failures
 * users hit most, what to do next.
 */
import { gitFailureKind } from "@/adapters/git";
import { errorMessage } from "@/core/errors";

/** Next steps for the failures that have an obvious remedy. */
const REMEDIES: Partial<Record<string, string>> = {
  "would-overwrite": "Commit or stash your changes first.",
  conflicts: "Resolve the conflicts, stage the files, then commit.",
  "not-fast-forward": "The branches have diverged; merge or rebase in a terminal.",
  rejected: "Pull to integrate the remote changes, then push again.",
  "index-locked": "Another Git command is running. Try again in a moment.",
  network: "Check your network connection and try again.",
  timeout: "The network timeout is set in Settings (git.networkTimeoutSeconds).",
};

/** One readable paragraph for a failed Git call. */
export function describeFailure(error: unknown): string {
  const message = errorMessage(error).trim();
  const kind = gitFailureKind(error);
  const remedy = kind ? REMEDIES[kind] : undefined;
  if (!remedy || message.includes(remedy)) return message;
  return message ? `${message} ${remedy}` : remedy;
}

/** Short commit id plus subject, trimmed for a toast. */
export function commitSummary(shortOid: string, summary: string): string {
  const subject = summary.length > 60 ? `${summary.slice(0, 59)}…` : summary;
  return `${shortOid} ${subject}`;
}
