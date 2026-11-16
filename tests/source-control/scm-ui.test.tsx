/**
 * Source Control UI against `MockGitAdapter`: navigation, stage/unstage keys and hover actions,
 * discard confirmation, commit box rules, error toasts, branch picker, push confirmation, and
 * text snapshots at 120x35 and 90x28.
 */
import { describe, expect, test } from "bun:test";
import type { GitChange, MockGitAdapterOptions } from "@/adapters/git";
import { LucyError } from "@/core/errors";
import { mountApp } from "../helpers/app";

const CHANGES: GitChange[] = [
  { path: "src/app/main.ts", index: "modified", conflicted: false },
  { path: "README.md", worktree: "modified", conflicted: false },
  { path: "docs/old.md", worktree: "deleted", conflicted: false },
  { path: "notes/todo.txt", worktree: "untracked", conflicted: false },
];

const PATCH = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1,3 +1,3 @@ Intro",
  " # Orbit",
  "-Old line",
  "+New line",
  " end",
  "",
].join("\n");

function gitOptions(extra: Partial<MockGitAdapterOptions> = {}): MockGitAdapterOptions {
  return {
    changes: CHANGES,
    branch: { name: "main", upstream: "origin/main", ahead: 2, behind: 0 },
    ...extra,
  };
}

async function mountScm(options: { width?: number; height?: number; git?: MockGitAdapterOptions } = {}) {
  const mounted = await mountApp({
    width: options.width,
    height: options.height,
    git: options.git ?? gitOptions(),
  });
  await mounted.tui.act(() => mounted.ctx.commands.execute("view.showSourceControl"));
  await mounted.tui.act(() => mounted.ctx.services.git.refresh());
  await mounted.tui.waitForText(/CHANGES|UNTRACKED|No changes/);
  return mounted;
}

describe("Source Control panel", () => {
  test("groups, letters and the activity badge", async () => {
    const { tui } = await mountScm();
    const frame = tui.frame();
    for (const text of [
      "STAGED CHANGES",
      "CHANGES",
      "UNTRACKED",
      "main.ts",
      "README.md",
      "old.md",
      "todo.txt",
    ]) {
      expect(frame).toContain(text);
    }
    expect(frame).toMatch(/README\.md.*M/);
    expect(frame).toMatch(/todo\.txt.*U/);
    expect(frame).toContain("Message (");
  });

  test("keyboard: arrows select, s stages, u unstages, Space opens a preview diff", async () => {
    const { tui, ctx, git } = await mountScm();
    if (!git) throw new Error("mock git");
    git.setDiff({ path: "README.md" }, { patch: PATCH });
    await tui.act(() => ctx.focus.focus("sidebar"));
    // Rows: STAGED, main.ts, CHANGES, README.md, ...
    await tui.press("down");
    await tui.press("down");
    await tui.press("down");
    await tui.press("down");
    await tui.press("s");
    await tui.waitForText("Staged README.md");
    expect(git.calls.find((call) => call.method === "stage")?.args).toEqual([["README.md"]]);
    expect(ctx.services.git.state.status?.staged.map((change) => change.path).sort()).toEqual([
      "README.md",
      "src/app/main.ts",
    ]);
    await tui.press("home");
    await tui.press("down");
    await tui.press("u");
    await tui.waitForText("Unstaged");
    expect(git.calls.find((call) => call.method === "unstage")?.args).toEqual([["src/app/main.ts"]]);
    // README.md is now the first staged row; Space opens its staged diff as a preview.
    git.setDiff({ path: "README.md", staged: true }, { patch: PATCH });
    await tui.press("home");
    await tui.press("down");
    await tui.press("space");
    await tui.waitForText("@@ -1,3 +1,3 @@");
    expect(ctx.editors.active).toMatchObject({ kind: "diff", preview: true, params: { staged: true } });
  });

  test("hover actions stage a file", async () => {
    const { tui, git } = await mountScm();
    const position = tui.findText("README.md");
    if (!position || !git) throw new Error("row not found");
    await tui.hover(position.x, position.y);
    const row = tui.frame().split("\n")[position.y] ?? "";
    // Hover actions appear between the name and the status letter; "+" is Stage.
    const plus = row.indexOf("+", position.x);
    expect(plus).toBeGreaterThan(position.x);
    expect(row.indexOf("M", plus)).toBeGreaterThan(plus);
    await tui.click(plus, position.y);
    await tui.waitForText("Staged README.md");
    expect(git.calls.find((call) => call.method === "stage")?.args).toEqual([["README.md"]]);
  });

  test("discard asks first; Cancel is the default and changes nothing", async () => {
    const { tui, ctx, git } = await mountScm();
    if (!git) throw new Error("mock git");
    await tui.act(() => ctx.focus.focus("sidebar"));
    await tui.clickText("README.md");
    await tui.act(() => ctx.focus.focus("sidebar"));
    await tui.press("d");
    await tui.waitForText('Discard changes in "README.md"?');
    expect(ctx.dialogs.request?.danger).toBe(true);
    await tui.press("enter");
    await tui.settle();
    expect(ctx.dialogs.request).toBeNull();
    expect(git.callCount("discard")).toBe(0);

    await tui.press("d");
    await tui.waitForText("Discard Changes");
    await tui.act(() => ctx.dialogs.activate("confirm"));
    await tui.waitForText("Changes discarded");
    expect(git.calls.find((call) => call.method === "discard")?.args).toEqual([["README.md"]]);
  });

  test("commit box: empty message is blocked; Ctrl+Enter commits, clears the box and refreshes", async () => {
    const { tui, ctx, git } = await mountScm();
    if (!git) throw new Error("mock git");
    await tui.act(() => ctx.commands.execute("git.commit"));
    await tui.waitForText("Enter a commit message");
    expect(git.callCount("commit")).toBe(0);

    await tui.act(() => ctx.commands.execute("git.focusCommitInput"));
    await tui.type("Add the thing");
    expect(ctx.persisted.state.commitDraft).toBe("Add the thing");
    await tui.press("ctrl+enter");
    await tui.waitForText("Committed");
    expect(git.calls.find((call) => call.method === "commit")?.args).toEqual([
      { message: "Add the thing", amend: false },
    ]);
    await tui.waitForText(/^(?![\s\S]*STAGED CHANGES)/);
    // The box is empty again (the placeholder shows); the toast names the commit.
    expect(tui.frame()).toContain("Message (");
    expect(tui.frame()).toContain("Add the thing on main");
    expect(ctx.persisted.state.commitDraft).toBe("");
  });

  test("amend fills in the previous message and restores the draft when turned off", async () => {
    const { tui, ctx, git } = await mountScm();
    if (!git) throw new Error("mock git");
    git.setLog([
      {
        oid: "a".repeat(40),
        shortOid: "aaaaaaa",
        parents: [],
        subject: "Previous subject",
        body: "",
        authorName: "A",
        authorEmail: "a@example.invalid",
        authorDate: "2026-01-01T00:00:00Z",
        refs: [],
      },
    ]);
    await tui.act(() => ctx.commands.execute("git.focusCommitInput"));
    await tui.type("my draft");
    await tui.clickText("Amend");
    await tui.waitForText("Previous subject");
    expect(tui.frame()).toContain("Commit (amend)");
    await tui.clickText("Amend");
    await tui.waitForText("my draft");
  });

  test("nothing staged: Commit asks to stage everything first", async () => {
    const { tui, ctx, git } = await mountScm({
      git: gitOptions({ changes: [{ path: "README.md", worktree: "modified", conflicted: false }] }),
    });
    if (!git) throw new Error("mock git");
    await tui.waitForText("CHANGES");
    await tui.act(() => ctx.commands.execute("git.focusCommitInput"));
    await tui.type("All of it");
    await tui.act(() => {
      void ctx.commands.execute("git.commit");
    });
    await tui.waitForText("Stage All & Commit");
    expect(git.callCount("commit")).toBe(0);
    await tui.act(() => ctx.dialogs.activate("confirm"));
    await tui.waitForText("Committed");
    expect(git.calls.map((call) => call.method).filter((m) => m === "stageAll" || m === "commit")).toEqual([
      "stageAll",
      "commit",
    ]);
  });

  test("a failed commit is a readable error toast and keeps the message", async () => {
    const { tui, ctx, git } = await mountScm();
    if (!git) throw new Error("mock git");
    git.failNext(
      "commit",
      new LucyError("GIT_FAILED", "lint failed: missing semicolon", { details: { kind: "failed" } }),
    );
    await tui.act(() => ctx.commands.execute("git.focusCommitInput"));
    await tui.type("Broken");
    await tui.press("ctrl+enter");
    await tui.waitForText("Commit failed");
    expect(tui.frame()).toContain("lint failed: missing semicolon");
    expect(ctx.persisted.state.commitDraft).toBe("Broken");
  });

  test("branch picker switches branches", async () => {
    const { tui, ctx, git } = await mountScm();
    if (!git) throw new Error("mock git");
    git.setBranches([
      { name: "main", ref: "refs/heads/main", kind: "local", oid: "1".repeat(40), isCurrent: true },
      {
        name: "feature/x",
        ref: "refs/heads/feature/x",
        kind: "local",
        oid: "2".repeat(40),
        isCurrent: false,
      },
    ]);
    await tui.act(() => {
      void ctx.commands.execute("git.checkout");
    });
    await tui.waitForText("Create new branch");
    expect(tui.frame()).toContain("feature/x");
    await tui.type("feature");
    await tui.press("enter");
    await tui.waitForText("Switched to feature/x");
    expect(git.calls.find((call) => call.method === "switchBranch")?.args).toEqual(["feature/x"]);
  });

  test("create branch validates the name before Git sees it", async () => {
    const { tui, ctx, git } = await mountScm();
    if (!git) throw new Error("mock git");
    await tui.act(() => {
      void ctx.commands.execute("git.createBranch");
    });
    await tui.waitForText("Create Branch");
    await tui.type("bad name");
    await tui.press("enter");
    await tui.waitForText("Spaces and control characters are not allowed");
    expect(git.callCount("createBranch")).toBe(0);
  });

  test("push asks for confirmation and never forces", async () => {
    const { tui, ctx, git } = await mountScm();
    if (!git) throw new Error("mock git");
    await tui.act(() => {
      void ctx.commands.execute("git.push");
    });
    await tui.waitForText("Push to origin/main?");
    await tui.act(() => ctx.dialogs.activate("confirm"));
    await tui.waitForText("Pushed to origin/main");
    expect(git.calls.find((call) => call.method === "push")?.args).toEqual([{ timeoutMs: 60_000 }]);
  });

  test("status bar: branch, sync and change count", async () => {
    const { tui } = await mountScm();
    const statusRow = tui.frame().trimEnd().split("\n").at(-1) ?? "";
    expect(statusRow).toContain("main");
    expect(statusRow).toMatch(/2/);
    expect(statusRow).toContain("4");
  });

  test.each([
    [120, 35],
    [90, 28],
  ])("text snapshot %ix%i", async (width, height) => {
    const { tui, ctx, git } = await mountScm({ width, height });
    if (!git) throw new Error("mock git");
    git.setDiff({ path: "README.md" }, { patch: PATCH });
    await tui.act(() => {
      ctx.editors.open({ kind: "diff", resource: "README.md" });
    });
    await tui.waitForText("@@ -1,3 +1,3 @@");
    // The first row names the random temporary workspace.
    const frame = tui.frame().split("\n").slice(1).join("\n");
    expect(frame).toMatchSnapshot();
  });
});

describe("states", () => {
  test("a folder that is not a repository says so plainly", async () => {
    const { tui, ctx } = await mountApp({ git: "real", files: { "notes.md": "# Notes\n" } });
    await tui.act(() => ctx.commands.execute("view.showSourceControl"));
    await tui.act(() => ctx.services.git.refresh());
    await tui.waitForText("No Git repository");
    expect(tui.frame()).not.toContain("Commit");
  });

  test("a clean working tree shows the empty state", async () => {
    const { tui } = await mountScm({ git: gitOptions({ changes: [] }) });
    await tui.waitForText("No changes");
    expect(tui.frame()).toContain("Your working tree is clean.");
    expect(tui.frame()).toContain("Nothing to commit");
  });
});
