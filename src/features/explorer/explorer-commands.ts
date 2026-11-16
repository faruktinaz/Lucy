/**
 * The explorer's commands: everything the header, menus and keybindings do is a command, so
 * it is also reachable from the palette.
 */
import type { AppContext } from "@/app/app-context";
import type { CommandDefinition } from "@/core/commands";
import { type Disposable, DisposableStore } from "@/core/events";
import type { ExplorerController } from "./explorer-controller";

const CATEGORY = "Explorer";

export function registerExplorerCommands(ctx: AppContext, controller: ExplorerController): Disposable {
  const store = new DisposableStore();
  const register = (definition: Omit<CommandDefinition, "category">) =>
    store.add(ctx.commands.register({ category: CATEGORY, ...definition }));
  const hasSelection = () => controller.selectedPath() !== null;

  register({
    id: "explorer.newFile",
    title: "New File…",
    keywords: ["create", "add", "touch"],
    run: () => controller.newEntry("file"),
  });
  register({
    id: "explorer.newFolder",
    title: "New Folder…",
    keywords: ["create", "add", "mkdir", "directory"],
    run: () => controller.newEntry("folder"),
  });
  register({
    id: "explorer.rename",
    title: "Rename…",
    keywords: ["move"],
    enabled: hasSelection,
    run: () => controller.rename(),
  });
  register({
    id: "explorer.delete",
    title: "Delete",
    keywords: ["remove", "trash"],
    enabled: hasSelection,
    run: () => controller.deleteSelection(),
  });
  register({
    id: "explorer.refresh",
    title: "Refresh Explorer",
    keywords: ["reload"],
    run: () => controller.refresh(),
  });
  register({
    id: "explorer.collapseAll",
    title: "Collapse Folders in Explorer",
    run: () => controller.collapseAll(),
  });
  register({
    id: "explorer.toggleHidden",
    title: "Toggle Hidden Files",
    keywords: ["dotfiles", "show", "hide"],
    run: () => controller.toggleSetting("explorer.showHidden"),
  });
  register({
    id: "explorer.toggleIgnored",
    title: "Toggle Ignored Files",
    keywords: ["gitignore", "show", "hide"],
    run: () => controller.toggleSetting("explorer.showIgnored"),
  });
  register({
    id: "explorer.revealActiveFile",
    title: "Reveal Active File in Explorer",
    keywords: ["locate", "find", "select"],
    enabled: () => controller.activeFilePath() !== null,
    run: () => controller.revealActiveFile(),
  });
  register({
    id: "explorer.copyPath",
    title: "Copy Path",
    keywords: ["clipboard", "absolute"],
    run: () => controller.copyPath(false),
  });
  register({
    id: "explorer.copyRelativePath",
    title: "Copy Relative Path",
    keywords: ["clipboard"],
    run: () => controller.copyPath(true),
  });
  register({
    id: "explorer.undo",
    title: "Undo File Operation",
    keywords: ["restore", "trash"],
    enabled: () => controller.model.store.get().undoDescription !== null,
    run: () => controller.undo(),
  });
  register({
    id: "explorer.filter",
    title: "Filter Files…",
    keywords: ["find", "search", "narrow"],
    run: () => controller.openFilter(),
  });
  register({
    id: "explorer.showContextMenu",
    title: "Show Explorer Context Menu",
    when: "sidebarView == 'explorer'",
    run: () => controller.showContextMenu(),
  });
  register({
    id: "explorer.moreActions",
    title: "More Explorer Actions…",
    run: () => controller.showMoreMenu(),
  });
  return store;
}
