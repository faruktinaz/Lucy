/**
 * Per-workspace restore state (open files, layout, drafts), validated leniently: a bad field
 * falls back to its default and a bad list item is dropped, so one damaged value never costs
 * the user the rest of their session. Every stored file path must be workspace-relative
 * (POSIX, no leading slash, no `.` or `..` segments) so a tampered state file cannot point
 * the app outside the project.
 */
import { z } from "zod";

export const WORKSPACE_STATE_VERSION = 1;

export const STATE_LIMITS = {
  openFiles: 50,
  recentFiles: 50,
  commandMru: 30,
  expandedPaths: 1000,
  searchQueryLength: 1000,
  commitDraftLength: 20_000,
  pathLength: 4096,
} as const;

/** True for a safe workspace-relative POSIX path such as `src/app/main.ts`. */
export function isWorkspaceRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > STATE_LIMITS.pathLength) return false;
  if (value.includes("\0") || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) {
    return false;
  }
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const relativePath = z.string().refine(isWorkspaceRelativePath, "must be a workspace-relative path");

/** Validates items one by one, drops invalid ones and duplicates, and caps the length. */
function lenientList<T>(item: z.ZodType<T>, max: number, identity: (value: T) => string) {
  return z
    .array(z.unknown())
    .catch([])
    .transform((items) => {
      const seen = new Set<string>();
      const out: T[] = [];
      for (const raw of items) {
        const parsed = item.safeParse(raw);
        if (!parsed.success) continue;
        const id = identity(parsed.data);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(parsed.data);
        if (out.length >= max) break;
      }
      return out;
    });
}

const viewStateSchema = z.object({
  scrollTop: z.number().int().min(0).catch(0),
  cursorLine: z.number().int().min(0).optional().catch(undefined),
  cursorColumn: z.number().int().min(0).optional().catch(undefined),
});

const openFileSchema = z.object({
  path: relativePath,
  kind: z.enum(["file", "diff"]).catch("file"),
  pinned: z.boolean().catch(false),
  /** For diffs: compare the index (staged) instead of the working tree. */
  staged: z.boolean().optional().catch(undefined),
  viewState: viewStateSchema.optional().catch(undefined),
});

export type OpenFileState = z.infer<typeof openFileSchema>;

/** Over-long text is clipped rather than discarded: a long commit draft is still worth keeping. */
function clippedText(max: number) {
  return z
    .string()
    .catch("")
    .transform((text) => text.slice(0, max));
}

const width = z.number().int().min(1).max(1000).nullable().catch(null);

const layoutSchema = z.object({
  sidebar: z
    .object({
      visible: z.boolean().catch(true),
      view: z.enum(["explorer", "search", "scm"]).catch("explorer"),
      /** Columns; `null` uses the configured default. */
      width,
    })
    .catch({ visible: true, view: "explorer", width: null }),
  aiPanel: z.object({ visible: z.boolean().catch(false), width }).catch({ visible: false, width: null }),
  bottomPanel: z
    .object({
      visible: z.boolean().catch(false),
      height: width,
      tab: z.string().max(64).catch("terminal"),
    })
    .catch({ visible: false, height: null, tab: "terminal" }),
  zen: z.boolean().catch(false),
});

export type WorkspaceLayoutState = z.infer<typeof layoutSchema>;

/** A tmux session name of Lucy's private server (`lucy-<workspace>-t3`). */
const sessionName = z.string().regex(/^lucy-[A-Za-z0-9_-]{1,160}$/);

/**
 * Persistent terminal and agent sessions (terminal.persistence), so they come back after a
 * restart even when the tmux server is gone (a reboot). Added after version 1 shipped: older
 * files have no `sessions` and get empty lists. The working directory is stored relative to
 * the workspace (null: the root, or a directory outside it), like every other stored path.
 */
const sessionsSchema = z.object({
  terminals: lenientList(
    z.object({
      name: sessionName,
      number: z.number().int().min(1).max(100_000),
      cwd: relativePath.nullable().catch(null),
    }),
    20,
    (t) => t.name,
  ),
  agents: lenientList(
    z.object({
      name: sessionName,
      title: clippedText(200),
      providerId: z.string().max(64).catch("claude"),
      createdAt: z.number().int().min(0).catch(0),
    }),
    20,
    (a) => a.name,
  ),
});

export type WorkspaceSessionsState = z.infer<typeof sessionsSchema>;

export const workspaceStateSchema = z.object({
  version: z.number().int().catch(WORKSPACE_STATE_VERSION),
  openFiles: lenientList(
    openFileSchema,
    STATE_LIMITS.openFiles,
    (f) => `${f.kind}:${f.staged === true}:${f.path}`,
  ),
  activeFile: relativePath.nullable().catch(null),
  layout: layoutSchema.catch(() => defaultLayout()),
  explorer: z
    .object({
      expanded: lenientList(relativePath, STATE_LIMITS.expandedPaths, (p) => p),
      /** The selected explorer entry (optional: older state files do not have it). */
      selected: relativePath.optional().catch(undefined),
    })
    .catch({ expanded: [] }),
  search: z.object({ query: clippedText(STATE_LIMITS.searchQueryLength) }).catch({ query: "" }),
  commandMru: lenientList(
    z.string().regex(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/),
    STATE_LIMITS.commandMru,
    (id) => id,
  ),
  recentFiles: lenientList(relativePath, STATE_LIMITS.recentFiles, (p) => p),
  /** The unsent commit message. */
  commitDraft: clippedText(STATE_LIMITS.commitDraftLength),
  sessions: sessionsSchema.catch({ terminals: [], agents: [] }),
  updatedAt: z.string().max(64).catch(""),
});

export type WorkspaceState = z.infer<typeof workspaceStateSchema>;

function defaultLayout(): WorkspaceLayoutState {
  return {
    sidebar: { visible: true, view: "explorer", width: null },
    aiPanel: { visible: false, width: null },
    bottomPanel: { visible: false, height: null, tab: "terminal" },
    zen: false,
  };
}

export function defaultWorkspaceState(): WorkspaceState {
  return {
    version: WORKSPACE_STATE_VERSION,
    openFiles: [],
    activeFile: null,
    layout: defaultLayout(),
    explorer: { expanded: [] },
    search: { query: "" },
    commandMru: [],
    recentFiles: [],
    commitDraft: "",
    sessions: { terminals: [], agents: [] },
    updatedAt: "",
  };
}

/**
 * Lenient validation of anything that claims to be workspace state. Never throws: invalid
 * fields take their defaults, invalid list items are dropped, lists are capped.
 */
export function normalizeWorkspaceState(input: unknown): WorkspaceState {
  const source = input !== null && typeof input === "object" && !Array.isArray(input) ? input : {};
  const parsed = workspaceStateSchema.safeParse(source);
  return parsed.success ? parsed.data : defaultWorkspaceState();
}
