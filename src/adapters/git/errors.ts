/**
 * Typed Git failures.
 *
 * Every failure carries `details.kind` so the UI can react precisely (offer "Publish branch" on
 * `no-upstream`, retry on `index-locked`, ...). Classification is best effort: Git's messages are
 * forced to English (see `environment.ts`) but are not a stable API, so unknown output degrades to
 * `"failed"` with the trimmed stderr attached rather than to a wrong specific kind.
 */
import { isLucyError, LucyError, type LucyErrorCode } from "@/core/errors";

export type GitFailureKind =
  | "git-missing"
  | "git-too-old"
  | "not-a-repository"
  | "unsafe-repository"
  | "bare-repository"
  | "invalid-argument"
  | "invalid-ref-name"
  | "empty-message"
  | "discard-blocked"
  | "index-locked"
  | "nothing-to-commit"
  | "identity-missing"
  | "signing-failed"
  | "conflicts"
  | "would-overwrite"
  | "not-fast-forward"
  | "rejected"
  | "no-upstream"
  | "auth-required"
  | "network"
  | "timeout"
  | "cancelled"
  | "failed";

export interface GitFailureDetails {
  kind: GitFailureKind;
  /** Trimmed and length-capped. */
  stderr: string;
  /** Trimmed and length-capped. Git prints some failures (e.g. "nothing to commit") on stdout. */
  stdout: string;
  exitCode: number | null;
  /** Git arguments after the fixed safety flags. Never contains commit messages or credentials. */
  args: string[];
  /** Repeating the same call later may succeed. */
  retryable: boolean;
}

const MAX_CAPTURED = 8 * 1024;

const RETRYABLE: ReadonlySet<GitFailureKind> = new Set(["index-locked", "timeout", "network"]);

/** Ordered: the first match wins, so more specific patterns come first. */
const PATTERNS: ReadonlyArray<readonly [GitFailureKind, RegExp]> = [
  ["unsafe-repository", /detected dubious ownership/i],
  ["not-a-repository", /not a git repository/i],
  ["bare-repository", /must be run in a work tree/i],
  [
    "index-locked",
    /index\.lock'?: File exists|Unable to create '[^']*\.lock'|Another git process seems to be running/i,
  ],
  ["identity-missing", /Please tell me who you are|Author identity unknown|empty ident name/i],
  ["signing-failed", /gpg failed to sign|failed to sign the data|signing failed|Couldn't sign/i],
  [
    "would-overwrite",
    /would be overwritten by|Please commit your changes or stash them|untracked working tree files would be (?:overwritten|removed)/i,
  ],
  [
    "conflicts",
    /CONFLICT \(|Merge conflict in|unmerged files|you need to resolve your current index first|fix conflicts and then|have unmerged paths|unresolved conflict/i,
  ],
  // After would-overwrite/conflicts: stash and pull failures print a status listing that
  // contains "no changes added to commit".
  [
    "nothing-to-commit",
    /nothing to commit|no changes added to commit|nothing added to commit|nothing \(?(?:to commit|added)/i,
  ],
  [
    "not-fast-forward",
    /Not possible to fast-forward|cannot be fast-forwarded|divergent branches|Diverging branches can't be fast-forwarded/i,
  ],
  ["no-upstream", /has no upstream branch|no tracking information|no upstream configured/i],
  [
    "auth-required",
    /terminal prompts disabled|could not read (?:Username|Password)|Authentication failed|Permission denied \((?:publickey|password|keyboard-interactive)|Host key verification failed|HTTP Basic: Access denied|Invalid username or password|unable to read askpass response|returned error: 40[13]|denied to |access denied|requested URL returned error: 403/i,
  ],
  ["rejected", /\[rejected\]|\[remote rejected\]|Updates were rejected|failed to push some refs/i],
  [
    "network",
    /Could not resolve host|Connection refused|Connection timed out|Network is unreachable|Operation timed out|Could not read from remote repository|unable to access '|Connection reset|early EOF|RPC failed/i,
  ],
];

/** Picks the most specific failure kind for Git output (stderr and stdout combined). */
export function classifyGitFailure(output: string): GitFailureKind {
  for (const [kind, pattern] of PATTERNS) {
    if (pattern.test(output)) return kind;
  }
  return "failed";
}

function cap(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_CAPTURED ? `${trimmed.slice(0, MAX_CAPTURED)}…` : trimmed;
}

const FRIENDLY: Partial<Record<GitFailureKind, string>> = {
  "index-locked":
    "Another Git process is using this repository (index.lock exists). Try again in a moment; if it persists, remove the stale lock file.",
  "nothing-to-commit": "There are no staged changes to commit.",
  "identity-missing":
    "Git does not know who you are. Set user.name and user.email in your Git configuration.",
  "auth-required":
    "Authentication is required. Lucy never prompts for credentials: configure a credential helper or SSH agent, or run the command in a terminal.",
  "no-upstream": "The current branch has no upstream branch.",
  "not-fast-forward": "The branches have diverged and cannot be fast-forwarded.",
  rejected: "The remote rejected the push. Pull or fetch first, then try again.",
};

/** First line of Git output worth showing, without `fatal:`/`error:` prefixes and hints. */
export function summarizeGitOutput(text: string): string {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || /^hint:/i.test(line)) continue;
    return line.replace(/^(?:fatal|error|warning):\s*/i, "");
  }
  return "";
}

export interface GitFailureInput {
  args: readonly string[];
  exitCode: number | null;
  stderr: string;
  stdout: string;
  /** Overrides classification. */
  kind?: GitFailureKind;
  message?: string;
}

function codeFor(kind: GitFailureKind): LucyErrorCode {
  switch (kind) {
    case "not-a-repository":
      return "NOT_A_REPOSITORY";
    case "bare-repository":
      return "UNSUPPORTED";
    case "invalid-argument":
    case "invalid-ref-name":
    case "empty-message":
    case "discard-blocked":
      return "INVALID_ARGUMENT";
    case "timeout":
      return "TIMEOUT";
    case "cancelled":
      return "CANCELLED";
    default:
      return "GIT_FAILED";
  }
}

/** Builds the `LucyError` for a failed Git command. */
export function gitFailure(input: GitFailureInput): LucyError {
  const kind = input.kind ?? classifyGitFailure(`${input.stderr}\n${input.stdout}`);
  const stderr = cap(input.stderr);
  const stdout = cap(input.stdout);
  const message =
    input.message ??
    FRIENDLY[kind] ??
    (summarizeGitOutput(stderr) ||
      summarizeGitOutput(stdout) ||
      `git ${input.args[0] ?? ""} failed (exit ${input.exitCode ?? "signal"})`);
  const details: GitFailureDetails = {
    kind,
    stderr,
    stdout,
    exitCode: input.exitCode,
    args: [...input.args],
    retryable: RETRYABLE.has(kind),
  };
  return new LucyError(codeFor(kind), message, { details: { ...details } });
}

/** A validation or precondition failure that never reached Git. */
export function gitPrecondition(
  kind: GitFailureKind,
  message: string,
  extra?: Record<string, unknown>,
): LucyError {
  return new LucyError(codeFor(kind), message, {
    details: { kind, retryable: false, ...extra },
  });
}

/** The Git failure kind of any thrown value, or `null` when it is not a Git failure. */
export function gitFailureKind(error: unknown): GitFailureKind | null {
  if (!isLucyError(error)) return null;
  const kind = error.details?.kind;
  return typeof kind === "string" ? (kind as GitFailureKind) : null;
}

export function isGitFailure(error: unknown, kind?: GitFailureKind): error is LucyError {
  const actual = gitFailureKind(error);
  return actual !== null && (kind === undefined || actual === kind);
}

/** Whether repeating the failed call later may succeed (index lock contention, timeouts, network). */
export function isRetryableGitFailure(error: unknown): boolean {
  return isLucyError(error) && error.details?.retryable === true;
}
