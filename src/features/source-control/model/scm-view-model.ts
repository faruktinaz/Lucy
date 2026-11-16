/**
 * View-model of the Source Control panel: everything the panel, the activity-bar badge and the
 * status bar need, as plain data in a `Store`, plus the actions behind every button and key.
 *
 * It owns UI state only (collapsed sections, selection, commit draft, pending confirmation) and
 * derives the rest from `GitService.store`. Destructive actions are two-step: `requestDiscard`
 * returns what would be lost and nothing happens until `confirm(id)` is called with that id.
 * Actions never throw; they return a result and record the failure in `state.lastError`.
 */
import {
  type GitCommitResult,
  type GitDiscardPreviewEntry,
  type GitDiscardResult,
  type GitFailureKind,
  type GitOperation,
  type GitOperationName,
  type GitService,
  type GitState,
  type GitStatus,
  gitFailureKind,
} from "@/adapters/git";
import { errorMessage, isLucyError, LucyError } from "@/core/errors";
import type { Disposable } from "@/core/events";
import { Store } from "@/core/store";
import { plural } from "@/core/text";
import { type CommitBoxState, computeCommitBox } from "./commit-box";
import {
  itemsFromStatus,
  SCM_SECTION_ORDER,
  SCM_SECTION_TITLES,
  type ScmGroup,
  type ScmItem,
  type ScmItemsByGroup,
  type ScmSection,
  sectionKey,
} from "./scm-items";

export type ScmRow =
  | { readonly kind: "section"; readonly key: string; readonly section: ScmSection }
  | { readonly kind: "item"; readonly key: string; readonly item: ScmItem };

export type ScmPhase = "idle" | "loading" | "ready" | "unavailable";

export type ScmProblemKind =
  | "no-repository"
  | "git-missing"
  | "git-too-old"
  | "unsafe-repository"
  | "bare-repository"
  | "error";

export interface ScmProblem {
  readonly kind: ScmProblemKind;
  readonly title: string;
  readonly detail: string;
}

export interface ScmBranchInfo {
  readonly name: string | null;
  /** Branch name, or the short commit id when detached. */
  readonly label: string;
  readonly detached: boolean;
  readonly unborn: boolean;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
}

export interface ScmDiscardSummary {
  readonly restore: number;
  readonly delete: number;
  readonly blocked: number;
  readonly unchanged: number;
  /** Lines that exist only in the working tree and would be lost (known text files only). */
  readonly linesLost: number;
  /** Bytes of untracked files that would be deleted. */
  readonly bytes: number;
}

export interface ScmDiscardConfirmation {
  readonly kind: "discard";
  readonly id: number;
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  /** `false` when nothing can be discarded or a path is blocked (conflict, directory, submodule). */
  readonly canConfirm: boolean;
  readonly entries: readonly GitDiscardPreviewEntry[];
  readonly summary: ScmDiscardSummary;
}

export interface ScmStageAllCommitConfirmation {
  readonly kind: "stage-all-and-commit";
  readonly id: number;
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly canConfirm: true;
  readonly changeCount: number;
}

export type ScmConfirmation = ScmDiscardConfirmation | ScmStageAllCommitConfirmation;

export interface ScmActionError {
  readonly operation: string;
  readonly message: string;
  readonly kind: GitFailureKind | null;
  readonly error: LucyError;
}

export interface ScmState {
  readonly phase: ScmPhase;
  /** A refresh is running. */
  readonly loading: boolean;
  /** Why there is no list (no repository, Git missing, ...). */
  readonly problem: ScmProblem | null;
  /** A refresh failed while an older list is still shown. */
  readonly warning: string | null;
  readonly sections: readonly ScmSection[];
  /** Section headers and the items of expanded sections, in display order. */
  readonly rows: readonly ScmRow[];
  readonly selectedKey: string | null;
  /** Index of `selectedKey` in `rows`, or -1. */
  readonly selectedIndex: number;
  readonly commit: CommitBoxState;
  /** Activity-bar badge: items across all sections (VS Code counts a staged-and-modified file twice). */
  readonly badgeCount: number;
  readonly branch: ScmBranchInfo | null;
  readonly operation: GitOperation | null;
  /** "Merging", "Rebasing", ... */
  readonly operationLabel: string | null;
  /** Shown above the list when it is incomplete. */
  readonly notice: string | null;
  readonly busyOperation: GitOperationName | null;
  readonly confirmation: ScmConfirmation | null;
  readonly lastError: ScmActionError | null;
}

export type ScmActionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: LucyError };

export type ScmCommitOutcome =
  | { readonly kind: "committed"; readonly result: GitCommitResult }
  | { readonly kind: "needs-confirmation"; readonly confirmation: ScmStageAllCommitConfirmation }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "failed"; readonly error: LucyError };

/** The commit-message draft, for workspace persistence. */
export interface CommitDraft {
  readonly message: string;
  readonly amend: boolean;
  /** The user's own draft, kept while amend shows the previous commit message. */
  readonly savedMessage: string | null;
}

export type ScmDiscardTarget = ScmItem | readonly ScmItem[] | "changes" | "untracked" | "all";

const OPERATION_LABELS: Readonly<Record<GitOperation, string>> = {
  merge: "Merging",
  rebase: "Rebasing",
  am: "Applying patches",
  "cherry-pick": "Cherry-picking",
  revert: "Reverting",
  bisect: "Bisecting",
};

function toLucyError(error: unknown): LucyError {
  return isLucyError(error) ? error : new LucyError("INTERNAL", errorMessage(error), { cause: error });
}

function shallowEqual(a: object | null, b: object | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = Object.keys(ra);
  if (keys.length !== Object.keys(rb).length) return false;
  return keys.every((key) => Object.is(ra[key], rb[key]));
}

function sameCommitBox(a: CommitBoxState, b: CommitBoxState): boolean {
  return shallowEqual({ ...a, button: null }, { ...b, button: null }) && shallowEqual(a.button, b.button);
}

/** Maps a refresh error to the empty-state explanation shown instead of the list. */
export function describeProblem(error: LucyError): ScmProblem {
  switch (gitFailureKind(error)) {
    case "not-a-repository":
      return {
        kind: "no-repository",
        title: "No Git repository",
        detail:
          "This folder is not inside a Git repository. Run `git init` in a terminal to start tracking changes.",
      };
    case "git-missing":
      return {
        kind: "git-missing",
        title: "Git is not installed",
        detail: "Lucy could not find the `git` program. Install Git, make sure it is on PATH, then refresh.",
      };
    case "git-too-old":
      return { kind: "git-too-old", title: "Git is too old", detail: error.message };
    case "unsafe-repository":
      return { kind: "unsafe-repository", title: "Repository not trusted by Git", detail: error.message };
    case "bare-repository":
      return { kind: "bare-repository", title: "Bare repository", detail: error.message };
    default:
      return { kind: "error", title: "Git is unavailable", detail: error.message };
  }
}

function truncationNotice(status: GitStatus): string | null {
  if (!status.truncated) return null;
  if (status.truncatedReason === "untracked-timeout") {
    return "Untracked folders are shown collapsed: listing every untracked file took too long.";
  }
  return `Too many changes: only the first ${status.changes.length.toLocaleString("en-US")} are listed.`;
}

export class ScmViewModel implements Disposable {
  readonly store: Store<ScmState>;
  private readonly unsubscribe: () => void;
  private disposed = false;

  private readonly collapsed = new Set<ScmGroup>();
  private selectedKey: string | null = null;
  private message = "";
  private amend = false;
  private savedMessage: string | null = null;
  private amendRequest = 0;
  private committing = false;
  private confirmation: ScmConfirmation | null = null;
  private nextConfirmationId = 1;
  private lastError: ScmActionError | null = null;

  private items: ScmItemsByGroup = itemsFromStatus(null);
  private itemsStatus: GitStatus | null | undefined;
  private collapsedKey = "";
  private sections: readonly ScmSection[] = [];
  private rows: readonly ScmRow[] = [];
  private rowIndex = new Map<string, number>();

  constructor(private readonly git: GitService) {
    this.store = new Store<ScmState>(this.compute());
    this.unsubscribe = git.store.subscribe(() => this.publish());
  }

  get state(): ScmState {
    return this.store.get();
  }

  // ---------------------------------------------------------------- derivation

  private publish(): void {
    if (this.disposed) return;
    const next = this.compute();
    const prev = this.store.get();
    // Keep references stable where nothing changed so views can skip work.
    const merged: ScmState = {
      ...next,
      commit: sameCommitBox(prev.commit, next.commit) ? prev.commit : next.commit,
      branch: shallowEqual(prev.branch, next.branch) ? prev.branch : next.branch,
      problem: shallowEqual(prev.problem, next.problem) ? prev.problem : next.problem,
    };
    if (!shallowEqual(prev, merged)) this.store.set(merged);
  }

  private rebuildRows(status: GitStatus | null): void {
    const collapsedKey = [...this.collapsed].sort().join(",");
    if (status === this.itemsStatus && collapsedKey === this.collapsedKey) return;
    const previousRows = this.rows;
    const previousItems = this.items;
    if (status !== this.itemsStatus) {
      this.items = itemsFromStatus(status);
      this.itemsStatus = status;
    }
    this.collapsedKey = collapsedKey;

    const sections: ScmSection[] = [];
    const rows: ScmRow[] = [];
    for (const group of SCM_SECTION_ORDER) {
      const items = this.items[group];
      if (items.length === 0) continue;
      const section: ScmSection = {
        group,
        title: SCM_SECTION_TITLES[group],
        count: items.length,
        collapsed: this.collapsed.has(group),
      };
      sections.push(section);
      rows.push({ kind: "section", key: sectionKey(group), section });
      if (section.collapsed) continue;
      for (const item of items) rows.push({ kind: "item", key: item.key, item });
    }
    this.sections = sections;
    this.rows = rows;
    this.rowIndex = new Map(rows.map((row, index) => [row.key, index]));
    this.selectedKey = this.resolveSelection(previousRows, previousItems);
  }

  /**
   * Keeps the selection by identity (group + path). When the selected item left its group (for
   * example it was just staged), the item now at the same position in that group is selected,
   * like VS Code, so a user can stage files one after another. Then the same path in another
   * group, then the nearest row.
   */
  private resolveSelection(previousRows: readonly ScmRow[], previousItems: ScmItemsByGroup): string | null {
    const key = this.selectedKey;
    if (key === null || this.rowIndex.has(key)) return key;
    const previousIndex = previousRows.findIndex((row) => row.key === key);
    const previous = previousRows[previousIndex];
    if (previous?.kind === "item") {
      const { group, path } = previous.item;
      const items = this.items[group];
      const stillThere = items.some((item) => item.key === key);
      if (stillThere && this.rowIndex.has(sectionKey(group))) return sectionKey(group);
      const position = previousItems[group].findIndex((item) => item.key === key);
      if (items.length > 0 && !this.collapsed.has(group)) {
        return items[Math.min(Math.max(position, 0), items.length - 1)]?.key ?? null;
      }
      for (const other of SCM_SECTION_ORDER) {
        const match = this.items[other].find((item) => item.path === path);
        if (match && this.rowIndex.has(match.key)) return match.key;
      }
    }
    if (this.rows.length === 0) return null;
    return this.rows[Math.min(Math.max(previousIndex, 0), this.rows.length - 1)]?.key ?? null;
  }

  private compute(): ScmState {
    const gitState: GitState = this.git.state;
    const status = gitState.status;
    this.rebuildRows(status);

    let phase: ScmPhase;
    let problem: ScmProblem | null = null;
    let warning: string | null = null;
    if (status && gitState.repo) {
      phase = "ready";
      if (gitState.error) warning = gitState.error.message;
    } else if (gitState.error) {
      phase = "unavailable";
      problem = describeProblem(gitState.error);
    } else {
      phase = gitState.loading ? "loading" : "idle";
    }

    const counts = {
      conflicts: this.items.conflicts.length,
      staged: this.items.staged.length,
      changes: this.items.changes.length,
      untracked: this.items.untracked.length,
    };
    const branchStatus = status?.branch;
    const branch: ScmBranchInfo | null = branchStatus
      ? {
          name: branchStatus.name,
          label: branchStatus.name ?? branchStatus.oid?.slice(0, 7) ?? "HEAD",
          detached: branchStatus.detached,
          unborn: branchStatus.unborn,
          upstream: branchStatus.upstream ?? null,
          ahead: branchStatus.ahead ?? 0,
          behind: branchStatus.behind ?? 0,
        }
      : null;
    const operation = status?.operation ?? null;
    const commit = computeCommitBox({
      message: this.message,
      amend: this.amend,
      canAmend: branchStatus ? !branchStatus.unborn && branchStatus.oid !== null : false,
      repositoryReady: phase === "ready",
      staged: counts.staged,
      unstaged: counts.changes + counts.untracked,
      conflicts: counts.conflicts,
      operation,
      committing: this.committing,
      busy: gitState.busyOperation !== null,
    });

    return {
      phase,
      loading: gitState.loading,
      problem,
      warning,
      sections: this.sections,
      rows: this.rows,
      selectedKey: this.selectedKey,
      selectedIndex: this.selectedKey === null ? -1 : (this.rowIndex.get(this.selectedKey) ?? -1),
      commit,
      badgeCount: counts.conflicts + counts.staged + counts.changes + counts.untracked,
      branch,
      operation,
      operationLabel: operation ? OPERATION_LABELS[operation] : null,
      notice: status ? truncationNotice(status) : null,
      busyOperation: gitState.busyOperation,
      confirmation: this.confirmation,
      lastError: this.lastError,
    };
  }

  // ---------------------------------------------------------------- list queries

  /** Rows `[start, start + count)`, for a virtualized list. */
  visibleRows(start: number, count: number): readonly ScmRow[] {
    return this.state.rows.slice(Math.max(0, start), Math.max(0, start) + Math.max(0, count));
  }

  rowIndexOf(key: string): number {
    return this.rowIndex.get(key) ?? -1;
  }

  selectedRow(): ScmRow | null {
    const index = this.state.selectedIndex;
    return index === -1 ? null : (this.state.rows[index] ?? null);
  }

  selectedItem(): ScmItem | null {
    const row = this.selectedRow();
    return row?.kind === "item" ? row.item : null;
  }

  /** All items of a group, including those hidden by a collapsed section. */
  itemsOf(group: ScmGroup): readonly ScmItem[] {
    return this.items[group];
  }

  // ---------------------------------------------------------------- selection and keyboard

  select(key: string | null): void {
    if (key !== null && !this.rowIndex.has(key)) return;
    this.selectedKey = key;
    this.publish();
  }

  selectIndex(index: number): void {
    const rows = this.state.rows;
    if (rows.length === 0) {
      this.select(null);
      return;
    }
    this.select(rows[Math.min(Math.max(index, 0), rows.length - 1)]?.key ?? null);
  }

  /** Moves the selection by `delta` rows (arrows, page keys), clamped to the list. */
  moveSelection(delta: number): void {
    const rows = this.state.rows;
    if (rows.length === 0) return;
    const current = this.state.selectedIndex;
    if (current === -1) {
      this.selectIndex(delta >= 0 ? 0 : rows.length - 1);
      return;
    }
    this.selectIndex(current + delta);
  }

  selectFirst(): void {
    this.selectIndex(0);
  }

  selectLast(): void {
    this.selectIndex(this.state.rows.length - 1);
  }

  /** Left arrow: from an item to its section header; on an expanded header, collapse it. */
  selectParentOrCollapse(): void {
    const row = this.selectedRow();
    if (!row) return;
    if (row.kind === "item") {
      this.select(sectionKey(row.item.group));
      return;
    }
    if (!row.section.collapsed) this.setCollapsed(row.section.group, true);
  }

  /** Right arrow: expand a collapsed header, or move into its first item. */
  expandOrSelectChild(): void {
    const row = this.selectedRow();
    if (row?.kind !== "section") return;
    if (row.section.collapsed) {
      this.setCollapsed(row.section.group, false);
      return;
    }
    const first = this.items[row.section.group][0];
    if (first) this.select(first.key);
  }

  toggleSection(group: ScmGroup): void {
    this.setCollapsed(group, !this.collapsed.has(group));
  }

  setCollapsed(group: ScmGroup, collapsed: boolean): void {
    if (collapsed === this.collapsed.has(group)) return;
    if (collapsed) {
      this.collapsed.add(group);
      // Keep the selection visible: an item inside the collapsing section moves to its header.
      const selected = this.selectedItem();
      if (selected?.group === group) this.selectedKey = sectionKey(group);
    } else {
      this.collapsed.delete(group);
    }
    this.publish();
  }

  // ---------------------------------------------------------------- actions

  private async run<T>(operation: string, task: () => Promise<T>): Promise<ScmActionResult<T>> {
    try {
      const value = await task();
      return { ok: true, value };
    } catch (error) {
      const failure = toLucyError(error);
      this.lastError = { operation, message: failure.message, kind: gitFailureKind(failure), error: failure };
      this.publish();
      return { ok: false, error: failure };
    }
  }

  dismissError(): void {
    if (!this.lastError) return;
    this.lastError = null;
    this.publish();
  }

  refresh(): Promise<GitState> {
    return this.git.refresh();
  }

  stage(items: ScmItem | readonly ScmItem[]): Promise<ScmActionResult<void>> {
    const paths = (Array.isArray(items) ? items : [items as ScmItem]).map((item) => item.path);
    return this.run("stage", () => this.git.stage(paths));
  }

  unstage(items: ScmItem | readonly ScmItem[]): Promise<ScmActionResult<void>> {
    const paths = (Array.isArray(items) ? items : [items as ScmItem]).map((item) => item.path);
    return this.run("unstage", () => this.git.unstage(paths));
  }

  /** Space/Enter on an item: unstage a staged item, stage anything else (conflicts: mark resolved). */
  toggleStage(item: ScmItem): Promise<ScmActionResult<void>> {
    return item.staged ? this.unstage(item) : this.stage(item);
  }

  /** Stages every item of a section. Staging Merge Changes marks those conflicts resolved. */
  stageSection(group: Exclude<ScmGroup, "staged">): Promise<ScmActionResult<void>> {
    const paths = this.items[group].map((item) => item.path);
    return this.run("stage", () => this.git.stage(paths));
  }

  unstageSection(group: "staged"): Promise<ScmActionResult<void>> {
    void group;
    return this.unstageAll();
  }

  /** Stages everything. Refused (with an error) while conflicts exist, see `GitService.stageAll`. */
  stageAll(): Promise<ScmActionResult<void>> {
    return this.run("stageAll", () => this.git.stageAll());
  }

  unstageAll(): Promise<ScmActionResult<void>> {
    return this.run("unstageAll", () => this.git.unstageAll());
  }

  private discardPaths(target: ScmDiscardTarget): string[] {
    if (target === "changes" || target === "untracked") return this.items[target].map((item) => item.path);
    if (target === "all") return [...this.items.changes, ...this.items.untracked].map((item) => item.path);
    const items = Array.isArray(target) ? target : [target as ScmItem];
    return items
      .filter((item) => item.group === "changes" || item.group === "untracked")
      .map((item) => item.path);
  }

  /**
   * First step of a discard: asks Git what would be lost and stores a confirmation for the
   * dialog. Nothing is changed until `confirm(confirmation.id)`.
   */
  async requestDiscard(target: ScmDiscardTarget): Promise<ScmActionResult<ScmDiscardConfirmation>> {
    const paths = [...new Set(this.discardPaths(target))];
    return this.run("discard", async () => {
      if (paths.length === 0) {
        throw new LucyError("INVALID_ARGUMENT", "Only unstaged and untracked changes can be discarded.");
      }
      const entries = await this.git.previewDiscard(paths);
      const confirmation = buildDiscardConfirmation(this.nextConfirmationId++, entries);
      this.confirmation = confirmation;
      this.publish();
      return confirmation;
    });
  }

  cancelConfirmation(): void {
    if (!this.confirmation) return;
    this.confirmation = null;
    this.publish();
  }

  /**
   * Second step of a discard or of "stage all and commit": runs the pending action, but only if
   * `id` is the id of the confirmation the user saw.
   */
  async confirm(id: number): Promise<ScmActionResult<GitDiscardResult | GitCommitResult>> {
    const pending = this.confirmation;
    if (!pending || pending.id !== id) {
      return this.run("confirm", () =>
        Promise.reject(new LucyError("INVALID_ARGUMENT", "This confirmation is no longer valid.")),
      );
    }
    this.confirmation = null;
    this.publish();
    if (pending.kind === "stage-all-and-commit") {
      const outcome = await this.performCommit(true);
      if (outcome.kind === "committed") return { ok: true, value: outcome.result };
      return {
        ok: false,
        error:
          outcome.kind === "failed"
            ? outcome.error
            : new LucyError("INVALID_ARGUMENT", "Commit was blocked."),
      };
    }
    if (!pending.canConfirm) {
      return this.run("discard", () => Promise.reject(new LucyError("INVALID_ARGUMENT", pending.message)));
    }
    const paths = pending.entries
      .filter((entry) => entry.action === "restore" || entry.action === "delete")
      .map((entry) => entry.path);
    return this.run("discard", () => this.git.discard(paths));
  }

  // ---------------------------------------------------------------- commit box

  setMessage(message: string): void {
    if (message === this.message) return;
    this.message = message;
    this.publish();
  }

  /**
   * Turning amend on keeps the user's draft aside and prefills the previous commit message;
   * turning it off restores the draft. A prefill that arrives after the user started typing
   * does not overwrite their text.
   */
  async setAmend(amend: boolean): Promise<void> {
    if (amend === this.amend) return;
    const request = ++this.amendRequest;
    if (!amend) {
      this.amend = false;
      this.message = this.savedMessage ?? "";
      this.savedMessage = null;
      this.publish();
      return;
    }
    this.amend = true;
    this.savedMessage = this.message;
    this.publish();
    const result = await this.run("amend", () => this.git.lastCommitMessage());
    if (request !== this.amendRequest || !this.amend || this.message !== this.savedMessage) return;
    if (result.ok) {
      this.message = result.value ?? "";
      this.publish();
    }
  }

  getDraft(): CommitDraft {
    return { message: this.message, amend: this.amend, savedMessage: this.savedMessage };
  }

  restoreDraft(draft: CommitDraft): void {
    this.amendRequest++;
    this.message = draft.message;
    this.amend = draft.amend;
    this.savedMessage = draft.amend ? draft.savedMessage : null;
    this.publish();
  }

  /**
   * Primary button. Commits when allowed; when nothing is staged it returns a confirmation to
   * stage everything first (VS Code-like) and does not commit.
   */
  async commit(): Promise<ScmCommitOutcome> {
    const button = this.state.commit.button;
    if (!button.enabled || button.action === "none") {
      return { kind: "blocked", reason: button.reason ?? "Committing is not possible right now." };
    }
    if (button.action === "stage-all-and-commit") {
      const changeCount = this.items.changes.length + this.items.untracked.length;
      const confirmation: ScmStageAllCommitConfirmation = {
        kind: "stage-all-and-commit",
        id: this.nextConfirmationId++,
        title: "Stage all changes and commit?",
        message: `There are no staged changes. Stage all ${plural(changeCount, "change")} and commit them directly?`,
        confirmLabel: "Stage All & Commit",
        canConfirm: true,
        changeCount,
      };
      this.confirmation = confirmation;
      this.publish();
      return { kind: "needs-confirmation", confirmation };
    }
    return this.performCommit(false);
  }

  private async performCommit(stageAllFirst: boolean): Promise<ScmCommitOutcome> {
    const message = this.message;
    const amend = this.amend;
    this.committing = true;
    this.publish();
    try {
      const result = await this.run("commit", async () => {
        if (stageAllFirst) await this.git.stageAll();
        return this.git.commit({ message, amend });
      });
      if (!result.ok) return { kind: "failed", error: result.error };
      // Keep anything the user typed while the commit ran.
      if (this.message === message) {
        this.message = "";
        this.amend = false;
        this.savedMessage = null;
        this.amendRequest++;
      }
      return { kind: "committed", result: result.value };
    } finally {
      this.committing = false;
      this.publish();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
  }
}

function buildDiscardConfirmation(
  id: number,
  entries: readonly GitDiscardPreviewEntry[],
): ScmDiscardConfirmation {
  let restore = 0;
  let remove = 0;
  let blocked = 0;
  let unchanged = 0;
  let linesLost = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (entry.action === "restore") restore++;
    else if (entry.action === "delete") {
      remove++;
      bytes += entry.bytes ?? 0;
    } else if (entry.action === "blocked") blocked++;
    else unchanged++;
    if (entry.action === "restore" || entry.action === "delete") linesLost += entry.linesLost ?? 0;
  }
  const summary: ScmDiscardSummary = { restore, delete: remove, blocked, unchanged, linesLost, bytes };
  const single = entries.length === 1 ? entries[0] : undefined;
  const name = single ? (single.path.split("/").filter(Boolean).pop() ?? single.path) : "";

  let title: string;
  let confirmLabel: string;
  if (single?.action === "delete") {
    title = `Delete "${name}"?`;
    confirmLabel = "Delete File";
  } else if (single) {
    title = `Discard changes in "${name}"?`;
    confirmLabel = "Discard Changes";
  } else if (remove > 0 && restore === 0) {
    title = `Delete ${plural(remove, "untracked file")}?`;
    confirmLabel = "Delete Files";
  } else {
    title = `Discard ${plural(restore + remove, "change")}?`;
    confirmLabel = "Discard All";
  }

  const parts: string[] = [];
  if (restore > 0) {
    parts.push(
      `Unstaged changes in ${plural(restore, "file")} will be lost${linesLost > 0 && remove === 0 ? ` (${plural(linesLost, "line")})` : ""}.`,
    );
  }
  if (remove > 0) parts.push(`${plural(remove, "untracked file")} will be deleted permanently.`);
  if (blocked > 0) {
    parts.push(
      `${plural(blocked, "item")} cannot be discarded here (merge conflicts, folders or submodules); nothing will be changed.`,
    );
  }
  const canConfirm = blocked === 0 && restore + remove > 0;
  if (restore + remove === 0 && blocked === 0) parts.push("There is nothing to discard.");
  else if (canConfirm) parts.push("This cannot be undone.");

  return { kind: "discard", id, title, message: parts.join(" "), confirmLabel, canConfirm, entries, summary };
}
