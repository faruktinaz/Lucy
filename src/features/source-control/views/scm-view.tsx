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
import { useEffect, useRef, useState } from "react";
import type { GitOperationName } from "@/adapters/git";
import { useApp, useFocusTarget, useKeyHandler, useStore } from "@/app/react";
import type { MenuItem } from "@/app/workbench/menus";
import type { ViewProps } from "@/app/workbench/views";
import { normalizeKey } from "@/core/keybindings";
import { displayWidth } from "@/core/text";
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
import type { ScmController } from "../controller";
import type { ScmGroup, ScmItem, ScmRow, ScmSection, ScmState } from "../model";

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

/** Contents of one list row. A component (not a render function) so it can use hooks. */
function ScmListRow({
  row,
  state,
  controller,
  onOpen,
}: {
  row: ScmRow;
  state: ListRowState;
  controller: ScmController;
  onOpen: (row: ScmRow, keep: boolean) => void;
}) {
  const app = useApp();
  const theme = useTheme();
  const c = theme.colors;
  const vm = controller.vm;
  const pointer = usePointer({
    onClick: () => {
      vm.select(row.key);
      if (row.kind === "section") vm.toggleSection(row.section.group);
      else onOpen(row, false);
    },
    onDoubleClick: () => {
      if (row.kind === "item") onOpen(row, true);
    },
    onContextMenu: (event: MouseEvent) => {
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
    const actions = showActions ? sectionActions(controller, section.group) : [];
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
  const actions = showActions ? itemActions(controller, item, app) : [];
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
}: {
  controller: ScmController;
  state: ScmState;
  area: Area;
  zoneFocused: boolean;
  textarea: React.RefObject<TextareaRenderable | null>;
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

export function ScmView({ visible, focused, controller }: ViewProps & { controller: ScmController }) {
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

  if (state.phase === "unavailable") return <ProblemState state={state} />;
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
