/**
 * Everything the Source Control feature does, outside React: the view-model, the actions
 * behind commands, buttons and keys, and their feedback (dialogs, pickers, toasts).
 *
 * Rules every action follows:
 * - Nothing fails silently: a failure is an error toast with Git's message and, where there is
 *   one, the remedy. Branch, commit, network and stash results are success toasts; staging only
 *   flashes a hint, because the list itself shows the result.
 * - Destructive actions always go through a confirmation built from Git's preview, with the
 *   safe button focused (`DialogService` does that for `danger` dialogs).
 * - There is no force variant of anything.
 */
import { basename, isAbsolute, join } from "node:path";
import {
  fromAbsolutePath,
  type GitBranch,
  type GitCommit,
  type GitRepositoryManager,
  type GitService,
  type GitStash,
  gitFailureKind,
  type RepositoryEntry,
  repositoryLabelPath,
  toWorkspacePath,
} from "@/adapters/git";
import type { AppContext } from "@/app/app-context";
import type { EditorTab } from "@/app/workbench/editors";
import type { QuickPickItem } from "@/app/workbench/quick-pick";
import { type Disposable, DisposableStore, Emitter, toDisposable } from "@/core/events";
import { Store } from "@/core/store";
import { plural, sanitizeForDisplay } from "@/core/text";
import { icon } from "@/themes/icons";
import { diffInput, isDiffTab } from "./diff-input";
import { commitSummary, describeFailure } from "./messages";
import { type ScmDiscardTarget, type ScmGroup, type ScmItem, type ScmState, ScmViewModel } from "./model";
import { branchNameProblem, localNameForRemote } from "./ref-name";

export type DiffAction = "nextChange" | "previousChange" | "toggleLayout" | "openFile";

function fileName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return sanitizeForDisplay(parts[parts.length - 1] ?? path);
}

/** "2 hours ago" style age of an ISO date, for history and stash pickers. */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const units: readonly (readonly [number, string])[] = [
    [60, "minute"],
    [3600, "hour"],
    [86_400, "day"],
    [2_592_000, "month"],
    [31_536_000, "year"],
  ];
  let chosen: readonly [number, string] = [60, "minute"];
  for (const unit of units) if (seconds >= unit[0]) chosen = unit;
  const count = Math.floor(seconds / chosen[0]);
  return `${plural(count, chosen[1])} ago`;
}

/** "subject on branch", trimmed for a toast. */
function committedMessage(result: { summary: string; branch: string | null }): string {
  const subject = sanitizeForDisplay(result.summary);
  const short = subject.length > 72 ? `${subject.slice(0, 71)}…` : subject;
  return result.branch ? `${short} on ${result.branch}` : short;
}

/** One repository as the multi-repository panel shows it. */
export interface RepositoryView {
  readonly entry: RepositoryEntry;
  readonly vm: ScmViewModel;
  readonly state: ScmState;
  /** Folder name of the repository. */
  readonly name: string;
  /** Path relative to the workspace (`""` for the workspace's own repository). */
  readonly path: string;
}

export interface MultiRepositoryState {
  /** Usable repositories: the workspace's own first, then the ones found below it. */
  readonly repositories: readonly RepositoryView[];
  readonly activeRoot: string | null;
  readonly scanning: boolean;
  readonly truncated: boolean;
  readonly maxRepositories: number;
}

/** Where a diff tab's file lives: its repository and its repo-relative path. */
export interface ResolvedDiff {
  readonly service: GitService;
  readonly path: string;
  readonly staged: boolean;
}

export class ScmController implements Disposable {
  private readonly vms = new Map<GitService, ScmViewModel>();
  private activeService: GitService | null = null;
  private draftRestored = false;
  private lastDraft = "";
  private readonly disposables = new DisposableStore();
  private readonly diffActions = new Emitter<DiffAction>();
  private readonly commitFocus = new Emitter<void>();
  private multiStore: Store<MultiRepositoryState> | null = null;
  private multiSubscriptions = new DisposableStore();

  constructor(private readonly ctx: AppContext) {}

  /**
   * The repository manager once domain services created it (when background services start);
   * `undefined` before, so nothing beyond the workspace's own Git service exists before then.
   */
  get repositories(): GitRepositoryManager | undefined {
    return this.ctx.services.createdServices.includes("gitRepositories")
      ? this.ctx.services.gitRepositories
      : undefined;
  }

  private get entries(): readonly RepositoryEntry[] {
    return (
      this.repositories?.entries ?? [
        { root: this.ctx.workspace.root, service: this.ctx.services.git, primary: true },
      ]
    );
  }

  /**
   * The active repository's service: the one chosen in the panel or by the active editor;
   * otherwise the workspace's own repository, or the first one found below the workspace.
   */
  get git(): GitService {
    const entries = this.entries;
    if (this.activeService && entries.some((entry) => entry.service === this.activeService)) {
      return this.activeService;
    }
    const primary = this.ctx.services.git;
    if (primary.state.repo) return primary;
    return entries.find((entry) => entry.service.state.repo)?.service ?? primary;
  }

  /** The active repository's view-model (the commit box and selection commands use it). */
  get vm(): ScmViewModel {
    return this.vmFor(this.git);
  }

  /**
   * One view-model per repository, created on first use. The first one gets the persisted
   * commit draft back; afterwards the active one's draft is persisted (the user's own text,
   * not the previous commit message that amend shows).
   */
  vmFor(service: GitService): ScmViewModel {
    const existing = this.vms.get(service);
    if (existing) return existing;
    const vm = new ScmViewModel(service);
    this.vms.set(service, vm);
    if (!this.draftRestored) {
      this.draftRestored = true;
      const saved = this.ctx.persisted.state.commitDraft;
      this.lastDraft = saved;
      if (saved) vm.restoreDraft({ message: saved, amend: false, savedMessage: null });
    }
    this.disposables.add(
      toDisposable(
        vm.store.subscribe(() => {
          if (this.vm !== vm) return;
          const draft = vm.getDraft();
          const own = draft.amend ? (draft.savedMessage ?? "") : draft.message;
          if (own === this.lastDraft) return;
          this.lastDraft = own;
          this.ctx.persisted.update({ commitDraft: own });
        }),
      ),
    );
    this.disposables.add(vm);
    return vm;
  }

  /**
   * Makes `service` the active repository. The commit box keeps the text the user typed: the
   * draft moves to the new repository (amend, which is about one repository's last commit,
   * is turned off).
   */
  setActive(service: GitService): void {
    const previous = this.git;
    if (previous === service) {
      this.activeService = service;
      return;
    }
    const from = this.vmFor(previous);
    const draft = from.getDraft();
    const own = draft.amend ? (draft.savedMessage ?? "") : draft.message;
    from.restoreDraft({ message: "", amend: false, savedMessage: null });
    this.activeService = service;
    this.vmFor(service).restoreDraft({ message: own, amend: false, savedMessage: null });
    this.refreshMulti();
  }

  /** The repository a workspace-relative or absolute path belongs to. */
  serviceForPath(path: string): GitService | undefined {
    const absolute = isAbsolute(path) ? path : join(this.ctx.workspace.root, ...path.split("/"));
    return this.repositories?.entryForPath(absolute)?.service ?? this.ctx.services.git;
  }

  /** Workspace-relative path of a repo-relative path, or `null` when it is outside the workspace. */
  workspacePathOf(service: GitService, repoPath: string): string | null {
    const repo = service.state.repo;
    if (!repo) return null;
    const entry = this.entries.find((candidate) => candidate.service === service);
    const inRepo = toWorkspacePath(repo, repoPath);
    if (inRepo === null) return null;
    if (!entry || entry.primary) return inRepo;
    const prefix = repositoryLabelPath(this.ctx.workspace.root, entry.root);
    return prefix ? (inRepo ? `${prefix}/${inRepo}` : prefix) : inRepo;
  }

  /** The repository and repo-relative path of a diff tab (resources are workspace-relative). */
  resolveDiffTab(tab: EditorTab | null | undefined): ResolvedDiff | null {
    if (!isDiffTab(tab)) return null;
    const staged = tab.params.staged === true;
    const explicitRoot = typeof tab.params.root === "string" ? tab.params.root : undefined;
    if (explicitRoot) {
      const entry = this.entries.find((candidate) => candidate.root === explicitRoot);
      if (entry) return { service: entry.service, path: tab.resource, staged };
    }
    const absolute = join(this.ctx.workspace.root, ...tab.resource.split("/"));
    const service = this.repositories?.entryForPath(absolute)?.service ?? this.ctx.services.git;
    const repo = service.state.repo;
    const path = repo ? (fromAbsolutePath(repo, absolute) ?? tab.resource) : tab.resource;
    return { service, path, staged };
  }

  /**
   * The combined state of every repository, for the multi-repository panel. Until the
   * repository manager exists it describes the workspace's own repository only; it attaches
   * to the manager as soon as background services created it.
   */
  get multi(): Store<MultiRepositoryState> {
    if (this.multiStore) return this.multiStore;
    const store = new Store<MultiRepositoryState>(this.computeMulti());
    this.multiStore = store;
    let attached = false;
    const attach = () => {
      const manager = this.repositories;
      if (attached || !manager) return;
      attached = true;
      this.disposables.add(toDisposable(manager.store.subscribe(() => this.resubscribe())));
      this.resubscribe();
    };
    this.disposables.add(
      toDisposable(
        this.ctx.services.git.store.subscribe(() => {
          attach();
          this.refreshMulti();
        }),
      ),
    );
    attach();
    return store;
  }

  private resubscribe(): void {
    this.multiSubscriptions.dispose();
    this.multiSubscriptions = new DisposableStore();
    for (const entry of this.entries) {
      const vm = this.vmFor(entry.service);
      this.multiSubscriptions.add(toDisposable(vm.store.subscribe(() => this.refreshMulti())));
    }
    this.refreshMulti();
  }

  private refreshMulti(): void {
    this.multiStore?.set(this.computeMulti());
  }

  private computeMulti(): MultiRepositoryState {
    const manager = this.repositories;
    const repositories: RepositoryView[] = [];
    for (const entry of this.entries) {
      const repo = entry.service.state.repo;
      if (!repo) continue;
      const path = repositoryLabelPath(this.ctx.workspace.root, entry.root);
      const vm = this.vmFor(entry.service);
      repositories.push({ entry, vm, state: vm.state, name: basename(path || repo.root) || repo.root, path });
    }
    const active = this.git;
    const activeRoot = repositories.find((repo) => repo.entry.service === active)?.entry.root ?? null;
    return {
      repositories,
      activeRoot,
      scanning: manager?.state.scanning ?? false,
      truncated: manager?.state.truncated ?? false,
      maxRepositories: manager?.state.maxRepositories ?? 0,
    };
  }

  /** Refreshes every repository and searches for new ones. */
  async refreshAll(): Promise<void> {
    await (this.repositories ? this.repositories.refreshAll() : this.ctx.services.git.refresh());
  }

  /** Commands that act on the diff tab in front (next change, toggle layout, ...). */
  onDidRequestDiffAction(listener: (action: DiffAction) => void): Disposable {
    return this.diffActions.on(listener);
  }

  requestDiffAction(action: DiffAction): void {
    this.diffActions.emit(action);
  }

  /** The commit box should take keyboard focus (git.focusCommitInput, amend). */
  onDidRequestCommitFocus(listener: () => void): Disposable {
    return this.commitFocus.on(listener);
  }

  async focusCommitInput(): Promise<void> {
    await this.ctx.commands.execute("view.showSourceControl");
    this.ctx.focus.focus("sidebar");
    this.commitFocus.emit();
  }

  private networkTimeout(): number {
    return this.ctx.config.get("git.networkTimeoutSeconds") * 1000;
  }

  private fail(title: string, error: unknown): void {
    this.vm.dismissError();
    this.ctx.notifications.error(title, describeFailure(error));
  }

  // ---------------------------------------------------------------- selection

  /** What a selection-based command acts on: the selected list row, else the diff in front. */
  private target(): { item: ScmItem } | { group: ScmGroup } | { path: string; staged: boolean } | null {
    const row = this.vm.selectedRow();
    if (row?.kind === "item") return { item: row.item };
    if (row?.kind === "section") return { group: row.section.group };
    const resolved = this.resolveDiffTab(this.ctx.editors.active);
    if (resolved) {
      this.setActive(resolved.service);
      return { path: resolved.path, staged: resolved.staged };
    }
    return null;
  }

  /** The item of a repo-relative path in the active repository's groups. */
  itemFor(path: string, staged: boolean): ScmItem | undefined {
    const vm = this.vm;
    if (staged) return vm.itemsOf("staged").find((item) => item.path === path);
    return (
      vm.itemsOf("changes").find((item) => item.path === path) ??
      vm.itemsOf("untracked").find((item) => item.path === path) ??
      vm.itemsOf("conflicts").find((item) => item.path === path)
    );
  }

  // ---------------------------------------------------------------- open

  /** Opens an item of the active repository as a diff tab. */
  openDiff(item: ScmItem, options: { preview: boolean; focus?: boolean } = { preview: true }): void {
    const service = this.git;
    const workspacePath = this.workspacePathOf(service, item.path);
    const input = diffInput(workspacePath ?? item.path, item.staged);
    const root = this.entries.find((entry) => entry.service === service)?.root;
    // A file of the workspace's repository outside the workspace folder keeps its repo path.
    const params = workspacePath === null && root ? { ...input.params, root } : input.params;
    this.ctx.editors.open({ ...input, params }, { preview: options.preview });
    if (options.focus) this.ctx.focus.focus("editor");
  }

  /** Opens the working-tree file (at `line`, 1-based) of the active repository in the file viewer. */
  openFile(repoPath: string, line?: number, service: GitService = this.git): void {
    const workspacePath = this.workspacePathOf(service, repoPath);
    if (workspacePath === null || workspacePath === "") {
      this.ctx.notifications.info(
        "This file is outside the workspace",
        `${repoPath} belongs to the repository but not to the open folder.`,
      );
      return;
    }
    const change = service.state.status?.changes.find((candidate) => candidate.path === repoPath);
    if (change && change.worktree === "deleted") {
      this.ctx.notifications.info(
        "The file was deleted",
        `${fileName(repoPath)} no longer exists in the working tree.`,
      );
      return;
    }
    const tab = this.ctx.editors.open({ kind: "file", resource: workspacePath });
    if (line && line > 0) this.ctx.editors.reveal({ tabId: tab.id, line });
    this.ctx.focus.focus("editor");
  }

  openSelection(): void {
    const target = this.target();
    if (target && "item" in target) this.openDiff(target.item, { preview: false, focus: true });
  }

  openFileForSelection(): void {
    const target = this.target();
    if (target && "item" in target) this.openFile(target.item.path);
    else if (target && "path" in target) this.requestDiffAction("openFile");
  }

  // ---------------------------------------------------------------- staging

  async stageItem(item: ScmItem): Promise<void> {
    const result = await this.vm.stage(item);
    if (!result.ok) {
      this.fail(`Could not stage ${fileName(item.path)}`, result.error);
      return;
    }
    this.ctx.hints.flash({
      text:
        item.group === "conflicts"
          ? `Marked ${fileName(item.path)} as resolved`
          : `Staged ${fileName(item.path)}`,
    });
  }

  async unstageItem(item: ScmItem): Promise<void> {
    const result = await this.vm.unstage(item);
    if (result.ok) this.ctx.hints.flash({ text: `Unstaged ${fileName(item.path)}` });
    else this.fail(`Could not unstage ${fileName(item.path)}`, result.error);
  }

  async stageSection(group: Exclude<ScmGroup, "staged">): Promise<void> {
    const count = this.vm.itemsOf(group).length;
    const result = await this.vm.stageSection(group);
    if (result.ok) this.ctx.hints.flash({ text: `Staged ${plural(count, "file")}` });
    else this.fail("Could not stage the changes", result.error);
  }

  async stageAll(): Promise<void> {
    const conflicts = this.vm.itemsOf("conflicts").length;
    if (conflicts > 0) {
      const confirmed = await this.ctx.dialogs.confirm({
        title: "Stage files with merge conflicts?",
        message: `${plural(conflicts, "file")} still ${conflicts === 1 ? "has" : "have"} merge conflicts. Staging marks them as resolved. Stage only the other changes instead?`,
        confirmLabel: "Stage Others",
      });
      if (!confirmed) return;
      for (const group of ["changes", "untracked"] as const) {
        if (this.vm.itemsOf(group).length > 0) await this.stageSection(group);
      }
      return;
    }
    const result = await this.vm.stageAll();
    if (result.ok) this.ctx.hints.flash({ text: "Staged all changes" });
    else this.fail("Could not stage all changes", result.error);
  }

  async unstageAll(): Promise<void> {
    const result = await this.vm.unstageAll();
    if (result.ok) this.ctx.hints.flash({ text: "Unstaged all changes" });
    else this.fail("Could not unstage the changes", result.error);
  }

  async stageSelection(): Promise<void> {
    const target = this.target();
    if (!target) return this.nothingSelected();
    if ("item" in target) {
      if (target.item.staged)
        this.ctx.hints.flash({ text: `${fileName(target.item.path)} is already staged` });
      else await this.stageItem(target.item);
    } else if ("group" in target) {
      if (target.group === "staged") this.ctx.hints.flash({ text: "These changes are already staged" });
      else await this.stageSection(target.group);
    } else {
      const item = this.itemFor(target.path, false);
      if (item) await this.stageItem(item);
      else this.ctx.hints.flash({ text: `${fileName(target.path)} has no unstaged changes` });
    }
  }

  async unstageSelection(): Promise<void> {
    const target = this.target();
    if (!target) return this.nothingSelected();
    if ("item" in target) {
      const staged = target.item.staged ? target.item : this.itemFor(target.item.path, true);
      if (staged) await this.unstageItem(staged);
      else this.ctx.hints.flash({ text: `${fileName(target.item.path)} is not staged` });
    } else if ("group" in target) {
      if (target.group === "staged") await this.unstageAll();
      else this.ctx.hints.flash({ text: "Select staged changes to unstage" });
    } else {
      const item = this.itemFor(target.path, true);
      if (item) await this.unstageItem(item);
      else this.ctx.hints.flash({ text: `${fileName(target.path)} is not staged` });
    }
  }

  async discardSelection(): Promise<void> {
    const target = this.target();
    if (!target) return this.nothingSelected();
    if ("item" in target) return this.discard(target.item);
    if ("group" in target) {
      if (target.group === "changes" || target.group === "untracked") return this.discard(target.group);
      this.ctx.hints.flash({ text: "Only unstaged and untracked changes can be discarded" });
      return;
    }
    const item = this.itemFor(target.path, false);
    if (item && (item.group === "changes" || item.group === "untracked")) return this.discard(item);
    this.ctx.hints.flash({ text: `${fileName(target.path)} has no unstaged changes to discard` });
  }

  private nothingSelected(): void {
    this.ctx.hints.flash({ text: "Select a change in Source Control first" });
  }

  /**
   * Discard, always two-step: Git previews what would be lost, the dialog says it (danger
   * style, Cancel focused), and only an explicit confirm discards.
   */
  async discard(target: ScmDiscardTarget): Promise<void> {
    const vm = this.vm;
    if (target !== "all" && typeof target === "object" && !Array.isArray(target)) {
      const item = target as ScmItem;
      if (item.group === "staged" || item.group === "conflicts") {
        this.ctx.hints.flash({
          text:
            item.group === "staged"
              ? "Unstage the file before discarding it"
              : "Resolve or stage conflicts instead",
        });
        return;
      }
    }
    const request = await vm.requestDiscard(target);
    if (!request.ok) {
      this.fail("Could not prepare the discard", request.error);
      return;
    }
    const confirmation = request.value;
    if (!confirmation.canConfirm) {
      vm.cancelConfirmation();
      await this.ctx.dialogs.alert({ title: confirmation.title, message: confirmation.message });
      return;
    }
    const confirmed = await this.ctx.dialogs.confirm({
      title: confirmation.title,
      message: confirmation.message,
      confirmLabel: confirmation.confirmLabel,
      danger: true,
    });
    if (!confirmed) {
      vm.cancelConfirmation();
      return;
    }
    const result = await vm.confirm(confirmation.id);
    if (!result.ok) {
      this.fail("Discard failed", result.error);
      return;
    }
    const { restore, delete: removed } = confirmation.summary;
    const parts = [
      restore > 0 ? `restored ${plural(restore, "file")}` : "",
      removed > 0 ? `deleted ${plural(removed, "untracked file")}` : "",
    ].filter(Boolean);
    this.ctx.notifications.info(
      "Changes discarded",
      `${parts.join(" and ")}.`.replace(/^./, (c) => c.toUpperCase()),
    );
  }

  // ---------------------------------------------------------------- commit

  /** The primary button, Ctrl+Enter and `git.commit`. */
  async commit(): Promise<void> {
    const vm = this.vm;
    const outcome = await vm.commit();
    switch (outcome.kind) {
      case "committed": {
        const { result } = outcome;
        this.ctx.notifications.success(`Committed ${result.shortOid}`, committedMessage(result));
        return;
      }
      case "needs-confirmation": {
        const { confirmation } = outcome;
        const confirmed = await this.ctx.dialogs.confirm({
          title: confirmation.title,
          message: confirmation.message,
          confirmLabel: confirmation.confirmLabel,
        });
        if (!confirmed) {
          vm.cancelConfirmation();
          return;
        }
        const result = await vm.confirm(confirmation.id);
        if (!result.ok) this.fail("Commit failed", result.error);
        else if ("shortOid" in result.value) {
          this.ctx.notifications.success(
            `Committed ${result.value.shortOid}`,
            committedMessage(result.value),
          );
        }
        return;
      }
      case "blocked":
        this.ctx.hints.flash({ text: outcome.reason });
        if (vm.state.commit.message.trim() === "" && vm.state.phase === "ready") this.commitFocus.emit();
        return;
      case "failed":
        this.fail(vm.state.commit.amend ? "Amend failed" : "Commit failed", outcome.error);
        return;
    }
  }

  /**
   * Commit (Amend): turns amend on (the previous message is filled in) and puts the cursor in
   * the commit box; with amend already on and a message, it commits.
   */
  async commitAmend(): Promise<void> {
    const vm = this.vm;
    if (vm.state.commit.amend && vm.state.commit.button.enabled) {
      await this.commit();
      return;
    }
    if (!vm.state.commit.canAmend) {
      this.ctx.hints.flash({ text: "There is no commit to amend yet" });
      return;
    }
    await vm.setAmend(true);
    await this.focusCommitInput();
    this.ctx.hints.flash({
      text: "Edit the message, then commit",
      keys: this.ctx.keybindingFor("git.commit"),
    });
  }

  async toggleAmend(): Promise<void> {
    await this.vm.setAmend(!this.vm.state.commit.amend);
  }

  // ---------------------------------------------------------------- refresh

  /** Refreshes every repository and searches for repositories that appeared or disappeared. */
  async refresh(): Promise<void> {
    await this.refreshAll();
    const state = this.git.state;
    if (state.error && state.repo)
      this.ctx.notifications.error("Refresh failed", describeFailure(state.error));
  }

  // ---------------------------------------------------------------- branches

  private branchDescription(branch: GitBranch): string {
    const tier = this.ctx.themes.current.icons;
    const parts: string[] = [];
    if (branch.ahead) parts.push(`${icon("arrowUp", tier)}${branch.ahead}`);
    if (branch.behind) parts.push(`${icon("arrowDown", tier)}${branch.behind}`);
    if (branch.upstreamGone) parts.push("upstream gone");
    else if (branch.upstream) parts.push(branch.upstream);
    return parts.join("  ");
  }

  /** The branch picker: create, local branches, then remote-tracking branches. */
  async checkout(): Promise<void> {
    let list: Awaited<ReturnType<GitService["branches"]>>;
    try {
      list = await this.git.branches();
    } catch (error) {
      this.fail("Could not list branches", error);
      return;
    }
    const localNames = new Set(list.local.map((branch) => branch.name));
    const items: QuickPickItem[] = [
      { id: "create", label: "Create new branch…", icon: "add", description: "from the current commit" },
      ...list.local.map(
        (branch): QuickPickItem => ({
          id: `local:${branch.name}`,
          label: branch.name,
          icon: "branch",
          description: this.branchDescription(branch) || undefined,
          current: branch.isCurrent,
          group: "branches",
        }),
      ),
      ...list.remote
        .filter((branch) => !localNames.has(localNameForRemote(branch.name, branch.remote)))
        .map(
          (branch): QuickPickItem => ({
            id: `remote:${branch.name}`,
            label: branch.name,
            icon: "sourceControl",
            description: "remote branch",
            group: "remote branches",
          }),
        ),
    ];
    const picked = await this.ctx.quickPick.pick({
      title: "Switch Branch",
      placeholder: list.current ? `Switch from ${list.current}, or create a branch` : "Select a branch",
      items,
      activeId: list.current ? `local:${list.current}` : undefined,
    });
    if (!picked) return;
    if (picked.id === "create") {
      await this.createBranch();
      return;
    }
    if (picked.id.startsWith("local:")) {
      const name = picked.id.slice("local:".length);
      if (name === list.current) {
        this.ctx.hints.flash({ text: `Already on ${name}` });
        return;
      }
      await this.switchTo(name);
      return;
    }
    const remoteName = picked.id.slice("remote:".length);
    const remote = list.remote.find((branch) => branch.name === remoteName);
    const localName = localNameForRemote(remoteName, remote?.remote);
    try {
      await this.git.createBranch(localName, { from: remoteName, switch: true });
      this.ctx.notifications.success(`Switched to ${localName}`, `Tracking ${remoteName}.`);
    } catch (error) {
      this.fail(`Could not check out ${remoteName}`, error);
    }
  }

  private async switchTo(name: string): Promise<void> {
    try {
      await this.git.switchBranch(name);
      this.ctx.notifications.success(`Switched to ${name}`);
    } catch (error) {
      this.fail(`Could not switch to ${name}`, error);
    }
  }

  async createBranch(): Promise<void> {
    const from = this.git.state.status?.branch;
    const name = await this.ctx.dialogs.prompt({
      title: "Create Branch",
      message: from?.name ? `The new branch starts at ${from.name} and becomes current.` : undefined,
      placeholder: "feature/short-description",
      confirmLabel: "Create Branch",
      validate: branchNameProblem,
    });
    if (name === undefined) return;
    try {
      await this.git.createBranch(name.trim(), { switch: true });
      this.ctx.notifications.success(`Created ${name.trim()}`, "Switched to the new branch.");
    } catch (error) {
      this.fail("Could not create the branch", error);
    }
  }

  // ---------------------------------------------------------------- remotes

  async fetch(): Promise<void> {
    try {
      await this.git.fetch({ timeoutMs: this.networkTimeout() });
      const branch = this.git.state.status?.branch;
      const behind = branch?.behind ?? 0;
      this.ctx.notifications.success(
        "Fetched",
        branch?.upstream
          ? behind > 0
            ? `${plural(behind, "commit")} to pull into ${branch.name ?? "HEAD"}.`
            : `${branch.name ?? "HEAD"} is up to date with ${branch.upstream}.`
          : undefined,
      );
    } catch (error) {
      this.fail("Fetch failed", error);
    }
  }

  /** Pull, fast-forward only: it never creates a merge commit or rewrites history. */
  async pull(): Promise<void> {
    const before = this.git.state.status?.branch;
    if (before && !before.upstream) {
      this.ctx.notifications.info(
        "Nothing to pull",
        `${before.name ?? "This branch"} has no upstream branch yet.`,
      );
      return;
    }
    try {
      await this.git.pull({ ffOnly: true, timeoutMs: this.networkTimeout() });
      const pulled = before?.behind ?? 0;
      this.ctx.notifications.success(
        pulled > 0 ? `Pulled ${plural(pulled, "commit")}` : "Pulled",
        pulled > 0 ? `${before?.name ?? "HEAD"} is now up to date.` : "Already up to date.",
      );
    } catch (error) {
      this.fail("Pull failed", error);
    }
  }

  /**
   * Push. Without an upstream it offers to publish the branch (choosing the remote when there
   * are several); with `git.confirmPush` it asks first. Never forces.
   */
  async push(): Promise<void> {
    const status = this.git.state.status;
    const branch = status?.branch;
    if (!branch?.name) {
      this.ctx.notifications.warn("Nothing to push", "HEAD is detached. Create a branch first.");
      return;
    }
    if (!branch.upstream) {
      await this.publish(branch.name);
      return;
    }
    const ahead = branch.ahead ?? 0;
    if (ahead === 0) {
      this.ctx.hints.flash({ text: `${branch.name} has no commits to push` });
      return;
    }
    if (this.ctx.config.get("git.confirmPush")) {
      const confirmed = await this.ctx.dialogs.confirm({
        title: `Push to ${branch.upstream}?`,
        message: `${plural(ahead, "commit")} on ${branch.name} will be pushed to ${branch.upstream}.`,
        confirmLabel: "Push",
      });
      if (!confirmed) return;
    }
    try {
      await this.git.push({ timeoutMs: this.networkTimeout() });
      this.ctx.notifications.success(
        `Pushed to ${branch.upstream}`,
        `${plural(ahead, "commit")} from ${branch.name}.`,
      );
    } catch (error) {
      this.fail("Push failed", error);
    }
  }

  private async publish(name: string): Promise<void> {
    let remotes: Awaited<ReturnType<GitService["remotes"]>>;
    try {
      remotes = await this.git.remotes();
    } catch (error) {
      this.fail("Could not list remotes", error);
      return;
    }
    if (remotes.length === 0) {
      this.ctx.notifications.warn(
        "No remote to push to",
        "Add a remote with `git remote add` in a terminal.",
      );
      return;
    }
    let remote = remotes.length === 1 ? remotes[0]?.name : undefined;
    if (!remote) {
      const picked = await this.ctx.quickPick.pick({
        title: `Publish ${name}`,
        placeholder: "Choose the remote to publish to",
        items: remotes.map((entry) => ({
          id: entry.name,
          label: entry.name,
          description: entry.pushUrl ?? entry.fetchUrl ?? undefined,
          icon: "sourceControl" as const,
        })),
        activeId: remotes.some((entry) => entry.name === "origin") ? "origin" : undefined,
      });
      if (!picked) return;
      remote = picked.id;
    }
    const confirmed = await this.ctx.dialogs.confirm({
      title: `Publish ${name}?`,
      message: `${name} has no upstream branch. Push it to ${remote} and track ${remote}/${name}?`,
      confirmLabel: "Publish Branch",
    });
    if (!confirmed) return;
    try {
      await this.git.push({ setUpstream: true, remote, timeoutMs: this.networkTimeout() });
      this.ctx.notifications.success(`Published ${name}`, `Now tracking ${remote}/${name}.`);
    } catch (error) {
      this.fail("Publish failed", error);
    }
  }

  /** The status-bar sync menu: Fetch, Pull, Push, anchored above the sync item. */
  showSyncMenu(anchor: { x: number; y: number }): void {
    const branch = this.git.state.status?.branch;
    const ahead = branch?.ahead ?? 0;
    const behind = branch?.behind ?? 0;
    this.ctx.menus.show({
      x: anchor.x,
      y: anchor.y,
      items: [
        { id: "fetch", label: "Fetch", icon: "sync", command: "git.fetch" },
        {
          id: "pull",
          label: behind > 0 ? `Pull ${behind}` : "Pull",
          icon: "arrowDown",
          command: "git.pull",
          disabled: !branch?.upstream,
        },
        {
          id: "push",
          label: branch?.upstream ? (ahead > 0 ? `Push ${ahead}` : "Push") : "Publish Branch",
          icon: "arrowUp",
          command: "git.push",
          disabled: !branch?.name,
        },
      ],
    });
  }

  // ---------------------------------------------------------------- stash

  async stash(includeUntracked: boolean): Promise<void> {
    const message = await this.ctx.dialogs.prompt({
      title: includeUntracked ? "Stash All Changes" : "Stash Changes",
      message: includeUntracked
        ? "Tracked and untracked changes are put aside; the working tree becomes clean."
        : "Tracked changes are put aside; untracked files stay.",
      placeholder: "Message (optional)",
      confirmLabel: "Stash",
    });
    if (message === undefined) return;
    try {
      const result = await this.git.stashPush({ message: message.trim() || undefined, includeUntracked });
      if (result.created) this.ctx.notifications.success("Changes stashed", message.trim() || undefined);
      else this.ctx.notifications.info("Nothing to stash", "There are no local changes to put aside.");
    } catch (error) {
      this.fail("Stash failed", error);
    }
  }

  private async pickStash(title: string): Promise<GitStash | undefined> {
    let stashes: GitStash[];
    try {
      stashes = await this.git.stashList();
    } catch (error) {
      this.fail("Could not list stashes", error);
      return undefined;
    }
    if (stashes.length === 0) {
      this.ctx.notifications.info("There are no stashes");
      return undefined;
    }
    const picked = await this.ctx.quickPick.pick({
      title,
      placeholder: "Select a stash",
      items: stashes.map((stash) => ({
        id: String(stash.index),
        label: stash.message,
        description: [stash.ref, relativeTime(stash.date)].filter(Boolean).join("  "),
        icon: "more" as const,
      })),
      matchOnDescription: true,
    });
    return picked ? stashes.find((stash) => String(stash.index) === picked.id) : undefined;
  }

  async stashApply(pop: boolean): Promise<void> {
    const stash = await this.pickStash(pop ? "Pop Stash" : "Apply Stash");
    if (!stash) return;
    try {
      if (pop) await this.git.stashPop(stash.index);
      else await this.git.stashApply(stash.index);
      this.ctx.notifications.success(pop ? "Stash popped" : "Stash applied", stash.message);
    } catch (error) {
      const kind = gitFailureKind(error);
      this.fail(
        kind === "conflicts" ? "The stash was applied with conflicts" : pop ? "Pop failed" : "Apply failed",
        error,
      );
    }
  }

  // ---------------------------------------------------------------- history

  /** Read-only list of recent commits; choosing one shows its full message. */
  async history(): Promise<void> {
    let commits: GitCommit[];
    try {
      commits = await this.git.log({ limit: 200 });
    } catch (error) {
      this.fail("Could not read the history", error);
      return;
    }
    if (commits.length === 0) {
      this.ctx.notifications.info("No commits yet", "This branch has no history.");
      return;
    }
    const picked = await this.ctx.quickPick.pick({
      title: "Commit History",
      placeholder: "Search commit messages, authors and ids",
      items: commits.map((commit) => ({
        id: commit.oid,
        label: sanitizeForDisplay(commit.subject),
        description: `${commit.shortOid}  ${sanitizeForDisplay(commit.authorName)}  ${relativeTime(commit.authorDate)}`,
        icon: "check" as const,
      })),
      matchOnDescription: true,
    });
    if (!picked) return;
    const commit = commits.find((candidate) => candidate.oid === picked.id);
    if (!commit) return;
    this.ctx.notifications.show({
      severity: "info",
      title: commitSummary(commit.shortOid, sanitizeForDisplay(commit.subject)),
      message: [
        `${commit.authorName}, ${relativeTime(commit.authorDate)}`,
        commit.body ? commit.body.split("\n").slice(0, 4).join(" ") : "",
      ]
        .filter(Boolean)
        .join(". "),
      timeoutMs: 8000,
    });
  }

  dispose(): void {
    this.multiSubscriptions.dispose();
    this.disposables.dispose();
    this.diffActions.dispose();
    this.commitFocus.dispose();
  }
}
