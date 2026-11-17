/**
 * The Source Control sidebar view: commit box, in-progress operation banner, notices, and the
 * Merge Changes / Staged Changes / Changes / Untracked sections as one virtualized list.
 *
 * Focus inside the view has two places: the list (default, arrows navigate) and the commit box
 * (`c` or a click enters it, Escape leaves it). Every row action is also a command, a key and a
 * context-menu entry; hover actions appear on the hovered or selected row only, so the list
 * stays calm.
 */
import type { MouseEvent, TextareaRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GitOperationName } from "@/adapters/git";
import { useApp, useFocusTarget, useKeyHandler, useStore } from "@/app/react";
import type { MenuItem } from "@/app/workbench/menus";
import type { ViewProps } from "@/app/workbench/views";
import { normalizeKey } from "@/core/keybindings";
import { displayWidth, sanitizeForDisplay, truncateEnd } from "@/core/text";
import { icon } from "@/themes/icons";
import { formatCount } from "@/ui/primitives/badge";
import { Button, IconButton } from "@/ui/primitives/button";
import type { HeaderAction } from "@/ui/primitives/headers";
import { FileIcon, Icon } from "@/ui/primitives/icon";
import { List, type ListRowState } from "@/ui/primitives/list";
import { Spinner, useDelayedFlag } from "@/ui/primitives/spinner";
import { EmptyState, ErrorState } from "@/ui/primitives/states";
import { attrs, Span } from "@/ui/primitives/text";
import { TextAreaField } from "@/ui/primitives/text-field";
import { Chevron, TreeRowContent } from "@/ui/primitives/tree";
import { usePointer } from "@/ui/primitives/use-pointer";
import { useDensity, useTheme } from "@/ui/theme/theme-context";
import { colorOf } from "@/ui/theme/ui-theme";
import type { MultiRepositoryState, RepositoryView, ScmController } from "../controller";
import type { ScmGroup, ScmItem, ScmRow, ScmSection, ScmState, ScmViewModel } from "../model";

const BUSY_LABELS: Readonly<Record<GitOperationName, string>> = {
  stage: "Staging",
  unstage: "Unstaging",
  stageAll: "Staging",
  unstageAll: "Unstaging",
  discard: "Discarding",
  commit: "Committing",
  switchBranch: "Switching branches",
  createBranch: "Creating the branch",
  stashPush: "Stashing",
  stashApply: "Applying the stash",
  stashPop: "Popping the stash",
  stashDrop: "Dropping the stash",
  fetch: "Fetching",
  pull: "Pulling",
  push: "Pushing",
};

const OPERATION_ADVICE: Readonly<Record<string, string>> = {
  merge: "Resolve the conflicts, stage them, then commit to finish the merge.",
  rebase: "Continue or abort the rebase in a terminal.",
  am: "Continue or abort applying the patches in a terminal.",
  "cherry-pick": "Commit to finish, or abort the cherry-pick in a terminal.",
  revert: "Commit to finish, or abort the revert in a terminal.",
  bisect: "Mark commits or reset the bisect in a terminal.",
};

type Area = "list" | "input";

function itemActions(
  controller: ScmController,
  item: ScmItem,
  app: ReturnType<typeof useApp>,
): HeaderAction[] {
  const open: HeaderAction = {
    icon: "goToFile",
    hint: { text: "Open File", keys: undefined },
    onPress: () => controller.openFile(item.path),
  };
  const discard: HeaderAction = {
    icon: "discard",
    hint: {
      text: item.group === "untracked" ? "Delete File" : "Discard Changes",
      keys: app.keybindingFor("git.discard"),
    },
    onPress: () => void controller.discard(item),
  };
  const stage: HeaderAction = {
    icon: "add",
    hint: {
      text: item.group === "conflicts" ? "Mark as Resolved" : "Stage Changes",
      keys: app.keybindingFor("git.stage"),
    },
    onPress: () => void controller.stageItem(item),
  };
  const unstage: HeaderAction = {
    icon: "remove",
    hint: { text: "Unstage Changes", keys: app.keybindingFor("git.unstage") },
    onPress: () => void controller.unstageItem(item),
  };
  switch (item.group) {
    case "staged":
      return [open, unstage];
    case "conflicts":
      return [open, stage];
    default:
      return [open, discard, stage];
  }
}

function sectionActions(controller: ScmController, group: ScmGroup): HeaderAction[] {
  switch (group) {
    case "staged":
      return [
        {
          icon: "remove",
          hint: { text: "Unstage All Changes" },
          onPress: () => void controller.unstageAll(),
        },
      ];
    case "conflicts":
      return [
        {
          icon: "add",
          hint: { text: "Mark All as Resolved" },
          onPress: () => void controller.stageSection("conflicts"),
        },
      ];
    case "changes":
    case "untracked":
      return [
        {
          icon: "discard",
          hint: { text: group === "untracked" ? "Delete All Untracked Files" : "Discard All Changes" },
          onPress: () => void controller.discard(group),
        },
        {
          icon: "add",
          hint: { text: "Stage All Changes" },
          onPress: () => void controller.stageSection(group),
        },
      ];
  }
}

function itemMenu(controller: ScmController, item: ScmItem): MenuItem[] {
  const items: MenuItem[] = [
    {
      id: "open-changes",
      label: "Open Changes",
      run: () => controller.openDiff(item, { preview: false, focus: true }),
    },
    { id: "open-file", label: "Open File", icon: "goToFile", run: () => controller.openFile(item.path) },
    { id: "sep", kind: "separator" },
  ];
  if (item.group === "staged") {
    items.push({ id: "unstage", label: "Unstage Changes", icon: "remove", command: "git.unstage" });
  } else {
    items.push({
      id: "stage",
      label: item.group === "conflicts" ? "Mark as Resolved" : "Stage Changes",
      icon: "add",
      command: "git.stage",
    });
  }
  if (item.group === "changes" || item.group === "untracked") {
    items.push({
      id: "discard",
      label: item.group === "untracked" ? "Delete File…" : "Discard Changes…",
      icon: "discard",
      command: "git.discard",
      danger: true,
    });
  }
  return items;
}

function sectionMenu(controller: ScmController, section: ScmSection): MenuItem[] {
  const vm = controller.vm;
  const items: MenuItem[] = [];
  if (section.group === "staged") {
    items.push({
      id: "unstage-all",
      label: "Unstage All Changes",
      icon: "remove",
      command: "git.unstageAll",
    });
  } else {
    const group = section.group;
    items.push({
      id: "stage-section",
      label: group === "conflicts" ? "Mark All as Resolved" : "Stage All Changes",
      icon: "add",
      run: () => void controller.stageSection(group),
    });
  }
  if (section.group === "changes" || section.group === "untracked") {
    const group = section.group;
    items.push({
      id: "discard-section",
      label: group === "untracked" ? "Delete All Untracked Files…" : "Discard All Changes…",
      icon: "discard",
      run: () => void controller.discard(group),
      danger: true,
    });
  }
  items.push({ id: "sep", kind: "separator" });
  items.push({
    id: "toggle",
    label: section.collapsed ? "Expand" : "Collapse",
    icon: section.collapsed ? "chevronRight" : "chevronDown",
    run: () => vm.toggleSection(section.group),
  });
  return items;
}

/** Hover actions act on the active repository: make the row's repository active first. */
function withActivation(actions: HeaderAction[], activate: (() => void) | undefined): HeaderAction[] {
  if (!activate) return actions;
  return actions.map((action) => ({
    ...action,
    onPress: () => {
      activate();
      action.onPress();
    },
  }));
}

/** Contents of one list row. A component (not a render function) so it can use hooks. */
function ScmListRow({
  row,
  state,
  controller,
  onOpen,
  vm: rowVm,
  activate,
}: {
  row: ScmRow;
  state: ListRowState;
  controller: ScmController;
  onOpen: (row: ScmRow, keep: boolean) => void;
  /** The row's repository (several repositories); defaults to the active one. */
  vm?: ScmViewModel;
  /** Makes the row's repository active before anything acts on it. */
  activate?: () => void;
}) {
  const app = useApp();
  const theme = useTheme();
  const c = theme.colors;
  const vm = rowVm ?? controller.vm;
  const pointer = usePointer({
    onClick: () => {
      activate?.();
      vm.select(row.key);
      if (row.kind === "section") vm.toggleSection(row.section.group);
      else onOpen(row, false);
    },
    onDoubleClick: () => {
      activate?.();
      if (row.kind === "item") onOpen(row, true);
    },
    onContextMenu: (event: MouseEvent) => {
      activate?.();
      vm.select(row.key);
      app.menus.show({
        x: event.x,
        y: event.y,
        items: row.kind === "item" ? itemMenu(controller, row.item) : sectionMenu(controller, row.section),
      });
    },
  });
  const showActions = state.hovered || state.selected;
  const surface = state.selected
    ? state.active
      ? c.state.selectedBg
      : c.state.selectedInactiveBg
    : state.hovered
      ? c.state.hover
      : undefined;

  if (row.kind === "section") {
    const { section } = row;
    const actions = showActions ? withActivation(sectionActions(controller, section.group), activate) : [];
    const titleColor = state.active ? c.state.selectedFg : c.fg.muted;
    return (
      <box flexGrow={1} flexDirection="row" height={1} {...pointer.props}>
        <text flexGrow={1} flexShrink={1} selectable={false} wrapMode="none" fg={titleColor}>
          <Chevron expandable expanded={!section.collapsed} />
          <Span color={titleColor} bold>
            {section.title.toUpperCase()}
          </Span>
          <Span tone="subtle">{`  ${formatCount(section.count, 4)}`}</Span>
        </text>
        {actions.map((action) => (
          <IconButton
            key={action.icon}
            icon={action.icon}
            hint={action.hint}
            onPress={action.onPress}
            surface={surface}
          />
        ))}
      </box>
    );
  }

  const { item } = row;
  const actions = showActions ? withActivation(itemActions(controller, item, app), activate) : [];
  const statusWidth = displayWidth(item.letter) + 1;
  const actionsWidth = actions.length * 3;
  const statusColor = colorOf(theme, item.tokenName);
  return (
    <box flexGrow={1} flexDirection="row" height={1} {...pointer.props}>
      <TreeRowContent
        depth={0}
        icon={<FileIcon name={item.fileName} color={state.active ? c.state.selectedFg : undefined} />}
        label={item.label}
        description={item.description}
        strikethrough={item.status === "deleted"}
        state={{ ...state, width: Math.max(4, state.width - actionsWidth - statusWidth) }}
      />
      {actions.map((action) => (
        <IconButton
          key={action.icon}
          icon={action.icon}
          hint={action.hint}
          onPress={action.onPress}
          surface={surface}
        />
      ))}
      <text
        flexShrink={0}
        selectable={false}
        fg={statusColor}
        attributes={attrs({ bold: theme.highContrast })}
      >
        {` ${item.letter}`}
      </text>
    </box>
  );
}

function CommitBox({
  controller,
  state,
  area,
  zoneFocused,
  textarea,
  target,
}: {
  controller: ScmController;
  state: ScmState;
  area: Area;
  zoneFocused: boolean;
  textarea: React.RefObject<TextareaRenderable | null>;
  /** With several repositories: the repository the commit goes to. */
  target?: string;
}) {
  const app = useApp();
  const theme = useTheme();
  const density = useDensity();
  const vm = controller.vm;
  const commit = state.commit;
  const branch = state.branch?.label;
  const keys = app.keybindingLabel("git.commit");
  const placeholder = `Message (${keys ? `${keys} to commit` : "commit"}${branch ? ` on ${branch}` : ""})`;
  const lines = commit.message.split("\n").length;
  const height = Math.max(3, Math.min(8, lines));
  const inputActive = area === "input" && zoneFocused;

  // The model is the source of truth: a commit clears it, amend fills in the last message.
  useEffect(() => {
    const area = textarea.current;
    if (area && area.plainText !== commit.message) area.setText(commit.message);
  }, [commit.message, textarea]);

  return (
    <box flexDirection="column" flexShrink={0} paddingX={density.rowPaddingX} paddingTop={1}>
      {target ? (
        <text selectable={false} wrapMode="none" fg={theme.colors.fg.muted} marginBottom={0}>
          {"Commit to "}
          <Span bold>{target}</Span>
          {branch ? <Span tone="subtle">{` on ${branch}`}</Span> : null}
        </text>
      ) : null}
      <TextAreaField
        ref={textarea}
        initialValue={commit.message}
        placeholder={placeholder}
        focused={inputActive}
        height={height}
        onContentChange={(value) => vm.setMessage(value)}
        onSubmit={() => void controller.commit()}
      />
      <box flexDirection="row" flexWrap="wrap" flexShrink={0} marginTop={1} columnGap={1} rowGap={0}>
        <Button
          label={commit.button.label}
          variant="primary"
          icon={commit.button.action === "none" && !commit.busy ? undefined : "check"}
          disabled={!commit.button.enabled}
          onPress={() => void controller.commit()}
          hint={{
            text: commit.button.reason ?? "Commit the staged changes",
            keys: app.keybindingFor("git.commit"),
          }}
        />
        <Button
          label="Amend"
          icon={commit.amend ? "check" : undefined}
          disabled={!commit.canAmend || commit.busy}
          focused={false}
          onPress={() => void controller.toggleAmend()}
          hint={{
            text: commit.amend ? "Amending the last commit; press to stop" : "Amend the last commit instead",
          }}
        />
      </box>
      {commit.hint && (inputActive || commit.message.length > 0) ? (
        <text selectable={false} wrapMode="word" fg={theme.colors.fg.subtle} marginTop={1}>
          {commit.hint}
        </text>
      ) : null}
    </box>
  );
}

function OperationBanner({ state }: { state: ScmState }) {
  const theme = useTheme();
  const density = useDensity();
  if (!state.operation || !state.operationLabel) return null;
  return (
    <box flexDirection="column" flexShrink={0} paddingX={density.rowPaddingX} marginTop={1}>
      <text selectable={false} wrapMode="word" fg={theme.colors.fg.muted}>
        <Icon name="warning" color={theme.colors.status.warning} />
        <Span bold>{state.operationLabel}</Span>
        <Span tone="muted">{`  ${OPERATION_ADVICE[state.operation] ?? ""}`}</Span>
      </text>
    </box>
  );
}

function Notices({ state }: { state: ScmState }) {
  const theme = useTheme();
  const density = useDensity();
  const busy = useDelayedFlag(state.busyOperation !== null && state.busyOperation !== "commit");
  const notes: { key: string; node: React.ReactNode }[] = [];
  if (busy && state.busyOperation) {
    notes.push({
      key: "busy",
      node: <Spinner label={`${BUSY_LABELS[state.busyOperation]}…`} tone="muted" delayMs={0} />,
    });
  }
  if (state.warning) {
    notes.push({
      key: "warning",
      node: (
        <>
          <Icon name="warning" color={theme.colors.status.warning} />
          <Span tone="muted">{state.warning}</Span>
        </>
      ),
    });
  }
  if (state.notice) {
    notes.push({
      key: "notice",
      node: (
        <>
          <Icon name="info" tone="subtle" />
          <Span tone="muted">{state.notice}</Span>
        </>
      ),
    });
  }
  if (notes.length === 0) return null;
  return (
    <box flexDirection="column" flexShrink={0} paddingX={density.rowPaddingX} marginTop={1}>
      {notes.map((note) => (
        <text key={note.key} selectable={false} wrapMode="word">
          {note.node}
        </text>
      ))}
    </box>
  );
}

function ProblemState({ state }: { state: ScmState }) {
  const problem = state.problem;
  if (!problem) return null;
  if (problem.kind === "error") {
    return (
      <ErrorState
        title={problem.title}
        message={problem.detail}
        actions={[{ label: "Retry", command: "git.refresh" }]}
      />
    );
  }
  return (
    <EmptyState
      title={problem.title}
      description={problem.detail}
      actions={problem.kind === "bare-repository" ? [] : [{ label: "Refresh", command: "git.refresh" }]}
    />
  );
}

function SingleRepositoryView({
  visible,
  focused,
  controller,
  scanning,
}: ViewProps & { controller: ScmController; scanning: boolean }) {
  const app = useApp();
  const theme = useTheme();
  const density = useDensity();
  const renderer = useRenderer();
  const vm = controller.vm;
  const state = useStore(vm.store);
  const [area, setArea] = useState<Area>("list");
  const textarea = useRef<TextareaRenderable | null>(null);
  useFocusTarget(textarea, visible && area === "input");

  // Follow renderable focus: a click into the box (OpenTUI focuses it) or a jump from a command.
  useEffect(() => {
    const onFocus = (current: unknown) => {
      const inBox = current !== null && current === textarea.current;
      app.contextKeys.set("scmInputFocus", inBox);
      if (inBox) setArea("input");
    };
    renderer.on("focused_renderable", onFocus);
    return () => {
      renderer.off("focused_renderable", onFocus);
      app.contextKeys.set("scmInputFocus", false);
    };
  }, [renderer, app]);

  useEffect(
    () =>
      controller.onDidRequestCommitFocus(() => {
        setArea("input");
        textarea.current?.focus();
      }).dispose,
    [controller],
  );

  const open = (row: ScmRow, keep: boolean) => {
    if (row.kind !== "item") return;
    controller.openDiff(row.item, { preview: !keep, focus: keep });
  };

  const leaveInput = () => {
    setArea("list");
    textarea.current?.blur();
  };

  useKeyHandler(
    (stroke) => {
      const key = normalizeKey(stroke.key) ?? stroke.key;
      if (area === "input") {
        if (key === "escape") {
          leaveInput();
          return true;
        }
        return false;
      }
      if (stroke.ctrl || stroke.alt || stroke.super) return false;
      const row = vm.selectedRow();
      switch (key) {
        case "enter":
          if (row?.kind === "section") vm.toggleSection(row.section.group);
          else if (row) open(row, true);
          return row !== null;
        case "space":
          if (row?.kind === "section") vm.toggleSection(row.section.group);
          else if (row) open(row, false);
          return row !== null;
        case "left":
          vm.selectParentOrCollapse();
          return true;
        case "right":
          vm.expandOrSelectChild();
          return true;
        case "s":
          void controller.stageSelection();
          return true;
        case "u":
          void controller.unstageSelection();
          return true;
        case "d":
        case "delete":
          void controller.discardSelection();
          return true;
        case "o":
          controller.openFileForSelection();
          return true;
        case "c":
        case "i":
          setArea("input");
          textarea.current?.focus();
          return true;
        default:
          return false;
      }
    },
    { enabled: visible, whileInputFocused: true },
  );

  if (state.phase === "unavailable") {
    if (scanning && state.problem?.kind === "no-repository") return <Searching />;
    return <ProblemState state={state} />;
  }
  if (state.phase !== "ready") {
    return (
      <box paddingX={density.rowPaddingX} paddingTop={density.emptyStateTop} flexShrink={0}>
        <text selectable={false}>
          <Spinner label="Reading Git status" />
        </text>
      </box>
    );
  }

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <CommitBox
        controller={controller}
        state={state}
        area={area}
        zoneFocused={focused}
        textarea={textarea}
      />
      <OperationBanner state={state} />
      <Notices state={state} />
      {state.rows.length === 0 ? (
        <EmptyState
          title="No changes"
          description="Your working tree is clean."
          actions={[
            { label: "Commit history", command: "git.log" },
            { label: "Switch branch", command: "git.checkout" },
          ]}
        />
      ) : (
        <box flexDirection="column" flexGrow={1} minHeight={0} marginTop={density.sectionGap}>
          <List
            items={state.rows}
            selectedIndex={state.selectedIndex}
            focused={focused && area === "list"}
            keyboard={visible && area === "list"}
            onSelect={(index) => vm.selectIndex(index)}
            onActivate={(index) => {
              const row = state.rows[index];
              if (row?.kind === "section") vm.toggleSection(row.section.group);
              else if (row) open(row, true);
            }}
            surface={theme.colors.bg.surface}
            renderRow={(row, rowState) => (
              <ScmListRow row={row} state={rowState} controller={controller} onOpen={open} />
            )}
          />
        </box>
      )}
    </box>
  );
}

function Searching() {
  const density = useDensity();
  return (
    <box paddingX={density.rowPaddingX} paddingTop={density.emptyStateTop} flexShrink={0}>
      <text selectable={false}>
        <Spinner label="Looking for Git repositories" delayMs={0} />
      </text>
    </box>
  );
}

type MultiRow =
  | { readonly kind: "repo"; readonly key: string; readonly repo: RepositoryView }
  | { readonly kind: "scm"; readonly key: string; readonly repo: RepositoryView; readonly row: ScmRow };

function changeTotal(state: ScmState): number {
  return state.badgeCount;
}

/** A repository header: name, path when it adds information, branch, sync and change count. */
function RepositoryRow({
  repo,
  state,
  active,
  collapsed,
  onToggle,
  onActivate,
}: {
  repo: RepositoryView;
  state: ListRowState;
  active: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onActivate: () => void;
}) {
  const app = useApp();
  const theme = useTheme();
  const c = theme.colors;
  const pointer = usePointer({
    onClick: () => {
      onActivate();
      onToggle();
    },
    onContextMenu: (event: MouseEvent) => {
      onActivate();
      app.menus.show({
        x: event.x,
        y: event.y,
        items: [
          { id: "checkout", label: "Switch Branch…", icon: "branch", command: "git.checkout" },
          { id: "create", label: "Create Branch…", icon: "add", command: "git.createBranch" },
          { id: "sep", kind: "separator" },
          { id: "pull", label: "Pull", icon: "arrowDown", command: "git.pull" },
          { id: "push", label: "Push", icon: "arrowUp", command: "git.push" },
          { id: "fetch", label: "Fetch", icon: "sync", command: "git.fetch" },
          { id: "sep2", kind: "separator" },
          { id: "refresh", label: "Refresh", icon: "refresh", command: "git.refresh" },
        ],
      });
    },
  });
  const branch = repo.state.branch;
  const tier = theme.icons;
  const sync = [
    branch?.behind ? `${icon("arrowDown", tier)}${branch.behind}` : "",
    branch?.ahead ? `${icon("arrowUp", tier)}${branch.ahead}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const count = changeTotal(repo.state);
  const countText = count > 0 ? ` ${formatCount(count, 4)}` : "";
  const nameColor = state.active ? c.state.selectedFg : active ? c.accent.primary : c.fg.default;
  // The path only when it says more than the name (nested deeper than one level).
  const path = repo.path && repo.path !== repo.name ? repo.path : "";
  const branchText = `${branch ? `${icon("branch", tier)} ${branch.label}` : ""}${sync ? ` ${sync}` : ""}`;
  const room = Math.max(4, state.width - displayWidth(countText) - 4);
  const name = truncateEnd(sanitizeForDisplay(repo.name), Math.max(4, room - 2));
  let rest = room - displayWidth(name) - 1;
  const shownBranch = rest > 6 ? truncateEnd(branchText, rest) : "";
  rest -= displayWidth(shownBranch) + 2;
  const shownPath = path && rest > 6 ? truncateEnd(sanitizeForDisplay(path), rest) : "";
  return (
    <box flexGrow={1} flexDirection="row" height={1} {...pointer.props}>
      <text flexGrow={1} flexShrink={1} selectable={false} wrapMode="none" fg={c.fg.muted}>
        <Chevron expandable expanded={!collapsed} />
        <Span color={nameColor} bold>
          {name}
        </Span>
        {shownBranch ? <Span tone="subtle">{` ${shownBranch}`}</Span> : null}
        {shownPath ? <Span tone="subtle">{`  ${shownPath}`}</Span> : null}
      </text>
      {countText ? (
        <text flexShrink={0} selectable={false} fg={c.fg.subtle}>
          {countText}
        </text>
      ) : null}
    </box>
  );
}

function MultiRepositoryView({
  visible,
  focused,
  controller,
  multi,
}: ViewProps & { controller: ScmController; multi: MultiRepositoryState }) {
  const app = useApp();
  const theme = useTheme();
  const density = useDensity();
  const renderer = useRenderer();
  const vm = controller.vm;
  const state = useStore(vm.store);
  const [area, setArea] = useState<Area>("list");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [headerSelected, setHeaderSelected] = useState<string | null>(null);
  const textarea = useRef<TextareaRenderable | null>(null);
  useFocusTarget(textarea, visible && area === "input");

  useEffect(() => {
    const onFocus = (current: unknown) => {
      const inBox = current !== null && current === textarea.current;
      app.contextKeys.set("scmInputFocus", inBox);
      if (inBox) setArea("input");
    };
    renderer.on("focused_renderable", onFocus);
    return () => {
      renderer.off("focused_renderable", onFocus);
      app.contextKeys.set("scmInputFocus", false);
    };
  }, [renderer, app]);
  useEffect(
    () =>
      controller.onDidRequestCommitFocus(() => {
        setArea("input");
        textarea.current?.focus();
      }).dispose,
    [controller],
  );

  const rows = useMemo(() => {
    const out: MultiRow[] = [];
    for (const repo of multi.repositories) {
      out.push({ kind: "repo", key: `repo:${repo.entry.root}`, repo });
      if (collapsed.has(repo.entry.root)) continue;
      for (const row of repo.state.rows)
        out.push({ kind: "scm", key: `${repo.entry.root}\u0000${row.key}`, repo, row });
    }
    return out;
  }, [multi.repositories, collapsed]);

  // The selection is the active repository's own selection unless a repository row is selected.
  const activeRepo = multi.repositories.find((repo) => repo.entry.root === multi.activeRoot);
  const selectedKey =
    headerSelected !== null
      ? `repo:${headerSelected}`
      : activeRepo?.state.selectedKey
        ? `${activeRepo.entry.root}\u0000${activeRepo.state.selectedKey}`
        : null;
  const selectedIndex = selectedKey === null ? -1 : rows.findIndex((row) => row.key === selectedKey);

  const toggleRepo = (root: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });

  const select = (index: number) => {
    const row = rows[index];
    if (!row) return;
    controller.setActive(row.repo.entry.service);
    if (row.kind === "repo") {
      setHeaderSelected(row.repo.entry.root);
      row.repo.vm.select(null);
    } else {
      setHeaderSelected(null);
      row.repo.vm.select(row.row.key);
    }
  };

  const open = (row: ScmRow, keep: boolean) => {
    if (row.kind !== "item") return;
    controller.openDiff(row.item, { preview: !keep, focus: keep });
  };

  useKeyHandler(
    (stroke) => {
      const key = normalizeKey(stroke.key) ?? stroke.key;
      if (area === "input") {
        if (key === "escape") {
          setArea("list");
          textarea.current?.blur();
          return true;
        }
        return false;
      }
      if (stroke.ctrl || stroke.alt || stroke.super) return false;
      const current = rows[selectedIndex];
      if (current?.kind === "repo") {
        const root = current.repo.entry.root;
        if (key === "enter" || key === "space") toggleRepo(root);
        else if (key === "left" && !collapsed.has(root)) toggleRepo(root);
        else if (key === "right" && collapsed.has(root)) toggleRepo(root);
        else if (key === "c" || key === "i") {
          setArea("input");
          textarea.current?.focus();
        } else return false;
        return true;
      }
      const row = vm.selectedRow();
      switch (key) {
        case "enter":
          if (row?.kind === "section") vm.toggleSection(row.section.group);
          else if (row) open(row, true);
          return row !== null;
        case "space":
          if (row?.kind === "section") vm.toggleSection(row.section.group);
          else if (row) open(row, false);
          return row !== null;
        case "left":
          vm.selectParentOrCollapse();
          return true;
        case "right":
          vm.expandOrSelectChild();
          return true;
        case "s":
          void controller.stageSelection();
          return true;
        case "u":
          void controller.unstageSelection();
          return true;
        case "d":
        case "delete":
          void controller.discardSelection();
          return true;
        case "o":
          controller.openFileForSelection();
          return true;
        case "c":
        case "i":
          setArea("input");
          textarea.current?.focus();
          return true;
        default:
          return false;
      }
    },
    { enabled: visible, whileInputFocused: true },
  );

  const notes: string[] = [];
  if (multi.truncated) {
    notes.push(`Showing the first ${multi.maxRepositories} repositories found below this folder.`);
  }
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <CommitBox
        controller={controller}
        state={state}
        area={area}
        zoneFocused={focused}
        textarea={textarea}
        target={activeRepo?.name}
      />
      <OperationBanner state={state} />
      <Notices state={state} />
      {notes.length > 0 || multi.scanning ? (
        <box flexDirection="column" flexShrink={0} paddingX={density.rowPaddingX} marginTop={1}>
          {multi.scanning ? (
            <text selectable={false}>
              <Spinner label="Looking for more repositories" tone="muted" />
            </text>
          ) : null}
          {notes.map((note) => (
            <text key={note} selectable={false} wrapMode="word">
              <Icon name="info" tone="subtle" />
              <Span tone="muted">{note}</Span>
            </text>
          ))}
        </box>
      ) : null}
      <box flexDirection="column" flexGrow={1} minHeight={0} marginTop={density.sectionGap}>
        <List
          items={rows}
          selectedIndex={selectedIndex}
          focused={focused && area === "list"}
          keyboard={visible && area === "list"}
          onSelect={select}
          onActivate={(index) => {
            const row = rows[index];
            if (row?.kind === "repo") toggleRepo(row.repo.entry.root);
            else if (row?.row.kind === "section") row.repo.vm.toggleSection(row.row.section.group);
            else if (row) open(row.row, true);
          }}
          surface={theme.colors.bg.surface}
          renderRow={(row, rowState) =>
            row.kind === "repo" ? (
              <RepositoryRow
                repo={row.repo}
                state={rowState}
                active={row.repo.entry.root === multi.activeRoot}
                collapsed={collapsed.has(row.repo.entry.root)}
                onToggle={() => toggleRepo(row.repo.entry.root)}
                onActivate={() => {
                  controller.setActive(row.repo.entry.service);
                  setHeaderSelected(row.repo.entry.root);
                }}
              />
            ) : (
              // Groups sit one level under their repository row.
              <box flexGrow={1} flexDirection="row" height={1}>
                <text flexShrink={0} selectable={false}>
                  {"  "}
                </text>
                <ScmListRow
                  row={row.row}
                  state={{ ...rowState, width: Math.max(4, rowState.width - 2) }}
                  controller={controller}
                  vm={row.repo.vm}
                  activate={() => {
                    controller.setActive(row.repo.entry.service);
                    setHeaderSelected(null);
                  }}
                  onOpen={open}
                />
              </box>
            )
          }
        />
      </box>
    </box>
  );
}

/**
 * Source Control: one repository looks exactly as before; several repositories get a row each
 * with their groups underneath, and the commit box says which repository it commits to.
 */
export function ScmView(props: ViewProps & { controller: ScmController }) {
  const multi = useStore(props.controller.multi);
  if (multi.repositories.length > 1) return <MultiRepositoryView {...props} multi={multi} />;
  return <SingleRepositoryView {...props} scanning={multi.scanning} />;
}
