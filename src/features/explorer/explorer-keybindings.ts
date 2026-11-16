/**
 * Default keybindings of the explorer. Every command keeps a legacy-safe chord (the
 * `ctrl+k <key>` family, F-keys, plain keys); keys that only make sense inside the tree are
 * scoped to the explorer having focus, so they never fire while the user types elsewhere.
 */
import type { KeybindingDefinition } from "@/core/keybindings";

/** The explorer is the visible sidebar view. */
export const EXPLORER_VISIBLE = "sidebarView == 'explorer'";
/** The explorer has keyboard focus and no text input is focused. */
export const EXPLORER_FOCUS = "sidebarView == 'explorer' && sidebarFocus && !inputFocus";

export const EXPLORER_KEYBINDINGS: readonly KeybindingDefinition[] = [
  { command: "explorer.newFile", keys: ["ctrl+k shift+f"], when: EXPLORER_VISIBLE },
  { command: "explorer.newFolder", keys: ["ctrl+k shift+d"], when: EXPLORER_VISIBLE },
  { command: "explorer.rename", keys: ["f2"], when: EXPLORER_FOCUS },
  { command: "explorer.delete", keys: ["delete"], when: EXPLORER_FOCUS },
  { command: "explorer.refresh", keys: ["ctrl+k ctrl+r"], when: EXPLORER_VISIBLE },
  { command: "explorer.collapseAll", keys: ["ctrl+k ctrl+left"], when: EXPLORER_VISIBLE },
  { command: "explorer.toggleHidden", keys: ["ctrl+k ."] },
  { command: "explorer.toggleIgnored", keys: ["ctrl+k shift+i"] },
  { command: "explorer.revealActiveFile", keys: ["ctrl+k shift+e"] },
  { command: "explorer.copyPath", keys: ["ctrl+k p"] },
  { command: "explorer.copyRelativePath", keys: ["ctrl+k shift+p"] },
  { command: "explorer.undo", keys: ["ctrl+k u"], when: EXPLORER_VISIBLE },
  { command: "explorer.filter", keys: ["ctrl+f", "/"], when: EXPLORER_FOCUS },
  { command: "explorer.showContextMenu", keys: ["shift+f10"], when: EXPLORER_FOCUS },
];
