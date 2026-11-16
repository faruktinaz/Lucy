/**
 * Terminal editors Lucy knows how to open at a line and column.
 *
 * Order matters: it is the "auto" preference after `$VISUAL` and `$EDITOR`. Friendly modeless
 * editors first (micro, then Helix), then the Vim family, then nano, and plain `vi` last
 * because on many Linux systems it is a minimal vi without Vim's features.
 */
import { basename } from "node:path";

export type KnownEditorId = "micro" | "hx" | "nvim" | "vim" | "nano" | "vi";

/** How an editor takes the cursor position; see `build-open-command.ts`. */
export type CursorSyntax = "micro" | "helix" | "vim" | "vi" | "nano";

export interface KnownEditor {
  readonly id: KnownEditorId;
  readonly displayName: string;
  /** Executable names, in lookup order. */
  readonly programs: readonly string[];
  readonly cursorSyntax: CursorSyntax;
}

export const KNOWN_EDITORS: readonly KnownEditor[] = Object.freeze([
  { id: "micro", displayName: "micro", programs: ["micro"], cursorSyntax: "micro" },
  // Arch and some other distributions install Helix as `helix`.
  { id: "hx", displayName: "Helix", programs: ["hx", "helix"], cursorSyntax: "helix" },
  { id: "nvim", displayName: "Neovim", programs: ["nvim"], cursorSyntax: "vim" },
  { id: "vim", displayName: "Vim", programs: ["vim"], cursorSyntax: "vim" },
  // macOS ships `nano` as a link to `pico`, which accepts the same `+LINE` form.
  { id: "nano", displayName: "nano", programs: ["nano", "pico"], cursorSyntax: "nano" },
  { id: "vi", displayName: "vi", programs: ["vi"], cursorSyntax: "vi" },
]);

export function knownEditorById(id: string): KnownEditor | undefined {
  return KNOWN_EDITORS.find((editor) => editor.id === id);
}

/** The known editor a program path or name refers to, by its base name (`/usr/bin/nvim` → Neovim). */
export function knownEditorForProgram(program: string): KnownEditor | undefined {
  const name = basename(program);
  return KNOWN_EDITORS.find((editor) => editor.programs.includes(name));
}
