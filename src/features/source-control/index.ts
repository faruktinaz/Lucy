/**
 * Source Control: the sidebar view (commit box, staged/unstaged/untracked/conflict groups), the
 * diff editor for "diff" tabs, branch/sync/change status items, and every Git command in the
 * palette. The logic lives in `ScmController` and the UI-independent `model/`; this module only
 * wires them into the workbench.
 *
 * Activation starts nothing: the Git service and the view-model are created on first use.
 */
import type { GitState } from "@/adapters/git";
import type { AppContext } from "@/app/app-context";
import type { FeatureModule } from "@/app/feature";
import { derived } from "@/app/workbench/readable";
import type { ViewAction } from "@/app/workbench/views";
import { type Disposable, DisposableStore, toDisposable } from "@/core/events";
import { displayWidth } from "@/core/text";
import { icon } from "@/themes/icons";
import { ScmController } from "./controller";
import { DIFF_KIND, isDiffTab } from "./diff-input";
import { diffViewComponent, scmViewComponent } from "./views/components";
import { diffTabTitle } from "./views/diff-view";

/** Changes across all groups, as VS Code counts its badge (staged and modified count twice). */
function changeCount(state: GitState): number {
  const status = state.status;
  if (!status) return 0;
  return status.conflicts.length + status.staged.length + status.unstaged.length + status.untracked.length;
}

const SCM_VISIBLE = "sidebarView == 'scm'";
/** The front tab is a diff. Spelled with `activeEditor` so the conflict analysis sees it excludes file-editor bindings. */
const DIFF_ACTIVE = `scmDiffActive && activeEditor == '${DIFF_KIND}'`;

export const sourceControlFeature: FeatureModule = {
  id: "source-control",
  keybindings: [
    { command: "git.stage", keys: ["ctrl+k s"], when: SCM_VISIBLE },
    { command: "git.unstage", keys: ["ctrl+k u"], when: SCM_VISIBLE },
    { command: "git.discard", keys: ["ctrl+k d"], when: SCM_VISIBLE },
    // Ctrl+K R restarts the session while the AI panel has focus; refresh yields there.
    { command: "git.refresh", keys: ["ctrl+k r"], when: `${SCM_VISIBLE} && !auxiliaryFocus` },
    // Not Ctrl+K I: that inserts an AI prompt template from anywhere. M as in "message".
    { command: "git.focusCommitInput", keys: ["ctrl+k shift+m"], when: SCM_VISIBLE },
    { command: "git.checkout", keys: ["ctrl+k b"] },
    { command: "git.log", keys: ["ctrl+k h"] },
    { command: "git.diff.nextChange", keys: ["f7"], when: "scmDiffActive" },
    { command: "git.diff.previousChange", keys: ["shift+f7"], when: "scmDiffActive" },
    { command: "git.diff.toggleLayout", keys: ["ctrl+k v"], when: DIFF_ACTIVE },
  ],
  activate(ctx) {
    const store = new DisposableStore();
    const controller = store.add(new ScmController(ctx));
    // The Git service is created lazily; reading its store starts no process.
    const gitState = {
      get: () => ctx.services.git.store.get(),
      subscribe: (listener: () => void) => ctx.services.git.store.subscribe(listener),
    };

    store.add(
      ctx.views.registerSidebarView({
        id: "scm",
        title: "Source Control",
        icon: "sourceControl",
        order: 30,
        command: "view.showSourceControl",
        badge: derived([gitState] as const, (state) => changeCount(state) || undefined),
        actions: [
          { command: "git.commit", icon: "check", title: "Commit" },
          { command: "git.refresh", icon: "refresh", title: "Refresh" },
          { command: "git.moreActions", icon: "more", title: "More Actions" },
        ],
        component: scmViewComponent(controller),
      }),
    );

    store.add(
      ctx.views.registerEditorView({
        kind: DIFF_KIND,
        // Supersedes the editor feature's placeholder for diff tabs.
        priority: 10,
        title: (input) => diffTabTitle(input.resource),
        component: diffViewComponent(controller),
        actions: (tab) => diffActions(tab.params.staged === true, tab.viewState.resolvedLayout === "split"),
      }),
    );

    store.add(registerCommands(ctx, controller));
    store.add(registerStatusItems(ctx, controller));

    // `scmDiffActive`: the tab in front is a diff (for F7 and friends).
    const syncDiffKey = () => ctx.contextKeys.set("scmDiffActive", isDiffTab(ctx.editors.active));
    syncDiffKey();
    store.add(toDisposable(ctx.editors.store.subscribe(syncDiffKey)));
    return store;
  },
};

function diffActions(staged: boolean, split: boolean): readonly ViewAction[] {
  return [
    {
      command: "git.diff.toggleLayout",
      icon: "layoutSidebarRight",
      label: split ? "Side by side" : "Inline",
      title: split ? "Show the changes inline" : "Show the changes side by side",
      active: split,
    },
    { command: "git.diff.previousChange", icon: "arrowUp", title: "Previous Change" },
    { command: "git.diff.nextChange", icon: "arrowDown", title: "Next Change" },
    { command: "git.openFile", icon: "goToFile", title: "Open File" },
    staged
      ? { command: "git.unstageActiveDiff", icon: "remove", label: "Unstage", title: "Unstage this file" }
      : { command: "git.stageActiveDiff", icon: "add", label: "Stage", title: "Stage this file" },
  ];
}

function registerCommands(ctx: AppContext, controller: ScmController): Disposable {
  const store = new DisposableStore();
  const add = (
    id: string,
    title: string,
    run: (args?: unknown) => unknown,
    extra: { keywords?: readonly string[]; hidden?: boolean; description?: string } = {},
  ) => store.add(ctx.commands.register({ id, title, category: "Git", run, ...extra }));

  const showView = () => ctx.commands.execute("view.showSourceControl");

  add("git.commit", "Commit", () => controller.commit(), { keywords: ["save", "check in"] });
  add("git.commitAmend", "Commit (Amend)", () => controller.commitAmend(), { keywords: ["amend", "reword"] });
  add("git.stage", "Stage Changes", () => controller.stageSelection(), { keywords: ["add"] });
  add("git.unstage", "Unstage Changes", () => controller.unstageSelection(), { keywords: ["reset"] });
  add("git.discard", "Discard Changes…", () => controller.discardSelection(), {
    keywords: ["revert", "restore"],
  });
  add("git.stageAll", "Stage All Changes", () => controller.stageAll(), { keywords: ["add"] });
  add("git.unstageAll", "Unstage All Changes", () => controller.unstageAll(), { keywords: ["reset"] });
  add("git.discardAll", "Discard All Changes…", () => controller.discard("all"), {
    keywords: ["revert", "clean"],
  });
  add("git.refresh", "Refresh", () => controller.refresh(), { keywords: ["status", "reload"] });
  add("git.checkout", "Switch Branch…", () => controller.checkout(), { keywords: ["checkout", "branch"] });
  add("git.createBranch", "Create Branch…", () => controller.createBranch(), { keywords: ["new branch"] });
  add("git.fetch", "Fetch", () => controller.fetch(), { keywords: ["remote", "sync"] });
  add("git.pull", "Pull (Fast-Forward Only)", () => controller.pull(), {
    keywords: ["remote", "sync", "update"],
  });
  add("git.push", "Push", () => controller.push(), { keywords: ["remote", "publish", "upload"] });
  add("git.stash", "Stash Changes…", () => controller.stash(false), { keywords: ["shelve"] });
  add("git.stashIncludeUntracked", "Stash All Changes (Include Untracked)…", () => controller.stash(true), {
    keywords: ["shelve"],
  });
  add("git.stashPop", "Pop Stash…", () => controller.stashApply(true), { keywords: ["unshelve"] });
  add("git.stashApply", "Apply Stash…", () => controller.stashApply(false), { keywords: ["unshelve"] });
  add("git.log", "Show Commit History", () => controller.history(), { keywords: ["log", "commits"] });
  add("git.openChanges", "Open Changes", () => controller.openSelection(), { keywords: ["diff"] });
  add("git.openFile", "Open File", () => controller.openFileForSelection());
  add("git.focusCommitInput", "Focus Commit Message", async () => {
    await showView();
    await controller.focusCommitInput();
  });
  add("git.diff.nextChange", "Go to Next Change", () => controller.requestDiffAction("nextChange"));
  add("git.diff.previousChange", "Go to Previous Change", () =>
    controller.requestDiffAction("previousChange"),
  );
  add("git.diff.toggleLayout", "Toggle Inline / Side by Side Diff", () =>
    controller.requestDiffAction("toggleLayout"),
  );

  // Targets for buttons; the palette has the selection-based commands above.
  add(
    "git.stageActiveDiff",
    "Stage File",
    async () => {
      const tab = ctx.editors.active;
      if (!isDiffTab(tab)) return;
      const item =
        controller.vm.itemsOf("changes").find((entry) => entry.path === tab.resource) ??
        controller.vm.itemsOf("untracked").find((entry) => entry.path === tab.resource) ??
        controller.vm.itemsOf("conflicts").find((entry) => entry.path === tab.resource);
      if (item) await controller.stageItem(item);
      else ctx.hints.flash({ text: "This file has no unstaged changes" });
    },
    { hidden: true },
  );
  add(
    "git.unstageActiveDiff",
    "Unstage File",
    async () => {
      const tab = ctx.editors.active;
      if (!isDiffTab(tab)) return;
      const item = controller.vm.itemsOf("staged").find((entry) => entry.path === tab.resource);
      if (item) await controller.unstageItem(item);
      else ctx.hints.flash({ text: "This file is not staged" });
    },
    { hidden: true },
  );
  add("git.syncMenu", "Synchronize", () => controller.showSyncMenu(syncMenuAnchor(ctx)), { hidden: true });
  add("git.moreActions", "More Source Control Actions", () => showMoreActions(ctx), { hidden: true });
  return store;
}

/** Above the status bar's sync item (left side, after the branch). */
function syncMenuAnchor(ctx: AppContext): { x: number; y: number } {
  const layout = ctx.layout.effective.get();
  const status = ctx.services.git.state.status;
  const branchName = status?.branch.name ?? status?.branch.oid?.slice(0, 7) ?? "";
  const branchWidth = displayWidth(branchName) + 2 + 2;
  return { x: Math.min(layout.width - 2, 1 + branchWidth + 1), y: Math.max(0, layout.height - 2) };
}

/** The sidebar header's "…" menu, anchored under the button. */
function showMoreActions(ctx: AppContext): void {
  const layout = ctx.layout.effective.get();
  const sidebarLeft =
    layout.sidebarSide === "left" ? layout.activityBar.width : layout.width - layout.sidebar.width;
  const x = Math.max(0, sidebarLeft + layout.sidebar.width - 4);
  const y = layout.commandBar ? 2 : 1;
  ctx.menus.show({
    x,
    y,
    items: [
      { id: "pull", label: "Pull", icon: "arrowDown", command: "git.pull" },
      { id: "push", label: "Push", icon: "arrowUp", command: "git.push" },
      { id: "fetch", label: "Fetch", icon: "sync", command: "git.fetch" },
      { id: "sep1", kind: "separator" },
      { id: "checkout", label: "Switch Branch…", icon: "branch", command: "git.checkout" },
      { id: "create", label: "Create Branch…", icon: "add", command: "git.createBranch" },
      { id: "sep2", kind: "separator" },
      { id: "stage-all", label: "Stage All Changes", command: "git.stageAll" },
      { id: "unstage-all", label: "Unstage All Changes", command: "git.unstageAll" },
      { id: "discard-all", label: "Discard All Changes…", command: "git.discardAll", danger: true },
      { id: "sep3", kind: "separator" },
      { id: "stash", label: "Stash Changes…", command: "git.stash" },
      { id: "stash-pop", label: "Pop Stash…", command: "git.stashPop" },
      { id: "amend", label: "Commit (Amend)", command: "git.commitAmend" },
      { id: "history", label: "Show Commit History", command: "git.log" },
    ],
  });
}

const NETWORK_LABELS: Readonly<Record<string, string>> = {
  fetch: "Fetching…",
  pull: "Pulling…",
  push: "Pushing…",
};

function registerStatusItems(ctx: AppContext, controller: ScmController): Disposable {
  const store = new DisposableStore();
  const git = () => ctx.services.git;
  const branch = store.add(
    ctx.statusBar.register({
      id: "scm.branch",
      alignment: "left",
      priority: 100,
      text: "",
      icon: "branch",
      tone: "default",
      visible: false,
      command: "git.checkout",
    }),
  );
  const sync = store.add(
    ctx.statusBar.register({
      id: "scm.sync",
      alignment: "left",
      priority: 90,
      text: "",
      tone: "muted",
      visible: false,
      command: "git.syncMenu",
    }),
  );
  const changes = store.add(
    ctx.statusBar.register({
      id: "scm.changes",
      alignment: "left",
      priority: 80,
      text: "",
      tone: "muted",
      visible: false,
      command: "view.showSourceControl",
    }),
  );
  const update = () => {
    const state = git().store.get();
    const status = state.status;
    if (!status || !ctx.config.get("git.enabled")) {
      branch.update({ visible: false });
      sync.update({ visible: false });
      changes.update({ visible: false });
      return;
    }
    const tier = ctx.themes.current.icons;
    const name = status.branch.detached
      ? (status.branch.oid?.slice(0, 7) ?? "detached")
      : (status.branch.name ?? "");
    const operation = status.operation ? ` (${status.operation})` : "";
    const switchKeys = ctx.keybindingLabel("git.checkout");
    branch.update({
      visible: true,
      text: `${name}${operation}`,
      tooltip: `${status.branch.upstream ? `Tracking ${status.branch.upstream}` : "No upstream branch"}. Switch branch${switchKeys ? ` (${switchKeys})` : ""}`,
    });
    const ahead = status.branch.ahead ?? 0;
    const behind = status.branch.behind ?? 0;
    const busy = state.busyOperation ? NETWORK_LABELS[state.busyOperation] : undefined;
    const counts = [
      behind > 0 ? `${icon("arrowDown", tier)}${behind}` : "",
      ahead > 0 ? `${icon("arrowUp", tier)}${ahead}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    sync.update({
      visible: status.branch.upstream !== undefined || busy !== undefined,
      text: busy ? `${icon("sync", tier)} ${busy}` : counts || icon("sync", tier),
      tone: behind > 0 || ahead > 0 ? "default" : "muted",
      tooltip: status.branch.upstream
        ? `${behind} to pull and ${ahead} to push with ${status.branch.upstream}. Fetch, pull or push`
        : "Synchronize",
    });
    const count = changeCount(state);
    changes.update({
      visible: count > 0,
      text: `${icon("modified", tier)} ${count}`,
      tone: status.conflicts.length > 0 ? "warning" : "muted",
      tooltip: `${count} ${count === 1 ? "change" : "changes"}${status.conflicts.length > 0 ? `, ${status.conflicts.length} in conflict` : ""}. Show Source Control`,
    });
  };
  store.add(toDisposable(git().store.subscribe(update)));
  store.add(ctx.themes.onDidChange(update));
  update();
  void controller;
  return store;
}
