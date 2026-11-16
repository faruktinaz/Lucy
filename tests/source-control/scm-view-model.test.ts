import { describe, expect, test } from "bun:test";
import {
  type GitChange,
  GitService,
  MockGitAdapter,
  type MockGitAdapterOptions,
  mockGitError,
} from "@/adapters/git";
import { LucyError } from "@/core/errors";
import { type ScmRow, ScmViewModel, splitPath } from "@/features/source-control/model";
import { deferCleanup, registerCleanup } from "./support";

registerCleanup();

const CHANGES: GitChange[] = [
  { path: "src/conflict.ts", worktree: "unmerged", conflicted: true, conflictKind: "both-modified" },
  { path: "src/staged.ts", index: "modified", conflicted: false },
  { path: "src/new name.ts", origPath: "src/old name.ts", index: "renamed", conflicted: false, score: 100 },
  { path: "README.md", worktree: "modified", conflicted: false },
  { path: "docs/gone.md", worktree: "deleted", conflicted: false },
  { path: "notes/todo.txt", worktree: "untracked", conflicted: false },
];

async function setup(options: MockGitAdapterOptions = { changes: CHANGES }) {
  const mock = new MockGitAdapter(options);
  const service = new GitService(async () => mock);
  const vm = new ScmViewModel(service);
  deferCleanup(() => {
    vm.dispose();
    service.dispose();
  });
  await service.refresh();
  return { mock, service, vm };
}

function shape(rows: readonly ScmRow[]): string[] {
  return rows.map((row) =>
    row.kind === "section"
      ? `# ${row.section.title} (${row.section.count})`
      : `${row.item.letter} ${row.item.path}`,
  );
}

describe("sections, items and rows", () => {
  test("sections in VS Code order with counts; items with letters, tokens and names", async () => {
    const { vm } = await setup();
    expect(shape(vm.state.rows)).toEqual([
      "# Merge Changes (1)",
      "! src/conflict.ts",
      "# Staged Changes (2)",
      "M src/staged.ts",
      "R src/new name.ts",
      "# Changes (2)",
      "M README.md",
      "D docs/gone.md",
      "# Untracked (1)",
      "U notes/todo.txt",
    ]);
    expect(vm.state.badgeCount).toBe(6);
    expect(vm.state.phase).toBe("ready");
    const renamed = vm.itemsOf("staged")[1];
    expect(renamed).toMatchObject({
      key: "item:staged:src/new name.ts",
      fileName: "new name.ts",
      directory: "src",
      origPath: "src/old name.ts",
      description: "src ← src/old name.ts",
      tokenName: "git.renamed",
      staged: true,
    });
    expect(vm.itemsOf("conflicts")[0]).toMatchObject({
      tokenName: "git.conflicted",
      conflictKind: "both-modified",
      staged: false,
    });
    expect(vm.itemsOf("untracked")[0]?.tokenName).toBe("git.untracked");
    expect(vm.itemsOf("changes")[1]?.tokenName).toBe("git.deleted");
    expect(vm.itemsOf("changes")[0]).toMatchObject({
      directory: "",
      fileName: "README.md",
      tokenName: "git.modified",
    });
  });

  test("a file staged and modified again appears in both sections; empty sections are omitted", async () => {
    const { vm } = await setup({
      changes: [{ path: "a.ts", index: "added", worktree: "modified", conflicted: false }],
    });
    expect(shape(vm.state.rows)).toEqual(["# Staged Changes (1)", "A a.ts", "# Changes (1)", "M a.ts"]);
    expect(vm.state.badgeCount).toBe(2);
  });

  test("labels are sanitized for display; raw paths are kept", async () => {
    const { vm } = await setup({
      changes: [{ path: "dir‮/evil\nname.txt", worktree: "untracked", conflicted: false }],
    });
    const item = vm.itemsOf("untracked")[0];
    expect(item?.path).toBe("dir‮/evil\nname.txt");
    expect(item?.label).toBe("evil�name.txt");
    expect(item?.description).toBe("dir�");
    expect(splitPath("vendor/lib/")).toEqual({ fileName: "lib/", directory: "vendor" });
  });

  test("collapsing hides items but keeps the header and counts", async () => {
    const { vm } = await setup();
    vm.toggleSection("staged");
    expect(shape(vm.state.rows)).toContain("# Staged Changes (2)");
    expect(shape(vm.state.rows)).not.toContain("M src/staged.ts");
    expect(vm.state.sections.find((s) => s.group === "staged")?.collapsed).toBe(true);
    expect(vm.visibleRows(0, 3).map((row) => row.key)).toEqual([
      "section:conflicts",
      "item:conflicts:src/conflict.ts",
      "section:staged",
    ]);
    vm.toggleSection("staged");
    expect(vm.state.rows).toHaveLength(10);
  });
});

describe("selection and keyboard", () => {
  test("selection survives refreshes by identity", async () => {
    const { vm, mock, service } = await setup();
    vm.select("item:changes:docs/gone.md");
    const before = vm.state.selectedIndex;
    mock.setChanges([{ path: "AAA.md", worktree: "modified", conflicted: false }, ...CHANGES]);
    await service.refresh();
    expect(vm.state.selectedKey).toBe("item:changes:docs/gone.md");
    expect(vm.state.selectedIndex).toBe(before + 1);
  });

  test("after staging the selected file, the next file in the same section is selected", async () => {
    const { vm } = await setup();
    vm.select("item:changes:README.md");
    const item = vm.selectedItem();
    if (!item) throw new Error("expected a selection");
    await vm.stage(item);
    expect(vm.state.selectedKey).toBe("item:changes:docs/gone.md");
  });

  test("when the section empties, the same file is followed into its new section", async () => {
    const { vm } = await setup({ changes: [{ path: "only.ts", worktree: "modified", conflicted: false }] });
    vm.select("item:changes:only.ts");
    const item = vm.selectedItem();
    if (!item) throw new Error("expected a selection");
    await vm.stage(item);
    expect(vm.state.selectedKey).toBe("item:staged:only.ts");
  });

  test("arrow keys, home/end, left/right", async () => {
    const { vm } = await setup();
    vm.moveSelection(1);
    expect(vm.state.selectedKey).toBe("section:conflicts");
    vm.moveSelection(3);
    expect(vm.state.selectedKey).toBe("item:staged:src/staged.ts");
    vm.selectParentOrCollapse();
    expect(vm.state.selectedKey).toBe("section:staged");
    vm.selectParentOrCollapse();
    expect(vm.state.sections.find((s) => s.group === "staged")?.collapsed).toBe(true);
    vm.expandOrSelectChild();
    expect(vm.state.sections.find((s) => s.group === "staged")?.collapsed).toBe(false);
    vm.expandOrSelectChild();
    expect(vm.state.selectedKey).toBe("item:staged:src/staged.ts");
    vm.selectLast();
    expect(vm.state.selectedKey).toBe("item:untracked:notes/todo.txt");
    vm.moveSelection(5);
    expect(vm.state.selectedKey).toBe("item:untracked:notes/todo.txt");
    vm.selectFirst();
    expect(vm.state.selectedIndex).toBe(0);
    vm.moveSelection(-10);
    expect(vm.state.selectedIndex).toBe(0);
    vm.select("item:does-not-exist");
    expect(vm.state.selectedIndex).toBe(0);
  });

  test("collapsing the section of the selected item selects the header", async () => {
    const { vm } = await setup();
    vm.select("item:changes:README.md");
    vm.setCollapsed("changes", true);
    expect(vm.state.selectedKey).toBe("section:changes");
  });
});

describe("actions", () => {
  test("stage, unstage, toggle and section actions call GitService", async () => {
    const { vm, mock } = await setup();
    const readme = vm.itemsOf("changes")[0];
    const staged = vm.itemsOf("staged")[0];
    if (!readme || !staged) throw new Error("fixture");
    expect(await vm.toggleStage(readme)).toEqual({ ok: true, value: undefined });
    expect(mock.calls.at(-2)).toEqual({ method: "stage", args: [["README.md"]] });
    await vm.toggleStage(staged);
    expect(mock.calls.filter((c) => c.method === "unstage").at(-1)?.args).toEqual([["src/staged.ts"]]);
    await vm.stageSection("untracked");
    expect(mock.calls.filter((c) => c.method === "stage").at(-1)?.args).toEqual([["notes/todo.txt"]]);
    await vm.unstageSection("staged");
    expect(mock.callCount("unstageAll")).toBe(1);
    const refused = await vm.stageAll();
    expect(refused.ok).toBe(false);
    expect(vm.state.lastError).toMatchObject({ operation: "stageAll", kind: "conflicts" });
    vm.dismissError();
    expect(vm.state.lastError).toBeNull();
    await vm.stageSection("conflicts");
    expect((await vm.stageAll()).ok).toBe(true);
    expect(
      vm.state.rows.every((row) =>
        row.kind === "section" ? row.section.group === "staged" : row.item.staged,
      ),
    ).toBe(true);
  });

  test("discard is two-step: preview first, nothing changes until confirm(id)", async () => {
    const { vm, mock } = await setup();
    const readme = vm.itemsOf("changes")[0];
    if (!readme) throw new Error("fixture");
    const request = await vm.requestDiscard(readme);
    if (!request.ok) throw request.error;
    expect(request.value).toMatchObject({
      kind: "discard",
      title: 'Discard changes in "README.md"?',
      confirmLabel: "Discard Changes",
      canConfirm: true,
      summary: { restore: 1, delete: 0, blocked: 0 },
    });
    expect(vm.state.confirmation?.id).toBe(request.value.id);
    expect(mock.callCount("previewDiscard")).toBe(1);
    expect(mock.callCount("discard")).toBe(0);

    const wrong = await vm.confirm(request.value.id + 100);
    expect(wrong.ok).toBe(false);
    expect(mock.callCount("discard")).toBe(0);

    const done = await vm.confirm(request.value.id);
    expect(done.ok).toBe(true);
    expect(mock.calls.find((c) => c.method === "discard")?.args).toEqual([["README.md"]]);
    expect(vm.state.confirmation).toBeNull();
    expect(vm.itemsOf("changes").map((item) => item.path)).toEqual(["docs/gone.md"]);
    const again = await vm.confirm(request.value.id);
    expect(again.ok).toBe(false);
  });

  test("discard wording for untracked files and for everything; cancel", async () => {
    const { vm, mock } = await setup();
    const untracked = await vm.requestDiscard("untracked");
    if (!untracked.ok) throw untracked.error;
    expect(untracked.value).toMatchObject({ title: 'Delete "todo.txt"?', confirmLabel: "Delete File" });
    expect(untracked.value.message).toContain("deleted permanently");
    const all = await vm.requestDiscard("all");
    if (!all.ok) throw all.error;
    expect(all.value).toMatchObject({
      title: "Discard 3 changes?",
      confirmLabel: "Discard All",
      summary: { restore: 2, delete: 1 },
    });
    expect(all.value.message).toContain("cannot be undone");
    vm.cancelConfirmation();
    expect(vm.state.confirmation).toBeNull();
    expect(mock.callCount("discard")).toBe(0);
  });

  test("blocked or impossible discards cannot be confirmed", async () => {
    const { vm, mock } = await setup();
    const staged = vm.itemsOf("staged")[0];
    if (!staged) throw new Error("fixture");
    expect((await vm.requestDiscard(staged)).ok).toBe(false);
    mock.failNext("previewDiscard", mockGitError("preview failed"));
    const failed = await vm.requestDiscard("changes");
    expect(failed.ok).toBe(false);
    expect(vm.state.lastError?.message).toBe("preview failed");
  });

  test("commit with staged changes clears the draft and refreshes", async () => {
    const { vm, mock } = await setup({ changes: [{ path: "a.ts", index: "modified", conflicted: false }] });
    vm.setMessage("feat: ship it");
    expect(vm.state.commit.button).toMatchObject({ label: "Commit", enabled: true });
    const outcome = await vm.commit();
    expect(outcome.kind).toBe("committed");
    expect(mock.calls.find((c) => c.method === "commit")?.args).toEqual([
      { message: "feat: ship it", amend: false },
    ]);
    expect(vm.getDraft()).toEqual({ message: "", amend: false, savedMessage: null });
    expect(vm.state.rows).toEqual([]);
    expect(vm.state.commit.button.label).toBe("Nothing to commit");
  });

  test("commit with nothing staged asks before staging everything", async () => {
    const { vm, mock } = await setup({
      changes: [{ path: "a.ts", worktree: "modified", conflicted: false }],
    });
    vm.setMessage("fix: all of it");
    const outcome = await vm.commit();
    if (outcome.kind !== "needs-confirmation") throw new Error(`unexpected ${outcome.kind}`);
    expect(outcome.confirmation).toMatchObject({
      kind: "stage-all-and-commit",
      changeCount: 1,
      confirmLabel: "Stage All & Commit",
    });
    expect(mock.callCount("commit")).toBe(0);
    expect(mock.callCount("stageAll")).toBe(0);
    const confirmed = await vm.confirm(outcome.confirmation.id);
    expect(confirmed.ok).toBe(true);
    expect(mock.calls.map((c) => c.method).filter((m) => m === "stageAll" || m === "commit")).toEqual([
      "stageAll",
      "commit",
    ]);
    expect(vm.getDraft().message).toBe("");
  });

  test("a blocked commit does nothing; a failed commit keeps the message", async () => {
    const { vm, mock } = await setup({ changes: [{ path: "a.ts", index: "modified", conflicted: false }] });
    expect(await vm.commit()).toEqual({ kind: "blocked", reason: "Enter a commit message." });
    vm.setMessage("try");
    mock.failNext("commit", new LucyError("GIT_FAILED", "hook said no", { details: { kind: "failed" } }));
    const outcome = await vm.commit();
    expect(outcome.kind).toBe("failed");
    expect(vm.getDraft().message).toBe("try");
    expect(vm.state.lastError?.message).toBe("hook said no");
    expect(vm.state.commit.busy).toBe(false);
  });

  test("busy state while committing", async () => {
    const { vm, mock } = await setup({ changes: [{ path: "a.ts", index: "modified", conflicted: false }] });
    mock.latencyMs = 20;
    vm.setMessage("slow");
    const labels: string[] = [];
    vm.store.subscribe(() => labels.push(vm.state.commit.button.label));
    const pending = vm.commit();
    expect(vm.state.commit).toMatchObject({ busy: true, button: { label: "Committing…", enabled: false } });
    await pending;
    expect(labels).toContain("Committing…");
    expect(vm.state.commit.busy).toBe(false);
  });
});

describe("amend and draft", () => {
  test("amend prefills the last message and restores the user's draft when turned off", async () => {
    const { vm, mock } = await setup({ changes: [{ path: "a.ts", index: "modified", conflicted: false }] });
    vm.setMessage("previous");
    await vm.commit();
    mock.setChanges([{ path: "b.ts", index: "added", conflicted: false }]);
    vm.setMessage("my own draft");
    await vm.setAmend(true);
    expect(vm.state.commit).toMatchObject({
      amend: true,
      message: "previous",
      button: { label: "Commit (amend)" },
    });
    await vm.setAmend(false);
    expect(vm.state.commit).toMatchObject({ amend: false, message: "my own draft" });
  });

  test("typing while the previous message loads is never overwritten", async () => {
    const { vm, mock } = await setup({ changes: [{ path: "a.ts", index: "modified", conflicted: false }] });
    vm.setMessage("previous");
    await vm.commit();
    mock.latencyMs = 20;
    const pending = vm.setAmend(true);
    vm.setMessage("typed fast");
    await pending;
    expect(vm.getDraft().message).toBe("typed fast");
  });

  test("amend is unavailable without commits", async () => {
    const { vm } = await setup({
      changes: [{ path: "a.ts", index: "added", conflicted: false }],
      branch: { oid: null, unborn: true },
    });
    vm.setMessage("x");
    await vm.setAmend(true);
    expect(vm.state.commit).toMatchObject({ canAmend: false, button: { enabled: false } });
  });

  test("the draft can be saved and restored", async () => {
    const { vm } = await setup();
    vm.restoreDraft({ message: "amended text", amend: true, savedMessage: "own text" });
    expect(vm.getDraft()).toEqual({ message: "amended text", amend: true, savedMessage: "own text" });
    await vm.setAmend(false);
    expect(vm.getDraft()).toEqual({ message: "own text", amend: false, savedMessage: null });
  });
});

describe("chrome facts and error states", () => {
  test("branch, ahead/behind, operation and notices", async () => {
    const { vm, mock, service } = await setup({
      changes: CHANGES,
      branch: { name: "feature/x", upstream: "origin/feature/x", ahead: 2, behind: 1 },
      operation: "merge",
    });
    expect(vm.state.branch).toMatchObject({
      label: "feature/x",
      ahead: 2,
      behind: 1,
      upstream: "origin/feature/x",
    });
    expect(vm.state.operationLabel).toBe("Merging");
    expect(vm.state.commit.button.reason).toBe("Resolve all merge conflicts before committing.");
    mock.setBranch({ name: null, detached: true, oid: "0123456789abcdef0123456789abcdef01234567" });
    mock.setOperation("rebase");
    await service.refresh();
    expect(vm.state.branch).toMatchObject({ label: "0123456", detached: true });
    expect(vm.state.operationLabel).toBe("Rebasing");
  });

  test("truncated status shows a notice", async () => {
    const mock = new MockGitAdapter({ changes: CHANGES });
    const original = mock.status.bind(mock);
    mock.status = async () => ({ ...(await original()), truncated: true, truncatedReason: "entry-limit" });
    const service = new GitService(async () => mock);
    const vm = new ScmViewModel(service);
    deferCleanup(() => {
      vm.dispose();
      service.dispose();
    });
    await service.refresh();
    expect(vm.state.notice).toBe("Too many changes: only the first 6 are listed.");
  });

  test("no repository, git missing and other failures explain themselves", async () => {
    const cases: Array<[string, LucyError, string, string]> = [
      [
        "no-repository",
        new LucyError("NOT_A_REPOSITORY", "x", { details: { kind: "not-a-repository" } }),
        "No Git repository",
        "git init",
      ],
      [
        "git-missing",
        new LucyError("GIT_FAILED", "x", { details: { kind: "git-missing" } }),
        "Git is not installed",
        "PATH",
      ],
      [
        "error",
        new LucyError("TIMEOUT", "git status did not finish", { details: { kind: "timeout" } }),
        "Git is unavailable",
        "did not finish",
      ],
    ];
    for (const [kind, error, title, detail] of cases) {
      const service = new GitService(async () => {
        throw error;
      });
      const vm = new ScmViewModel(service);
      expect(vm.state.phase).toBe("idle");
      await service.refresh();
      expect(vm.state).toMatchObject({ phase: "unavailable", rows: [], badgeCount: 0, branch: null });
      expect(vm.state.problem).toMatchObject({ kind, title });
      expect(vm.state.problem?.detail).toContain(detail);
      expect(vm.state.commit.button.enabled).toBe(false);
      vm.dispose();
      service.dispose();
    }
  });

  test("a failed refresh keeps the list and shows a warning", async () => {
    const { vm, mock, service } = await setup();
    mock.failNext("status", mockGitError("status timed out"));
    await service.refresh();
    expect(vm.state).toMatchObject({ phase: "ready", warning: "status timed out", problem: null });
    expect(vm.state.rows.length).toBe(10);
    await service.refresh();
    expect(vm.state.warning).toBeNull();
  });

  test("state references stay stable when nothing changed", async () => {
    const { vm, service } = await setup();
    const before = vm.state;
    await service.refresh();
    expect(vm.state.rows).toBe(before.rows);
    expect(vm.state.commit).toBe(before.commit);
    expect(vm.state.branch).toBe(before.branch);
  });

  test("dispose stops following the service", async () => {
    const { vm, mock, service } = await setup();
    vm.dispose();
    mock.setChanges([]);
    await service.refresh();
    expect(vm.state.rows.length).toBe(10);
  });
});
