/**
 * The workbench's quick-pick providers: `>` commands, `:` go to line in the active editor,
 * and `?` to list the prefixes. The no-prefix files provider (Quick Open, with `file.ts:42`
 * jumps) is registered by the Search feature (`src/features/search/quick-open-provider.ts`).
 */
import { parseQuickOpenQuery } from "@/adapters/search";
import { type Disposable, DisposableStore } from "@/core/events";
import type { AppContext } from "../app-context";
import { filterQuickPickItems, type QuickPickItem } from "../workbench/quick-pick";

export function registerQuickPickProviders(ctx: AppContext): Disposable {
  const store = new DisposableStore();
  const { quickPick, commands, contextKeys, editors } = ctx;

  store.add(
    quickPick.registerProvider({
      prefix: ">",
      title: "Commands",
      placeholder: "Type the name of a command to run",
      emptyText: () => "No matching commands",
      provideItems(query) {
        const entries = commands.list({ context: contextKeys });
        const recent = commands.getRecent().filter((id) => entries.some((e) => e.id === id));
        const toItem = (id: string, group?: string): QuickPickItem | undefined => {
          const entry = entries.find((e) => e.id === id);
          if (!entry) return undefined;
          return {
            id: entry.id,
            label: `${entry.category}: ${entry.title}`,
            keybinding: ctx.keybindingFor(entry.id),
            disabled: !entry.enabled,
            group,
          };
        };
        const ordered = [
          ...recent.map((id, index) => toItem(id, index === 0 ? "recently used" : undefined)),
          ...entries
            .filter((e) => !recent.includes(e.id))
            .sort((a, b) => `${a.category}: ${a.title}`.localeCompare(`${b.category}: ${b.title}`))
            .map((e, index) => toItem(e.id, index === 0 && recent.length > 0 ? "other commands" : undefined)),
        ].filter((item): item is QuickPickItem => item !== undefined);
        return query ? filterQuickPickItems(ordered, query) : ordered;
      },
      accept: async (item) => {
        await ctx.run(item.id);
      },
    }),
  );

  store.add(
    quickPick.registerProvider({
      prefix: ":",
      title: "Go to Line",
      placeholder: "Type a line number, optionally :column",
      emptyText: () => (editors.active ? "Type a line number" : "Open a file first to go to a line"),
      provideItems(query) {
        const active = editors.active;
        if (!active) return [];
        const { line, column } = parseQuickOpenQuery(`:${query}`);
        if (line === undefined) return [];
        return [
          {
            id: `${line}:${column ?? 1}`,
            label: column ? `Go to line ${line}, column ${column}` : `Go to line ${line}`,
            description: active.title,
            icon: "arrowRight",
          },
        ];
      },
      accept(item) {
        const active = editors.active;
        if (!active) return;
        const [line, column] = item.id.split(":").map((n) => Number.parseInt(n, 10));
        if (!line) return;
        editors.reveal({ tabId: active.id, line, column });
        ctx.focus.focus("editor");
      },
    }),
  );

  store.add(
    quickPick.registerProvider({
      prefix: "?",
      title: "Help",
      placeholder: "What the picker can do",
      provideItems(query) {
        const help: QuickPickItem[] = quickPick
          .listProviders()
          .filter((provider) => provider.prefix !== "?")
          .sort((a, b) => a.prefix.localeCompare(b.prefix))
          .map((provider) => ({
            id: provider.prefix,
            label: provider.prefix === "" ? "(no prefix)" : provider.prefix,
            description: provider.title,
          }));
        return filterQuickPickItems(help, query, { matchOnDescription: true });
      },
      accept(item) {
        quickPick.show(item.id);
      },
    }),
  );

  return store;
}
