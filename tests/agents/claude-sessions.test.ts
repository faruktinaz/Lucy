import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeProvider, encodeClaudeProjectDirName, listClaudeSessions } from "@/adapters/agents";

// Synthetic transcripts only: the real ~/.claude is never touched by tests.
let root: string;
let projectsDir: string;
let workspace: string;
let realWorkspace: string;

const ids = {
  aiTitle: "11111111-1111-4111-8111-111111111111",
  customTitle: "22222222-2222-4222-8222-222222222222",
  summary: "33333333-3333-4333-8333-333333333333",
  promptOnly: "44444444-4444-4444-8444-444444444444",
  otherCwd: "55555555-5555-4555-8555-555555555555",
  garbage: "66666666-6666-4666-8666-666666666666",
  large: "77777777-7777-4777-8777-777777777777",
  messy: "88888888-8888-4888-8888-888888888888",
};

function jsonl(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function user(cwd: string, content: unknown, timestamp: string, extra: Record<string, unknown> = {}) {
  return { type: "user", cwd, timestamp, isSidechain: false, message: { role: "user", content }, ...extra };
}

function assistant(cwd: string, timestamp: string) {
  return {
    type: "assistant",
    cwd,
    timestamp,
    isSidechain: false,
    message: { role: "assistant", content: [] },
  };
}

function write(dir: string, id: string, body: string, mtime: number): void {
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, body);
  utimesSync(path, mtime / 1000, mtime / 1000);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lucy-sessions-"));
  projectsDir = join(root, "projects");
  workspace = join(root, "my project");
  mkdirSync(workspace, { recursive: true });
  // Claude records the resolved path (on macOS /var/... resolves to /private/var/...).
  realWorkspace = realpathSync(workspace);
  const dir = join(projectsDir, encodeClaudeProjectDirName(realWorkspace));
  mkdirSync(dir, { recursive: true });
  const cwd = realWorkspace;
  const base = Date.parse("2026-11-01T10:00:00.000Z");

  write(
    dir,
    ids.aiTitle,
    jsonl([
      { type: "permission-mode", permissionMode: "default", sessionId: ids.aiTitle },
      user(cwd, "first question about the parser", "2026-11-01T10:00:00.000Z"),
      assistant(cwd, "2026-11-01T10:00:05.000Z"),
      { type: "ai-title", aiTitle: "Parser refactor", sessionId: ids.aiTitle },
      user(cwd, [{ type: "tool_result", content: "x" }], "2026-11-05T09:00:00.000Z"),
    ]),
    base,
  );
  write(
    dir,
    ids.customTitle,
    jsonl([
      user(cwd, "hello", "2026-11-02T10:00:00.000Z"),
      { type: "ai-title", aiTitle: "Generated", sessionId: ids.customTitle },
      { type: "custom-title", customTitle: "My named session", sessionId: ids.customTitle },
    ]),
    base,
  );
  write(
    dir,
    ids.summary,
    jsonl([
      { type: "summary", summary: "Old-format summary", leafUuid: "x" },
      user(cwd, "q", "2026-10-01T10:00:00.000Z"),
    ]),
    base,
  );
  write(
    dir,
    ids.promptOnly,
    jsonl([
      user(cwd, "Caveat: meta", "2026-11-03T10:00:00.000Z", { isMeta: true }),
      user(
        cwd,
        [{ type: "text", text: "<command-name>/review</command-name><command-args>PR 12</command-args>" }],
        "2026-11-03T10:00:01.000Z",
      ),
    ]),
    base,
  );
  // Same encoded directory, different real path ("my-project" vs "my project"): must be excluded.
  write(
    dir,
    ids.otherCwd,
    jsonl([user(join(root, "my-project"), "not mine", "2026-11-04T10:00:00.000Z")]),
    base,
  );
  write(dir, ids.garbage, "this is not json\n{also not\n", base);
  // Larger than the head+tail window: the title comes from the tail, the message count is unknown.
  const filler = Array.from({ length: 3000 }, (_, i) =>
    assistant(cwd, `2026-11-06T10:${String(i % 60).padStart(2, "0")}:00.000Z`),
  );
  write(
    dir,
    ids.large,
    jsonl([
      user(cwd, "start of a long session", "2026-11-06T09:00:00.000Z"),
      ...filler,
      { type: "ai-title", aiTitle: "Long session title", sessionId: ids.large },
      assistant(cwd, "2026-11-06T23:59:00.000Z"),
    ]),
    base,
  );
  write(
    dir,
    ids.messy,
    jsonl([
      user(
        cwd,
        `  multi\nline\tprompt \u001b[31mwith escapes‮ and a very long tail ${"x".repeat(200)}`,
        "2026-10-15T10:00:00.000Z",
      ),
    ]),
    base,
  );
  writeFileSync(join(dir, "agent-abc.jsonl"), jsonl([user(cwd, "sidechain", "2026-11-09T10:00:00.000Z")]));
  mkdirSync(join(dir, ids.aiTitle, "subagents"), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("listClaudeSessions", () => {
  test("encodes the cwd like Claude Code", () => {
    expect(encodeClaudeProjectDirName("/Users/dev/Projects/my workspace")).toBe(
      "-Users-dev-Projects-my-workspace",
    );
  });

  test("lists sessions for the workspace, newest first, with derived titles", async () => {
    const listing = await listClaudeSessions(workspace, { projectsDir });
    const byId = new Map(listing.sessions.map((session) => [session.id, session]));
    expect(listing.sessions.map((session) => session.id)).toEqual([
      ids.large,
      ids.aiTitle,
      ids.promptOnly,
      ids.customTitle,
      ids.messy,
      ids.summary,
    ]);
    expect(byId.get(ids.aiTitle)).toEqual({
      id: ids.aiTitle,
      title: "Parser refactor",
      updatedAt: Date.parse("2026-11-05T09:00:00.000Z"),
      messageCount: 3,
    });
    expect(byId.get(ids.customTitle)?.title).toBe("My named session");
    expect(byId.get(ids.summary)?.title).toBe("Old-format summary");
    expect(byId.get(ids.promptOnly)?.title).toBe("/review PR 12");
    expect(byId.get(ids.large)?.title).toBe("Long session title");
    expect(byId.get(ids.large)?.messageCount).toBeUndefined();
    expect(byId.has(ids.otherCwd)).toBe(false);
    expect(listing.problem).toContain("could not be read");
  });

  test("titles are one sanitized, truncated line", async () => {
    const listing = await listClaudeSessions(workspace, { projectsDir });
    const title = listing.sessions.find((session) => session.id === ids.messy)?.title ?? "";
    expect(title.startsWith("multi line prompt")).toBe(true);
    for (const unsafe of ["\n", "\t", "\u001b", "\u202e"]) expect(title.includes(unsafe)).toBe(false);
    expect(Bun.stringWidth(title)).toBeLessThanOrEqual(80);
  });

  test("respects the limit", async () => {
    const listing = await listClaudeSessions(workspace, { projectsDir, limit: 2 });
    expect(listing.sessions.map((session) => session.id)).toEqual([ids.large, ids.aiTitle]);
  });

  test("a symlinked workspace path finds the same sessions", async () => {
    const link = join(root, "link-to-project");
    symlinkSync(workspace, link);
    const listing = await listClaudeSessions(link, { projectsDir, limit: 1 });
    expect(listing.sessions[0]?.id).toBe(ids.large);
  });

  test("missing directories give an empty list and a problem, never a throw", async () => {
    const noProjects = await listClaudeSessions(workspace, { projectsDir: join(root, "missing") });
    expect(noProjects.sessions).toEqual([]);
    expect(noProjects.problem).toContain("does not exist");
    const otherFolder = await listClaudeSessions(join(root, "never-used"), { projectsDir });
    expect(otherFolder.sessions).toEqual([]);
    expect(otherFolder.problem).toContain("No Claude Code sessions");
  });

  test("the provider exposes discovery with an injectable directory", async () => {
    const provider = createClaudeProvider({ projectsDir });
    const listing = await provider.listSessions?.(workspace, { limit: 1 });
    expect(listing?.sessions.map((session) => session.id)).toEqual([ids.large]);
  });
});
