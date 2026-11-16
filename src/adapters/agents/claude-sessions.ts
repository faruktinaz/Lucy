/**
 * Read-only, best-effort discovery of previous Claude Code sessions for a workspace.
 *
 * WARNING: this relies on Claude Code's undocumented on-disk format, observed with version
 * 2.1.325. It may change without notice, so every step tolerates surprises and degrades to an
 * empty list plus a `problem` text instead of failing. Nothing here ever writes to that directory.
 *
 * Observed format:
 * - `<config>/projects/<encoded-cwd>/<session-uuid>.jsonl`, where `<config>` is `$CLAUDE_CONFIG_DIR`
 *   or `~/.claude`, and the cwd is encoded by replacing every character outside `[A-Za-z0-9]` with
 *   "-". The encoding is lossy ("/a b" and "/a-b" collide), so the `cwd` recorded inside the file is
 *   checked as well. Claude records the real path (`/private/var/...` on macOS), so both the given
 *   and the resolved path are tried.
 * - One JSON object per line with a `type`: `user` / `assistant` / `system` records carry `cwd`,
 *   ISO `timestamp`, `isSidechain`, `isMeta`, and `message.content` (a string or content blocks).
 *   Metadata records include `ai-title` (`aiTitle`), `custom-title` (`customTitle`), `summary`
 *   (`summary`, older versions) and `last-prompt` (`lastPrompt`).
 * - Subagent transcripts live in `<session-uuid>/` subdirectories and are ignored.
 *
 * Transcripts can be tens of megabytes, so only the first and last chunk of each file is read.
 * Contents are used only to derive a one-line title and are never logged or stored.
 */
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { errorMessage } from "@/core/errors";
import { sanitizeForDisplay, truncateEnd } from "@/core/text";
import type { AgentSessionListing, AgentSessionSummary } from "./agent-provider";

export interface ListClaudeSessionsOptions {
  /** Maximum sessions returned, most recent first. Default 20, at most 200. */
  limit?: number;
  /** The `projects` directory. Defaults to `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`. */
  projectsDir?: string;
}

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 128 * 1024;
const TITLE_WIDTH = 80;
const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const LONG_NAME = 200;
const BATCH = 8;

/** Claude Code's directory name for a working directory. */
export function encodeClaudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function defaultClaudeProjectsDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  const base = configured && isAbsolute(configured) ? configured : join(env.HOME || homedir(), ".claude");
  return join(base, "projects");
}

interface Candidate {
  id: string;
  path: string;
  size: number;
  mtimeMs: number;
}

type ParsedSession =
  | { kind: "ok"; summary: AgentSessionSummary }
  | { kind: "other-cwd" }
  | { kind: "unreadable" };

function record(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** The human-written text of a user record, or null for tool results and meta messages. */
function promptText(entry: Record<string, unknown>): string | null {
  if (entry.isMeta === true || entry.isSidechain === true) return null;
  const message = entry.message as { role?: unknown; content?: unknown } | undefined;
  if (!message || typeof message !== "object") return null;
  let content: string | null = null;
  if (typeof message.content === "string") content = message.content;
  else if (Array.isArray(message.content)) {
    for (const block of message.content as unknown[]) {
      const candidate = block as { type?: unknown; text?: unknown } | null;
      if (candidate?.type === "text" && typeof candidate.text === "string") {
        content = candidate.text;
        break;
      }
    }
  }
  if (!content) return null;
  const trimmed = content.trim();
  const command = /<command-name>([^<]*)<\/command-name>/.exec(trimmed);
  if (command) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(trimmed)?.[1] ?? "";
    return `${command[1]} ${args}`.trim() || null;
  }
  // Wrapped system content (`<local-command-stdout>`, `<system-reminder>`, caveats) is not a prompt.
  if (trimmed.startsWith("<") || trimmed.startsWith("Caveat:")) return null;
  return trimmed;
}

function oneLine(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return truncateEnd(sanitizeForDisplay(flat), TITLE_WIDTH);
}

async function readLines(candidate: Candidate): Promise<{ lines: string[]; complete: boolean }> {
  const handle = await open(candidate.path, "r");
  try {
    if (candidate.size <= HEAD_BYTES + TAIL_BYTES) {
      const buffer = Buffer.alloc(candidate.size);
      await handle.read(buffer, 0, candidate.size, 0);
      return { lines: buffer.toString("utf8").split("\n"), complete: true };
    }
    const head = Buffer.alloc(HEAD_BYTES);
    await handle.read(head, 0, HEAD_BYTES, 0);
    const tail = Buffer.alloc(TAIL_BYTES);
    await handle.read(tail, 0, TAIL_BYTES, candidate.size - TAIL_BYTES);
    // Drop the partial line at each cut.
    const headLines = head.toString("utf8").split("\n").slice(0, -1);
    const tailLines = tail.toString("utf8").split("\n").slice(1);
    return { lines: [...headLines, ...tailLines], complete: false };
  } finally {
    await handle.close();
  }
}

async function parseSession(candidate: Candidate, cwds: ReadonlySet<string>): Promise<ParsedSession> {
  let lines: string[];
  let complete: boolean;
  try {
    ({ lines, complete } = await readLines(candidate));
  } catch {
    return { kind: "unreadable" };
  }
  let recognized = 0;
  let cwd: string | null = null;
  let latest = Number.NaN;
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let summary: string | null = null;
  let firstPrompt: string | null = null;
  let lastPrompt: string | null = null;
  let messages = 0;
  for (const line of lines) {
    if (!line) continue;
    const entry = record(line);
    if (!entry || typeof entry.type !== "string") continue;
    recognized++;
    cwd ??= text(entry.cwd);
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
    if (Number.isFinite(at) && (Number.isNaN(latest) || at > latest)) latest = at;
    switch (entry.type) {
      case "custom-title":
        customTitle = text(entry.customTitle) ?? customTitle;
        break;
      case "ai-title":
        aiTitle = text(entry.aiTitle) ?? aiTitle;
        break;
      case "summary":
        summary = text(entry.summary) ?? summary;
        break;
      case "last-prompt":
        lastPrompt = text(entry.lastPrompt) ?? lastPrompt;
        break;
      case "user":
        firstPrompt ??= promptText(entry);
        if (entry.isSidechain !== true && entry.isMeta !== true) messages++;
        break;
      case "assistant":
        if (entry.isSidechain !== true) messages++;
        break;
      default:
    }
  }
  if (recognized === 0) return { kind: "unreadable" };
  if (cwd !== null && !cwds.has(cwd)) return { kind: "other-cwd" };
  const title = customTitle ?? aiTitle ?? summary ?? firstPrompt ?? lastPrompt;
  return {
    kind: "ok",
    summary: {
      id: candidate.id,
      title: title ? oneLine(title) : "Untitled session",
      updatedAt: Number.isFinite(latest) ? latest : candidate.mtimeMs,
      ...(complete ? { messageCount: messages } : {}),
    },
  };
}

async function candidatesIn(dir: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const name of await readdir(dir)) {
    const match = SESSION_FILE.exec(name);
    if (!match?.[1]) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (info.isFile()) out.push({ id: match[1], path, size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // Deleted while listing: skip.
    }
  }
  return out;
}

/**
 * Lists previous Claude Code sessions for `cwd`, most recent first. Never throws: problems are
 * reported in `problem` alongside whatever could be read.
 */
export async function listClaudeSessions(
  cwd: string,
  options: ListClaudeSessionsOptions = {},
): Promise<AgentSessionListing> {
  const projectsDir = options.projectsDir ?? defaultClaudeProjectsDir();
  const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 20)));
  const cwds = new Set([resolve(cwd)]);
  try {
    cwds.add(await realpath(cwd));
  } catch {
    // The workspace may not exist any more; the lexical path still identifies its sessions.
  }

  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return {
      sessions: [],
      problem:
        code === "ENOENT"
          ? `No Claude Code sessions recorded yet (${projectsDir} does not exist).`
          : `Could not read Claude Code sessions: ${errorMessage(error)}`,
    };
  }

  const encoded = [...cwds].map(encodeClaudeProjectDirName);
  const dirs = entries.filter((entry) =>
    encoded.some(
      (name) => entry === name || (name.length > LONG_NAME && entry.startsWith(name.slice(0, LONG_NAME))),
    ),
  );
  if (dirs.length === 0)
    return { sessions: [], problem: "No Claude Code sessions recorded for this folder yet." };

  const candidates: Candidate[] = [];
  let problem: string | null = null;
  for (const dir of dirs) {
    try {
      candidates.push(...(await candidatesIn(join(projectsDir, dir))));
    } catch (error) {
      problem = `Could not read Claude Code sessions: ${errorMessage(error)}`;
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const sessions: AgentSessionSummary[] = [];
  let unreadable = 0;
  for (let i = 0; i < candidates.length && sessions.length < limit; i += BATCH) {
    const parsed = await Promise.all(
      candidates.slice(i, i + BATCH).map((candidate) => parseSession(candidate, cwds)),
    );
    for (const result of parsed) {
      if (result.kind === "ok") sessions.push(result.summary);
      else if (result.kind === "unreadable") unreadable++;
    }
  }
  if (unreadable > 0) {
    problem ??= `${unreadable} session file${unreadable === 1 ? "" : "s"} could not be read; Claude Code's transcript format may have changed.`;
  }
  if (sessions.length === 0 && problem === null)
    problem = "No Claude Code sessions recorded for this folder yet.";
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return { sessions: sessions.slice(0, limit), problem };
}
