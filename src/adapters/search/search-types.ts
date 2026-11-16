/**
 * Shapes shared by every content-search engine. All engines report the same match shape.
 */
import { LucyError } from "@/core/errors";

export type SearchEngineName = "ripgrep" | "git-grep" | "builtin";

/** "smart": case-insensitive unless the pattern contains an uppercase letter. */
export type CaseMode = "sensitive" | "insensitive" | "smart";

export interface ContentSearchQuery {
  readonly pattern: string;
  /** Default false: the pattern is a literal string. */
  readonly isRegex?: boolean;
  /** Default "smart". */
  readonly caseMode?: CaseMode;
  readonly wholeWord?: boolean;
  /**
   * Globs relative to the workspace root, `.gitignore`-style: without "/" they match a name
   * at any depth ("*.ts", "node_modules"); with a "/" inside or at the start they match from
   * the root ("src/**", "/build").
   * A glob naming a folder includes or excludes everything inside it.
   */
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  /** Matching lines reported at most. Default 2000. */
  readonly maxResults?: number;
}

/** Half-open UTF-16 range `[start, end)` within `SearchMatch.lineText`. */
export interface MatchRange {
  readonly start: number;
  readonly end: number;
}

/** One matching line. */
export interface SearchMatch {
  /** Workspace-relative POSIX path. */
  readonly path: string;
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column of the first match, in UTF-16 code units of the original line (JS string index + 1). */
  readonly column: number;
  /**
   * Display-safe excerpt of the line (control characters replaced, tabs expanded, leading
   * indentation removed), at most about 500 characters around the first match.
   */
  readonly lineText: string;
  /** Every match on the line that falls inside `lineText`. */
  readonly ranges: readonly MatchRange[];
  /** UTF-16 offset in the original line where `lineText` starts. */
  readonly lineTextStart: number;
  /** Content before `lineText` was cut (show an ellipsis). */
  readonly clippedStart: boolean;
  /** Content after `lineText` was cut (show an ellipsis). */
  readonly clippedEnd: boolean;
}

/**
 * Why a result is incomplete.
 * - `max-results`: more matching lines exist than `maxResults`.
 * - `time-budget`: a per-file or overall time budget (or the engine timeout) stopped the scan.
 * - `file-list`: the file list the builtin engine searched was itself cut short.
 * - `long-line`: an output line was longer than `maxLineBytes`: git grep matches show the cut
 *   line, a ripgrep match record that was cut cannot be decoded and is left out.
 */
export type SearchLimitHit = "max-results" | "time-budget" | "file-list" | "long-line";

/** Resource limits of the process-based engines (ripgrep, git grep). */
export interface SearchLimits {
  /**
   * Files larger than this many bytes are not searched. ripgrep skips them itself
   * (`--max-filesize`); for git grep the size is checked when a file first appears in the output
   * and its matches are dropped. Like binary files, skipped files are not reported. Default 16 MiB.
   */
  readonly maxFileBytes: number;
  /**
   * Longest engine output line kept in memory, in bytes (see `StreamOptions.maxLineBytes`).
   * Longer lines are cut and reported as `long-line`. Default 1 MiB.
   */
  readonly maxLineBytes: number;
}

export const DEFAULT_SEARCH_LIMITS: SearchLimits = {
  maxFileBytes: 16 * 1024 * 1024,
  maxLineBytes: 1024 * 1024,
};

export interface SearchSummary {
  readonly engine: SearchEngineName;
  /** Matching lines delivered through `onMatches`. */
  readonly matchCount: number;
  /** Files with at least one delivered match. */
  readonly fileCount: number;
  /** Stopped early or incomplete: see `limitsHit` for the reasons. */
  readonly truncated: boolean;
  /** Every limit that made the result incomplete (empty when `truncated` is false). */
  readonly limitsHit?: readonly SearchLimitHit[];
  readonly durationMs: number;
}

export interface SearchCallbacks {
  /** Batches of matches, grouped by file, in arrival order. Never called after the search settles. */
  onMatches(matches: readonly SearchMatch[]): void;
}

/** The pattern is not a valid regular expression for the engine that ran it. */
export class InvalidPatternError extends LucyError {
  readonly pattern: string;
  readonly reason: string;

  constructor(pattern: string, reason: string, cause?: unknown) {
    super("INVALID_ARGUMENT", `Invalid regular expression: ${reason}`, {
      cause,
      details: { kind: "invalid-pattern", reason },
    });
    this.name = "InvalidPatternError";
    this.pattern = pattern;
    this.reason = reason;
  }
}

export function isInvalidPatternError(error: unknown): error is InvalidPatternError {
  return error instanceof InvalidPatternError;
}
