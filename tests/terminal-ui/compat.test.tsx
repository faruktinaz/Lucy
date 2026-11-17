/**
 * Files written by the previous version (shapes as of commit 01b9c96, before session
 * persistence) load in this version without losing layout, tabs, explorer state or settings.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configFilePath } from "@/core/config/load";
import { normalizeWorkspaceState, resolveWorkspace } from "@/core/workspace";
import { workspaceStatePath } from "@/core/workspace/state-store";
import { createTestDirs, mountApp } from "../helpers/app";

/** A state file exactly as 01b9c96 wrote it: version 1, no `sessions`. */
const OLD_STATE = {
  version: 1,
  openFiles: [
    { path: "src/main.ts", kind: "file", pinned: false, viewState: { scrollTop: 3 } },
    { path: "README.md", kind: "file", pinned: true },
  ],
  activeFile: "README.md",
  layout: {
    sidebar: { visible: true, view: "explorer", width: 41 },
    aiPanel: { visible: false, width: 70 },
    bottomPanel: { visible: true, height: 9, tab: "terminal" },
    zen: false,
  },
  explorer: { expanded: ["src", "docs"], selected: "src/main.ts" },
  search: { query: "todo" },
  commandMru: ["file.quickOpen", "view.toggleZenMode"],
  recentFiles: ["src/main.ts"],
  commitDraft: "wip: keep this message",
  updatedAt: "2026-11-16T10:00:00.000Z",
};

/** Settings that existed in 01b9c96 (no terminal.persistence yet), with their snake_case TOML keys. */
const OLD_CONFIG = `[ui]
theme = "high-contrast"
density = "compact"

[layout]
sidebar_width = 41
bottom_panel_height = 9

[editor]
wrap = true

[git]
auto_refresh = false

[ai]
args = ["--model", "opus"]
on_panel_close = "ask"

[terminal]
shell = "/bin/zsh"
scrollback = 8000
`;

test("the previous version's state and config load without losing anything", async () => {
  const root = mkdtempSync(join(process.env.LUCY_TEST_ROOT ?? tmpdir(), "compat-"));
  for (const path of ["src/main.ts", "README.md", "docs/guide.md"]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `// ${path}\n`);
  }
  const dirs = createTestDirs();
  const { workspace } = await resolveWorkspace(root, root);
  const statePath = workspaceStatePath(dirs, workspace.id);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(OLD_STATE));
  writeFileSync(configFilePath(dirs), OLD_CONFIG);

  // The schema alone: every old field survives; the new slice gets its default.
  const normalized = normalizeWorkspaceState(OLD_STATE);
  const { sessions: _sessions, ...oldFields } = normalized;
  expect(oldFields as unknown).toEqual(OLD_STATE);
  expect(normalized.sessions).toEqual({ terminals: [], agents: [] });

  const { ctx } = await mountApp({ workspace: { root }, dirs });
  expect(ctx.config.get("ui.theme")).toBe("high-contrast");
  expect(ctx.config.get("ui.density")).toBe("compact");
  expect(ctx.config.get("editor.wrap")).toBe(true);
  expect(ctx.config.get("git.autoRefresh")).toBe(false);
  expect(ctx.config.get("ai.args")).toEqual(["--model", "opus"]);
  expect(ctx.config.get("ai.onPanelClose")).toBe("ask");
  expect(ctx.config.get("terminal.scrollback")).toBe(8000);
  expect(ctx.config.get("terminal.persistence")).toBe("auto");
  expect(ctx.layout.state.sidebar.width).toBe(41);
  expect(ctx.layout.state.bottom).toMatchObject({ visible: true, height: 9, tab: "terminal" });
  expect(ctx.editors.tabs.map((tab) => tab.resource)).toEqual(["src/main.ts", "README.md"]);
  expect(ctx.editors.active?.resource).toBe("README.md");
  expect(ctx.persisted.state.explorer).toEqual({ expanded: ["src", "docs"], selected: "src/main.ts" });
  expect(ctx.persisted.state.commitDraft).toBe("wip: keep this message");
  expect(ctx.persisted.state.sessions).toEqual({ terminals: [], agents: [] });
});
