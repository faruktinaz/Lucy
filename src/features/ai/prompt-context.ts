/**
 * Context for prompt templates, read from the workbench: the active editor tab (file, and a
 * selection when its view publishes one) and the Git status (for "Review diff").
 *
 * Lucy has no diagnostics source yet, so "Fix diagnostics" is listed but disabled with that
 * reason rather than hidden or faked.
 */
import {
  formatFileMention,
  type PromptContext,
  type PromptSelection,
  type PromptTemplateId,
} from "@/adapters/agents";
import type { GitState } from "@/adapters/git";
import type { EditorTab } from "@/app/workbench/editors";
import type { QuickPickItem } from "@/app/workbench/quick-pick";

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/**
 * A selection published by an editor view in its view state as
 * `selection: { startLine, endLine, text? }` (1-based, inclusive). Anything else is ignored.
 */
export function readSelection(viewState: Readonly<Record<string, unknown>>): PromptSelection | undefined {
  const raw = viewState.selection;
  if (typeof raw !== "object" || raw === null) return undefined;
  const candidate = raw as Record<string, unknown>;
  if (!isPositiveInteger(candidate.startLine) || !isPositiveInteger(candidate.endLine)) return undefined;
  if (candidate.endLine < candidate.startLine) return undefined;
  return {
    startLine: candidate.startLine,
    endLine: candidate.endLine,
    text: typeof candidate.text === "string" ? candidate.text : undefined,
  };
}

/** The template context for the active tab (file and diff tabs; others give none). */
export function promptContextFrom(tab: EditorTab | undefined): PromptContext {
  if (!tab?.resource || (tab.kind !== "file" && tab.kind !== "diff")) return {};
  const context: PromptContext = { filePath: tab.resource };
  const selection = readSelection(tab.viewState);
  if (selection) context.selection = selection;
  if (tab.kind === "diff" && tab.params.staged === true) context.staged = true;
  return context;
}

/** The template picker's items, each enabled only when it has what it needs. */
export function templateItems(context: PromptContext, git: GitState | null): QuickPickItem[] {
  const file = context.filePath;
  const mention = file ? formatFileMention(file, context.selection) : undefined;
  const changes = git?.status?.changes.length;
  const noFile = "Open a file first";
  const items: { id: PromptTemplateId; label: string; description: string; disabled: boolean }[] = [
    {
      id: "explain",
      label: context.selection ? "Explain Selection" : "Explain File",
      description: mention ?? noFile,
      disabled: !file,
    },
    {
      id: "review-diff",
      label: "Review Diff",
      description:
        changes === 0
          ? "No uncommitted changes"
          : context.staged
            ? "Staged changes"
            : changes === undefined
              ? "Uncommitted changes"
              : `Uncommitted changes in ${changes} ${changes === 1 ? "file" : "files"}`,
      disabled: changes === 0,
    },
    { id: "write-tests", label: "Write Tests", description: mention ?? noFile, disabled: !file },
    {
      id: "fix-diagnostics",
      label: "Fix Diagnostics",
      description: "Lucy has no diagnostics to send yet",
      disabled: true,
    },
  ];
  return items.map((item) => ({ ...item, icon: "ai" }));
}
