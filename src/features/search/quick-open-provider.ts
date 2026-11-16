/**
 * Quick Open (Ctrl+P, the command bar pill): the quick pick's no-prefix provider, backed by
 * `QuickOpenModel`.
 *
 * - Empty query: recently opened files first, then the rest of the index.
 * - Otherwise fuzzy matches with the file name as the label and the folder as a dimmed
 *   description, each with its own highlights.
 * - `name:42` and `name:42:7` open the chosen file at that position; a bare `:42` goes to
 *   that line in the active editor.
 * - The first query may have to build the file index: the status bar says so while it runs.
 *   Every query is cancelled by the next keystroke (the quick pick aborts its signal), so a
 *   large index never blocks typing.
 * - Enter opens the file as a regular (kept) tab.
 */
import type { MatchRange } from "@/adapters/search";
import { parseQuickOpenQuery } from "@/adapters/search";
import type { AppContext } from "@/app/app-context";
import type { QuickPickItem } from "@/app/workbench/quick-pick";
import type { Disposable } from "@/core/events";
import { type QuickOpenIndex, QuickOpenModel } from "./model";
import type { IndexingProgress } from "./search-commands";

/** Ids that can never be a workspace path (paths never contain NUL). */
const GO_TO_LINE_ID = "\0go-to-line";
const NOTICE_ID = "\0truncated";

export interface QuickOpenOptions {
  /** The file index (default: the shared `FileIndex` of the domain services). */
  readonly fileIndex?: () => QuickOpenIndex;
  /** Items listed at most (default 200). */
  readonly limit?: number;
}

function rangesToPositions(ranges: readonly MatchRange[]): number[] {
  const positions: number[] = [];
  for (const range of ranges) for (let i = range.start; i < range.end; i++) positions.push(i);
  return positions;
}

function lineLabel(line: number, column: number | undefined): string {
  return column === undefined ? `line ${line}` : `line ${line}, column ${column}`;
}

export function registerQuickOpen(
  ctx: AppContext,
  indexing: IndexingProgress,
  options: QuickOpenOptions = {},
): Disposable {
  let model: QuickOpenModel | null = null;
  let index: QuickOpenIndex | null = null;
  // Created on first use: activating the feature must not create the file index.
  const getIndex = (): QuickOpenIndex => {
    index ??= options.fileIndex?.() ?? ctx.services.fileIndex;
    return index;
  };
  const getModel = (): QuickOpenModel => {
    model ??= new QuickOpenModel({
      fileIndex: getIndex(),
      iconTier: ctx.themes.current.icons,
      limit: options.limit,
    });
    return model;
  };

  return ctx.quickPick.registerProvider({
    prefix: "",
    title: "Go to File",
    placeholder: "Search files by name (append :line to jump, > for commands)",
    emptyText: (input) => {
      const { query, line } = parseQuickOpenQuery(input);
      if (query === "" && line !== undefined) {
        return ctx.editors.active ? "Type a line number" : "Open a file first to go to a line";
      }
      return query ? "No matching files" : "No files in this workspace";
    },
    async provideItems(input, signal) {
      const quickOpen = getModel();
      quickOpen.setRecentFiles(ctx.persisted.state.recentFiles);
      quickOpen.setIconTier(ctx.themes.current.icons);
      const pending = quickOpen.query(input, signal);
      const result = await (getIndex().peek() === null ? indexing.run(pending) : pending);

      if (result.query === "" && result.line !== undefined) {
        const active = ctx.editors.active;
        if (!active?.resource) return [];
        return [
          {
            id: GO_TO_LINE_ID,
            label: `Go to ${lineLabel(result.line, result.column)}`,
            description: active.title,
            icon: "arrowRight",
          },
        ];
      }

      const position = result.line !== undefined ? lineLabel(result.line, result.column) : undefined;
      const anyRecent = result.items.some((item) => item.recent);
      const items: QuickPickItem[] = result.items.map((item, i) => {
        let group = position;
        if (result.query === "" && anyRecent) {
          const first = i === 0 || result.items[i - 1]?.recent !== item.recent;
          group = item.recent ? "recently opened" : first ? "files" : undefined;
        }
        return {
          id: item.path,
          label: item.label,
          description: item.description || undefined,
          fileIcon: item.label,
          highlights: rangesToPositions(item.labelHighlights),
          descriptionHighlights: rangesToPositions(item.descriptionHighlights),
          group,
        };
      });
      const notice = quickOpen.store.get().truncatedNotice;
      if (result.truncated && notice) {
        items.push({ id: NOTICE_ID, label: notice, icon: "info", disabled: true });
      }
      return items;
    },
    accept(item, input) {
      const { line, column } = parseQuickOpenQuery(input);
      if (item.id === GO_TO_LINE_ID) {
        const active = ctx.editors.active;
        if (active && line !== undefined) ctx.editors.reveal({ tabId: active.id, line, column });
        ctx.focus.focus("editor");
        return;
      }
      if (item.id === NOTICE_ID) return;
      const tab = ctx.editors.open({ kind: "file", resource: item.id });
      ctx.persisted.noteRecentFile(item.id);
      ctx.focus.focus("editor");
      if (line !== undefined) ctx.editors.reveal({ tabId: tab.id, line, column });
    },
  });
}
