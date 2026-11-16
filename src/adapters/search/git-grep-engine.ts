/**
 * Content search with `git grep` (inside a repository when ripgrep is absent): tracked and
 * untracked-but-not-ignored files, binaries skipped (`-I`), streamed and killed once the cap
 * is exceeded.
 *
 * Dialect: literal searches use `-F`; regex searches use `-P` (PCRE2, closest to JavaScript)
 * and fall back to `-E` (POSIX extended) when Git was built without PCRE. Highlight ranges
 * are recomputed with the JavaScript matcher; if it disagrees with Git on a line (a dialect
 * difference), the match keeps Git's column with an empty range.
 * Case-insensitive matching folds non-ASCII letters ("ĞÜŞ" finds "ğüş") in a UTF-8 locale,
 * which is enforced; ASCII "i" does not match "İ" or "ı". `-w` uses Git's byte-oriented word
 * characters (ASCII letters, digits, "_"), so non-ASCII letters count as word boundaries.
 *
 * Git runs with the Git adapter's read-only hardening (`readOnlyGitInvocation`) in a detached
 * session. git grep has no size or line-length option, so the limits are enforced while parsing:
 * an output line above `maxLineBytes` is cut by `runStreaming` (the match is kept, its preview
 * comes from the cut text, and the summary reports `long-line`), and a file above
 * `maxFileBytes` (checked with `lstat` when it first appears in the output) is dropped.
 */

import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { GitEnv } from "@/adapters/filesystem/git-probe";
import { readOnlyGitInvocation } from "@/adapters/git/environment";
import { LucyError } from "@/core/errors";
import { runStreaming } from "@/core/process";
import { type CompiledQuery, findRanges, requireRegex } from "./compile-query";
import { buildMatch, utf8ToUtf16Offsets } from "./line-preview";
import type { MatchSink } from "./match-sink";
import { SEARCH_TIMEOUT_MS } from "./ripgrep-engine";
import {
  DEFAULT_SEARCH_LIMITS,
  InvalidPatternError,
  type SearchLimits,
  type SearchMatch,
} from "./search-types";

const FLUSH_EVERY = 200;

/** Remembers per process whether `git grep -P` works, to avoid a failing spawn per search. */
export interface GitGrepCapabilities {
  pcre?: boolean;
}

function utf8Env(env: GitEnv | undefined): GitEnv {
  const merged = { ...process.env, ...env };
  const locale = merged.LC_ALL || merged.LC_CTYPE || merged.LANG || "";
  if (/utf-?8/i.test(locale)) return { ...env };
  // Without a UTF-8 locale Git treats patterns as bytes: -i and -P would not fold "Ğ".
  return { ...env, LC_ALL: undefined, LC_CTYPE: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8" };
}

/** The `git grep` arguments after the adapter's base flags (see `readOnlyGitInvocation`). */
export function gitGrepArgs(query: CompiledQuery, usePcre: boolean): string[] {
  const args = [
    "-c",
    "grep.fullName=false",
    "grep",
    "-z",
    "-n",
    "--column",
    "-I",
    "--untracked",
    "--no-color",
  ];
  if (!query.caseSensitive) args.push("-i");
  if (query.wholeWord) args.push("-w");
  args.push(query.isRegex ? (usePcre ? "-P" : "-E") : "-F");
  args.push("-e", query.pattern, "--");
  for (const glob of query.include) args.push(`:(glob)${glob}`);
  for (const glob of query.exclude) args.push(`:(glob,exclude)${glob}`);
  return args;
}

/** Whether the working-tree file is within `maxBytes` (Git reports it, so a failing stat keeps it). */
function withinSize(root: string, path: string, maxBytes: number): boolean {
  try {
    // lstat: Git searches a tracked symlink's target text, never the file it points to.
    return lstatSync(join(root, path)).size <= maxBytes;
  } catch {
    return true;
  }
}

/** Parses `path\0line\0column\0text`; `null` when the record is incomplete. */
function parseRecord(line: string): { path: string; line: number; column: number; text: string } | null {
  const first = line.indexOf("\0");
  const second = first === -1 ? -1 : line.indexOf("\0", first + 1);
  const third = second === -1 ? -1 : line.indexOf("\0", second + 1);
  if (third === -1) return null;
  const lineNumber = Number(line.slice(first + 1, second));
  const column = Number(line.slice(second + 1, third));
  if (!Number.isInteger(lineNumber) || !Number.isInteger(column)) return null;
  return { path: line.slice(0, first), line: lineNumber, column, text: line.slice(third + 1) };
}

async function runOnce(
  root: string,
  query: CompiledQuery,
  usePcre: boolean,
  sink: MatchSink,
  signal: AbortSignal,
  env: GitEnv | undefined,
  limits: SearchLimits,
): Promise<{ code: number | null; stderr: string; stopped: boolean; timedOut: boolean }> {
  const regex = requireRegex(query);
  let buffer: SearchMatch[] = [];
  let currentPath: string | null = null;
  let currentAllowed = true;
  let carry = "";
  let stop = false;
  let kill: (() => void) | null = null;
  const flush = (): void => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    if (!sink.push(batch) && !stop) {
      stop = true;
      kill?.();
    }
  };
  const onLine = (line: string, truncated: boolean): void => {
    if (stop) return;
    // A file name containing "\n" splits one record over two lines: glue them back.
    const joined = carry === "" ? line : `${carry}\n${line}`;
    const parsed = parseRecord(joined);
    if (!parsed) {
      carry = joined.length < 8192 && !truncated ? joined : "";
      return;
    }
    carry = "";
    if (parsed.path !== currentPath) {
      flush();
      currentPath = parsed.path;
      currentAllowed = withinSize(root, parsed.path, limits.maxFileBytes);
    }
    if (!currentAllowed) return;
    if (truncated) sink.markTruncated("long-line");
    let ranges = findRanges(regex, parsed.text, 100);
    if (ranges.length === 0) {
      const start = utf8ToUtf16Offsets(parsed.text, [Math.max(0, parsed.column - 1)])[0] ?? 0;
      ranges = [[start, start]];
    }
    const match = buildMatch(parsed.path, parsed.line, parsed.text, ranges);
    if (match) buffer.push(match);
    if (buffer.length >= FLUSH_EVERY || buffer.length > sink.remaining) flush();
  };
  const call = readOnlyGitInvocation(gitGrepArgs(query, usePcre), utf8Env(env));
  const handle = runStreaming(call.argv, {
    cwd: root,
    env: call.env,
    detached: call.detached,
    signal,
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxLineBytes: limits.maxLineBytes,
    onLine,
  });
  kill = handle.kill;
  const result = await handle.done;
  flush();
  return { code: result.code, stderr: result.stderr, stopped: stop, timedOut: result.timedOut };
}

export async function searchWithGitGrep(
  root: string,
  query: CompiledQuery,
  sink: MatchSink,
  signal: AbortSignal,
  env: GitEnv | undefined,
  capabilities: GitGrepCapabilities,
  limits: SearchLimits = DEFAULT_SEARCH_LIMITS,
): Promise<void> {
  const usePcre = query.isRegex && capabilities.pcre !== false;
  let result = await runOnce(root, query, usePcre, sink, signal, env, limits);
  if (result.stopped || signal.aborted) return;
  if (usePcre && result.code === 128 && /perl-compatible|USE_LIBPCRE|not compiled/i.test(result.stderr)) {
    capabilities.pcre = false;
    result = await runOnce(root, query, false, sink, signal, env, limits);
    if (result.stopped || signal.aborted) return;
  } else if (usePcre && result.code !== 128) {
    capabilities.pcre = true;
  }
  if (result.timedOut) {
    sink.markTruncated("time-budget");
    return;
  }
  if (result.code === 0 || result.code === 1) return;
  const message = result.stderr.trim().split("\n")[0] ?? "";
  if (
    query.isRegex &&
    /regex|pattern|parenthes|bracket|repetition|unmatched|invalid|pcre2?_compile|quantifier/i.test(message)
  ) {
    throw new InvalidPatternError(query.pattern, message.replace(/^fatal:\s*/, ""));
  }
  throw new LucyError("GIT_FAILED", "git grep failed", {
    details: { code: result.code, stderr: result.stderr.slice(0, 500) },
  });
}
