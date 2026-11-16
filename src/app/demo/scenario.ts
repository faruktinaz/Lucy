/**
 * The demo repository's story, as data: which fixture files each commit introduces, how
 * earlier versions of a file differed from the fixture, and which edits make up the
 * uncommitted working state.
 *
 * The fixture in `examples/demo-project` holds every file as it looks at the tip of
 * `feature/command-palette` (plus the files that stay uncommitted). Earlier versions and
 * working-tree changes are expressed as exact text edits on top of it, so the diffs the
 * demo shows are reviewable here, line by line.
 */
import type { GitIdentity } from "./git";

export interface TextEdit {
  find: string;
  replace: string;
  /** Replace every occurrence instead of exactly one. */
  all?: boolean;
}

/** A file written before staging: the fixture content with `edits` applied, or literal `content`. */
export interface FileVersion {
  path: string;
  edits?: readonly TextEdit[];
  content?: string;
}

export interface CommitStep {
  subject: string;
  body?: string;
  author: "elif" | "jonas";
  date: string;
  files: ReadonlyArray<string | FileVersion>;
}

export interface DemoPerson {
  name: string;
  email: string;
}

export const DEMO_PEOPLE: Readonly<Record<CommitStep["author"], DemoPerson>> = {
  elif: { name: "Elif Aydın", email: "elif@orbit.example" },
  jonas: { name: "Jonas Weber", email: "jonas@orbit.example" },
};

export const DEMO_PROJECT_NAME = "orbit";
export const DEMO_DEFAULT_BRANCH = "main";
export const DEMO_FEATURE_BRANCH = "feature/command-palette";
export const DEMO_CONFLICT_BRANCH = "fix/reload-shortcut";
export const DEMO_REMOTE = "origin";

function lines(...text: string[]): string {
  return `${text.join("\n")}\n`;
}

export function identityFor(author: CommitStep["author"], date: string): GitIdentity {
  return { ...DEMO_PEOPLE[author], date };
}

// ---------------------------------------------------------------------------------------
// Earlier versions of files, as edits that turn the fixture version into the older one.
// ---------------------------------------------------------------------------------------

const packageVersion = (version: string): TextEdit => ({
  find: '"version": "0.3.0"',
  replace: `"version": "${version}"`,
});
const PACKAGE_WITHOUT_TEST: TextEdit = { find: lines('    "test": "bun test",'), replace: "" };
const PACKAGE_WITHOUT_ANALYZE: TextEdit = {
  find: lines(
    '    "typecheck": "tsc --noEmit",',
    '    "analyze": "python3 analysis/task_throughput.py data/sample-tasks.json"',
  ),
  replace: lines('    "typecheck": "tsc --noEmit"'),
};
const PACKAGE_WITHOUT_REACT: TextEdit[] = [
  {
    find: lines('  "dependencies": {', '    "react": "19.1.0",', '    "react-dom": "19.1.0"', "  },"),
    replace: "",
  },
  { find: lines('    "@types/react": "19.1.6",', '    "@types/react-dom": "19.1.5",'), replace: "" },
];

const ROUTES_WITHOUT_RATE_LIMIT: TextEdit[] = [
  { find: lines('      limitGroup: "writes",'), replace: "", all: true },
];

const APP_WITHOUT_RATE_LIMIT: TextEdit[] = [
  { find: lines('import { createRateLimiter } from "./middleware/rate-limit";'), replace: "" },
  {
    find: lines(
      "  /** Name of the rate-limit group in config/limits.toml, if any. */",
      "  limitGroup?: string;",
    ),
    replace: "",
  },
  { find: lines("  const limiter = createRateLimiter(context.config.limits);"), replace: "" },
  { find: lines("        if (route.limitGroup) limiter.check(route.limitGroup, request);"), replace: "" },
];

const CONFIG_WITHOUT_RATE_LIMIT: TextEdit[] = [
  { find: lines('import { readFileSync } from "node:fs";', ""), replace: "" },
  {
    find: lines(
      "export interface RateLimit {",
      "  /** Requests allowed per window. */",
      "  limit: number;",
      "  windowSeconds: number;",
      "}",
      "",
    ),
    replace: "",
  },
  { find: lines("  limits: Record<string, RateLimit>;"), replace: "" },
  {
    find: lines(
      "/** Reads rate limits from TOML. Missing files fall back to no limits at all. */",
      'export function loadLimits(path = "config/limits.toml"): Record<string, RateLimit> {',
      "  let text: string;",
      "  try {",
      '    text = readFileSync(path, "utf8");',
      "  } catch {",
      "    return {};",
      "  }",
      "  const parsed = Bun.TOML.parse(text) as { limits?: Record<string, RateLimit> };",
      "  return parsed.limits ?? {};",
      "}",
      "",
    ),
    replace: "",
  },
  { find: lines("    limits: loadLimits(),"), replace: "" },
];

const APP_YAML_WITHOUT_PALETTE: TextEdit = {
  find: lines("  # Experimental: command palette in the web client (ctrl+k).", "  command_palette: false"),
  replace: "",
};

const APP_TSX_BEFORE_PALETTE: TextEdit[] = [
  {
    find: lines(
      'import { useEffect, useMemo, useState } from "react";',
      'import { createCommands } from "../features/palette/commands";',
      'import { CommandPalette } from "./components/CommandPalette";',
    ),
    replace: lines('import { useEffect, useState } from "react";'),
  },
  { find: '  "ctrl+k": "palette.open",', replace: '  "ctrl+k": "tasks.reload",' },
  {
    find: lines(
      "  const [paletteOpen, setPaletteOpen] = useState(false);",
      "",
      "  const commands = useMemo(",
      "    () => createCommands({ reload, openNoteEditor: () => setEditorOpen(true) }),",
      "    [reload],",
      "  );",
    ),
    replace: "",
  },
  {
    find: '      if (action === "palette.open") setPaletteOpen(true);',
    replace: '      if (action === "tasks.reload") void reload();',
  },
  {
    find: lines(
      "      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}",
    ),
    replace: "",
  },
];

/** The other side of the demo conflict: the same line, changed differently on another branch. */
const APP_TSX_RELOAD_ON_ALT_R: TextEdit[] = [
  ...APP_TSX_BEFORE_PALETTE,
  { find: '  "ctrl+k": "tasks.reload",', replace: '  "alt+r": "tasks.reload",' },
];

const CHANGELOG_BEFORE_PALETTE: TextEdit = {
  find: lines(
    "## [Unreleased]",
    "",
    "### Added",
    "",
    "- Command palette in the web client, opened with `ctrl+k`.",
    "",
  ),
  replace: lines("## [Unreleased]", ""),
};

const README_FIRST_VERSION = lines(
  "# Orbit",
  "",
  "A small, self-hosted service for tasks and the notes that go with them.",
  "",
  "## Development",
  "",
  "```bash",
  "bun install",
  "bun run dev",
  "```",
);

// ---------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------

export const MAIN_COMMITS: readonly CommitStep[] = [
  {
    subject: "chore: scaffold project with Bun and TypeScript",
    author: "elif",
    date: "2026-03-02T09:12:00+03:00",
    files: [
      ".gitignore",
      "LICENSE",
      { path: "README.md", content: README_FIRST_VERSION },
      {
        path: "package.json",
        edits: [
          packageVersion("0.1.0"),
          PACKAGE_WITHOUT_TEST,
          PACKAGE_WITHOUT_ANALYZE,
          ...PACKAGE_WITHOUT_REACT,
        ],
      },
      "tsconfig.json",
    ],
  },
  {
    subject: "feat(server): add task and note API with in-memory stores",
    body: lines(
      "Routes are matched from a small table instead of a framework, so the request",
      "flow stays easy to follow. Stores return copies to keep handlers from mutating",
      "stored records by accident.",
    ),
    author: "jonas",
    date: "2026-03-03T14:40:00+01:00",
    files: [
      ".env.example",
      { path: "config/app.yaml", edits: [APP_YAML_WITHOUT_PALETTE] },
      "data/sample-tasks.json",
      { path: "src/server/app.ts", edits: APP_WITHOUT_RATE_LIMIT },
      { path: "src/server/config.ts", edits: CONFIG_WITHOUT_RATE_LIMIT },
      "src/server/http.ts",
      "src/server/index.ts",
      { path: "src/server/routes/notes.ts", edits: ROUTES_WITHOUT_RATE_LIMIT },
      { path: "src/server/routes/tasks.ts", edits: ROUTES_WITHOUT_RATE_LIMIT },
      "src/server/store/note-store.ts",
      "src/server/store/task-store.ts",
      "src/shared/types.ts",
      "src/shared/validation.ts",
    ],
  },
  {
    subject: "feat(ui): add task list, task item and note editor",
    author: "elif",
    date: "2026-03-05T10:05:00+03:00",
    files: [
      "assets/logo.png",
      {
        path: "package.json",
        edits: [packageVersion("0.1.0"), PACKAGE_WITHOUT_TEST, PACKAGE_WITHOUT_ANALYZE],
      },
      { path: "src/ui/App.tsx", edits: APP_TSX_BEFORE_PALETTE },
      "src/ui/components/NoteEditor.tsx",
      "src/ui/components/TaskItem.tsx",
      "src/ui/components/TaskList.tsx",
      "src/ui/features/notebooks/sidebar/folder-tree/rows/renderers/folder-row-label.tsx",
      "src/ui/hooks/use-tasks.ts",
    ],
  },
  {
    subject: "feat(tools): add orbitctl CLI and weekly throughput report",
    author: "jonas",
    date: "2026-03-09T16:22:00+01:00",
    files: [
      "analysis/__init__.py",
      "analysis/requirements.txt",
      "analysis/task_throughput.py",
      "data/fixtures/tasks.min.json",
      "data/snapshot.bin",
      { path: "package.json", edits: [packageVersion("0.2.0"), PACKAGE_WITHOUT_TEST] },
      "tools/go.mod",
      "tools/orbitctl.go",
    ],
  },
  {
    subject: "ci: add workflow, task store tests and dev scripts",
    author: "elif",
    date: "2026-03-11T11:48:00+03:00",
    files: [
      ".github/workflows/ci.yml",
      { path: "package.json", edits: [packageVersion("0.2.0")] },
      "scripts/dev.sh",
      "scripts/migrate-v1-notes.sh",
      "scripts/release.sh",
      "tests/task-store.test.ts",
    ],
  },
  {
    subject: "feat(server): rate-limit write endpoints",
    body: lines(
      "Limits are read per route group from config/limits.toml. A fixed window is",
      "accurate enough while Orbit runs as a single process.",
    ),
    author: "jonas",
    date: "2026-03-16T09:30:00+01:00",
    files: [
      "config/limits.toml",
      "src/server/app.ts",
      "src/server/config.ts",
      "src/server/middleware/rate-limit.ts",
      "src/server/routes/notes.ts",
      "src/server/routes/tasks.ts",
    ],
  },
  {
    subject: "docs: describe architecture, API and local setup",
    author: "elif",
    date: "2026-03-18T15:05:00+03:00",
    files: [
      { path: "CHANGELOG.md", edits: [CHANGELOG_BEFORE_PALETTE] },
      "README.md",
      "docs/api.md",
      "docs/architecture.md",
      "docs/setup.md",
      "package.json",
    ],
  },
];

/** Branched from `main`; merging it into the feature branch produces the demo conflict. */
export const CONFLICT_BRANCH_COMMIT: CommitStep = {
  subject: "fix(ui): move the reload shortcut off ctrl+k",
  body: lines(
    "Browsers reserve ctrl+k for their own search field, so the shortcut never",
    "reached the app in Firefox.",
  ),
  author: "jonas",
  date: "2026-03-19T10:20:00+01:00",
  files: [{ path: "src/ui/App.tsx", edits: APP_TSX_RELOAD_ON_ALT_R }],
};

/** The first commit is pushed to `origin`; the second is local only, so the branch is ahead by one. */
export const FEATURE_COMMITS: readonly [CommitStep, CommitStep] = [
  {
    subject: "feat(palette): add command registry",
    author: "elif",
    date: "2026-03-20T09:41:00+03:00",
    files: ["src/features/palette/commands.ts"],
  },
  {
    subject: "feat(ui): open a command palette with ctrl+k",
    author: "elif",
    date: "2026-03-23T17:12:00+03:00",
    files: ["CHANGELOG.md", "config/app.yaml", "src/ui/App.tsx", "src/ui/components/CommandPalette.tsx"],
  },
];

export const STASH = {
  message: "experiment: rank recently used commands first",
  author: "elif" as const,
  date: "2026-03-24T10:02:00+03:00",
  path: "src/features/palette/commands.ts",
  edits: [
    {
      find: lines(
        "/** Case-insensitive substring match on titles and keywords, in registration order. */",
        "export function filterCommands(commands: Command[], query: string): Command[] {",
        "  const needle = query.trim().toLowerCase();",
        '  if (needle === "") return commands;',
      ),
      replace: lines(
        "/** Case-insensitive substring match; with an empty query, recently used commands come first. */",
        "export function filterCommands(commands: Command[], query: string, recent: string[] = []): Command[] {",
        "  const needle = query.trim().toLowerCase();",
        '  if (needle === "") {',
        "    const rank = (command: Command) => {",
        "      const index = recent.indexOf(command.id);",
        "      return index === -1 ? recent.length : index;",
        "    };",
        "    return [...commands].sort((a, b) => rank(a) - rank(b));",
        "  }",
      ),
    },
  ] satisfies TextEdit[],
};

export const CONFLICT_MERGE = {
  author: "elif" as const,
  date: "2026-03-24T11:15:00+03:00",
  path: "src/ui/App.tsx",
};

// ---------------------------------------------------------------------------------------
// Working state
// ---------------------------------------------------------------------------------------

/** Fixture files that are never committed: one is staged as new, the rest stay untracked. */
export const STAGED_NEW_FILE = "src/features/palette/fuzzy-match.ts";
export const UNTRACKED_FILES: readonly string[] = [
  "bench/fuzzy-match.bench.ts",
  "docs/çalışma-notları.md",
  "tools/orbitctl_test.go",
];

export const STAGED_EDITS: ReadonlyArray<{ path: string; edits: readonly TextEdit[] }> = [
  {
    path: "package.json",
    edits: [
      packageVersion("0.4.0-dev"),
      {
        find: lines('    "typecheck": "tsc --noEmit",'),
        replace: lines('    "typecheck": "tsc --noEmit",', '    "bench": "bun bench/fuzzy-match.bench.ts",'),
      },
    ],
  },
];

/** Staged first, then edited again, so the file appears in both groups. */
export const STAGED_THEN_MODIFIED = {
  path: "src/ui/components/CommandPalette.tsx",
  staged: [
    {
      find: lines('  const [query, setQuery] = useState("");'),
      replace: lines(
        '  const [query, setQuery] = useState("");',
        "  const [selected, setSelected] = useState(0);",
      ),
    },
    {
      find: lines(
        '    } else if (event.key === "Enter") {',
        "      event.preventDefault();",
        "      runCommand(matches[0]);",
      ),
      replace: lines(
        '    } else if (event.key === "ArrowDown") {',
        "      event.preventDefault();",
        "      setSelected((index) => Math.min(index + 1, matches.length - 1));",
        '    } else if (event.key === "ArrowUp") {',
        "      event.preventDefault();",
        "      setSelected((index) => Math.max(index - 1, 0));",
        '    } else if (event.key === "Enter") {',
        "      event.preventDefault();",
        "      runCommand(matches[selected]);",
      ),
    },
    {
      find: lines("          onChange={(event) => setQuery(event.target.value)}"),
      replace: lines(
        "          onChange={(event) => {",
        "            setQuery(event.target.value);",
        "            setSelected(0);",
        "          }}",
      ),
    },
    {
      find: lines("              aria-selected={index === 0}"),
      replace: lines(
        "              aria-selected={index === selected}",
        "              onMouseEnter={() => setSelected(index)}",
      ),
    },
  ] satisfies TextEdit[],
  unstaged: [
    { find: 'placeholder="Type a command…"', replace: 'placeholder="Search commands…"' },
  ] satisfies TextEdit[],
};

export const STAGED_RENAME = { from: "docs/setup.md", to: "docs/getting-started.md" };

export const UNSTAGED_DELETION = "scripts/migrate-v1-notes.sh";

// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source text that contains a template literal.
const THROW_UNKNOWN_STATUS = '    throw new HttpError(400, "invalid_filter", `Unknown status "${value}"`);';

export const UNSTAGED_EDITS: ReadonlyArray<{ path: string; edits: readonly TextEdit[] }> = [
  {
    // Several hunks: an edit near the top, an added helper, a changed call and a removed block.
    path: "src/server/routes/tasks.ts",
    edits: [
      {
        find: lines("const DEFAULT_PAGE_SIZE = 50;"),
        replace: lines("const DEFAULT_PAGE_SIZE = 25;", "const MAX_PAGE_SIZE = 100;"),
      },
      {
        find: "filter.status = normalizeStatus(status);",
        replace: "filter.status = parseStatus(status);",
      },
      {
        find: lines("  return filter;", "}", ""),
        replace: lines(
          "  return filter;",
          "}",
          "",
          "function parseLimit(url: URL): number {",
          '  const raw = url.searchParams.get("limit");',
          "  if (raw === null) return DEFAULT_PAGE_SIZE;",
          "  const limit = Number.parseInt(raw, 10);",
          "  if (!Number.isInteger(limit) || limit < 1) {",
          '    throw new HttpError(400, "invalid_limit", "limit must be a positive integer");',
          "  }",
          "  return Math.min(limit, MAX_PAGE_SIZE);",
          "}",
          "",
        ),
      },
      {
        find: "cursor, DEFAULT_PAGE_SIZE));",
        replace: "cursor, parseLimit(url)));",
      },
      {
        find: lines(
          "/**",
          " * Clients older than 0.2 sent `open` and `closed`. Keep accepting them until",
          " * orbitctl and the browser extension have both shipped the new names.",
          " */",
          "const LEGACY_STATUS_ALIASES: Record<string, TaskStatus> = {",
          '  open: "todo",',
          '  closed: "done",',
          "};",
          "",
          "function normalizeStatus(value: string): TaskStatus {",
          "  const status = LEGACY_STATUS_ALIASES[value] ?? value;",
          "  if (!TASK_STATUSES.includes(status as TaskStatus)) {",
          THROW_UNKNOWN_STATUS,
          "  }",
          "  return status as TaskStatus;",
          "}",
        ),
        replace: lines(
          "function parseStatus(value: string): TaskStatus {",
          "  if (!TASK_STATUSES.includes(value as TaskStatus)) {",
          THROW_UNKNOWN_STATUS,
          "  }",
          "  return value as TaskStatus;",
          "}",
        ),
      },
    ],
  },
  {
    // The tiny change: a single flag flipped.
    path: "config/app.yaml",
    edits: [{ find: "  command_palette: false", replace: "  command_palette: true" }],
  },
  {
    path: "src/ui/components/TaskList.tsx",
    edits: [
      {
        find: lines(
          'const PRIORITY_ORDER: Record<Task["priority"], number> = { high: 0, normal: 1, low: 2 };',
        ),
        replace: lines(
          'const PRIORITY_ORDER: Record<Task["priority"], number> = { high: 0, normal: 1, low: 2 };',
          "",
          "const EMPTY_MESSAGES: Record<View, string> = {",
          '  open: "Nothing left to do.",',
          '  done: "No completed tasks yet.",',
          '  all: "No tasks yet.",',
          "};",
        ),
      },
      {
        find: lines(
          "      <ul>",
          "        {visible.map((task) => (",
          "          <TaskItem key={task.id} task={task} onStatusChange={onStatusChange} />",
          "        ))}",
          "      </ul>",
        ),
        replace: lines(
          "      {visible.length === 0 ? (",
          '        <p className="task-list__empty">{EMPTY_MESSAGES[view]}</p>',
          "      ) : (",
          "        <ul>",
          "          {visible.map((task) => (",
          "            <TaskItem key={task.id} task={task} onStatusChange={onStatusChange} />",
          "          ))}",
          "        </ul>",
          "      )}",
        ),
      },
    ],
  },
];

// ---------------------------------------------------------------------------------------
// Description of the resulting state, for UI tests and the screenshot script
// ---------------------------------------------------------------------------------------

export type DemoChangeKind = "modified" | "added" | "deleted" | "renamed";

export interface DemoChange {
  path: string;
  kind: DemoChangeKind;
  /** Previous path, for renames. */
  from?: string;
}

export interface DemoWorkspaceDescription {
  projectName: string;
  defaultBranch: string;
  head: {
    branch: string;
    upstream: string;
    ahead: number;
    behind: number;
  };
  /** Local branches, sorted. */
  branches: string[];
  /** Remote-tracking branches, sorted, e.g. `origin/main`. */
  remoteBranches: string[];
  /** Commit subjects reachable from HEAD, newest first. */
  headCommitSubjects: string[];
  /** Number of commits on `main`. */
  mainCommitCount: number;
  /** Stash entries as `git stash list --format=%gs` prints them, newest first. */
  stashes: string[];
  changes: {
    /** Index against HEAD, sorted by path. */
    staged: DemoChange[];
    /** Work tree against index, sorted by path. */
    unstaged: DemoChange[];
    /** Untracked entries as Git lists them by default (a new directory appears once, with a trailing slash). */
    untracked: string[];
    /** Every untracked file, as `--untracked-files=all` lists them. */
    untrackedFiles: string[];
    /** Paths with unresolved conflicts. */
    conflicted: string[];
  };
  merge: { inProgress: boolean; branch: string | null };
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Parent directories of a path, outermost first: `a/b/c.ts` gives `a`, `a/b`. */
function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

function untrackedEntries(files: readonly string[]): string[] {
  // Git reports a file inside a directory with nothing tracked as that directory, once.
  const indexed = [...MAIN_COMMITS, ...FEATURE_COMMITS]
    .flatMap((step) => step.files.map((file) => (typeof file === "string" ? file : file.path)))
    .concat(STAGED_NEW_FILE);
  const indexedDirs = new Set(indexed.flatMap(ancestors));
  const entries = files.map((file) => {
    const firstUntrackedDir = ancestors(file).find((dir) => !indexedDirs.has(dir));
    return firstUntrackedDir === undefined ? file : `${firstUntrackedDir}/`;
  });
  return [...new Set(entries)].sort();
}

/** What a build with the given options produces; derived from the scenario above, not from Git. */
export function describeDemoWorkspace(options: { withConflict?: boolean } = {}): DemoWorkspaceDescription {
  const withConflict = options.withConflict ?? false;
  const staged: DemoChange[] = [
    ...STAGED_EDITS.map((entry) => ({ path: entry.path, kind: "modified" as const })),
    { path: STAGED_NEW_FILE, kind: "added" },
    { path: STAGED_THEN_MODIFIED.path, kind: "modified" },
    { path: STAGED_RENAME.to, kind: "renamed", from: STAGED_RENAME.from },
  ];
  const unstaged: DemoChange[] = [
    ...UNSTAGED_EDITS.map((entry) => ({ path: entry.path, kind: "modified" as const })),
    { path: STAGED_THEN_MODIFIED.path, kind: "modified" },
    { path: UNSTAGED_DELETION, kind: "deleted" },
  ];
  const headCommits = [...MAIN_COMMITS, ...FEATURE_COMMITS].map((step) => step.subject).reverse();

  return {
    projectName: DEMO_PROJECT_NAME,
    defaultBranch: DEMO_DEFAULT_BRANCH,
    head: {
      branch: DEMO_FEATURE_BRANCH,
      upstream: `${DEMO_REMOTE}/${DEMO_FEATURE_BRANCH}`,
      ahead: 1,
      behind: 0,
    },
    branches: [DEMO_FEATURE_BRANCH, DEMO_CONFLICT_BRANCH, DEMO_DEFAULT_BRANCH].sort(),
    remoteBranches: [`${DEMO_REMOTE}/${DEMO_FEATURE_BRANCH}`, `${DEMO_REMOTE}/${DEMO_DEFAULT_BRANCH}`].sort(),
    headCommitSubjects: headCommits,
    mainCommitCount: MAIN_COMMITS.length,
    stashes: [`On ${DEMO_FEATURE_BRANCH}: ${STASH.message}`],
    changes: {
      staged: staged.sort(byPath),
      unstaged: unstaged.sort(byPath),
      untracked: untrackedEntries(UNTRACKED_FILES),
      untrackedFiles: [...UNTRACKED_FILES].sort(),
      conflicted: withConflict ? [CONFLICT_MERGE.path] : [],
    },
    merge: { inProgress: withConflict, branch: withConflict ? DEMO_CONFLICT_BRANCH : null },
  };
}
