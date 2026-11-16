/**
 * Icon glyphs in three tiers.
 *
 * - `nerd`: Nerd Fonts glyphs (Private Use Area, BMP only, so they stay one cell in Nerd
 *   Fonts "Mono" variants). Codicons for UI chrome so the workbench feels familiar to VS Code
 *   users; Seti/Devicons/Font Awesome for file types.
 * - `unicode`: plain BMP symbols that are narrow everywhere: East Asian Width "neutral",
 *   never "ambiguous" (those turn double-width in CJK terminal setups), and never emoji or
 *   emoji-capable (those can render as color emoji at two cells).
 * - `ascii`: printable ASCII only, for the Linux console, non-UTF-8 locales and screen readers.
 *
 * File icons carry a token path for their color, never a hex value.
 */
import type { IconTier } from "./ids";
import type { TokenPath } from "./tokens";

export type IconName =
  | "file"
  | "folder"
  | "folderOpen"
  | "explorer"
  | "search"
  | "sourceControl"
  | "ai"
  | "extensions"
  | "settings"
  | "terminal"
  | "chevronRight"
  | "chevronDown"
  | "chevronLeft"
  | "chevronUp"
  | "close"
  | "modified"
  | "error"
  | "warning"
  | "info"
  | "branch"
  | "check"
  | "arrowUp"
  | "arrowDown"
  | "arrowLeft"
  | "arrowRight"
  | "layoutSidebarLeft"
  | "layoutSidebarRight"
  | "layoutPanel"
  | "more"
  | "add"
  | "refresh"
  | "collapseAll"
  | "maximize"
  | "restore"
  | "sync"
  | "remove"
  | "discard"
  | "goToFile";

/**
 * Private-use glyphs are built from code points: formatters rewrite "\uXXXX" escapes into
 * invisible literal characters, which makes wrong glyphs impossible to review. Every code
 * point below was checked against the glyph names in JetBrainsMono Nerd Font (v3) and looked
 * at in a rendered screenshot.
 */
const nf = (codePoint: number): string => String.fromCodePoint(codePoint);

/** Nerd Font names in comments so code points can be checked against the cheat sheet. */
const NERD: Record<IconName, string> = {
  file: nf(0xea7b), // nf-cod-file
  folder: nf(0xea83), // nf-cod-folder
  folderOpen: nf(0xeaf7), // nf-cod-folder_opened
  explorer: nf(0xeaf0), // nf-cod-files
  search: nf(0xea6d), // nf-cod-search
  sourceControl: nf(0xea68), // nf-cod-source_control
  ai: nf(0xec10), // nf-cod-sparkle
  extensions: nf(0xeae6), // nf-cod-extensions
  settings: nf(0xeaf8), // nf-cod-gear (settings_gear)
  terminal: nf(0xea85), // nf-cod-terminal
  chevronRight: nf(0xeab6), // nf-cod-chevron_right
  chevronDown: nf(0xeab4), // nf-cod-chevron_down
  chevronLeft: nf(0xeab5), // nf-cod-chevron_left
  chevronUp: nf(0xeab7), // nf-cod-chevron_up
  close: nf(0xea76), // nf-cod-close
  modified: nf(0xea71), // nf-cod-circle_filled
  error: nf(0xea87), // nf-cod-error
  warning: nf(0xea6c), // nf-cod-warning
  info: nf(0xea74), // nf-cod-info
  branch: nf(0xf418), // nf-oct-git_branch
  check: nf(0xeab2), // nf-cod-check
  arrowUp: nf(0xeaa1), // nf-cod-arrow_up
  arrowDown: nf(0xea9a), // nf-cod-arrow_down
  arrowLeft: nf(0xea9b), // nf-cod-arrow_left
  arrowRight: nf(0xea9c), // nf-cod-arrow_right
  layoutSidebarLeft: nf(0xebf3), // nf-cod-layout_sidebar_left
  layoutSidebarRight: nf(0xebf4), // nf-cod-layout_sidebar_right
  layoutPanel: nf(0xebf2), // nf-cod-layout_panel
  more: nf(0xea7c), // nf-cod-ellipsis
  add: nf(0xea60), // nf-cod-add
  refresh: nf(0xeb37), // nf-cod-refresh
  collapseAll: nf(0xeac5), // nf-cod-collapse_all
  maximize: nf(0xeb4c), // nf-cod-screen_full
  restore: nf(0xeb4d), // nf-cod-screen_normal
  sync: nf(0xea77), // nf-cod-sync
  remove: nf(0xeb3b), // nf-cod-remove
  discard: nf(0xeae2), // nf-cod-discard
  goToFile: nf(0xea94), // nf-cod-go_to_file
};

const UNICODE: Record<IconName, string> = {
  file: "◦",
  folder: "◫",
  folderOpen: "◫",
  explorer: "⧉",
  search: "⌕",
  sourceControl: "⑂",
  ai: "✦",
  extensions: "⊞",
  settings: "❖",
  terminal: "›",
  chevronRight: "▸",
  chevronDown: "▾",
  chevronLeft: "◂",
  chevronUp: "▴",
  close: "✕",
  modified: "◉",
  error: "✗",
  warning: "!",
  info: "i",
  branch: "⎇",
  check: "✓",
  arrowUp: "⇡",
  arrowDown: "⇣",
  arrowLeft: "⇠",
  arrowRight: "⇢",
  layoutSidebarLeft: "◧",
  layoutSidebarRight: "◨",
  layoutPanel: "⬓",
  more: "⋯",
  add: "+",
  refresh: "↻",
  collapseAll: "⊟",
  maximize: "⤢",
  restore: "⤡",
  sync: "⇅",
  remove: "-",
  discard: "↶",
  goToFile: "⇗",
};

const ASCII: Record<IconName, string> = {
  file: "-",
  folder: "+",
  folderOpen: "-",
  explorer: "F",
  search: "/",
  sourceControl: "G",
  ai: "A",
  extensions: "#",
  settings: "=",
  terminal: "$",
  chevronRight: ">",
  chevronDown: "v",
  chevronLeft: "<",
  chevronUp: "^",
  close: "x",
  modified: "*",
  error: "x",
  warning: "!",
  info: "i",
  branch: "Y",
  check: "v",
  arrowUp: "^",
  arrowDown: "v",
  arrowLeft: "<",
  arrowRight: ">",
  layoutSidebarLeft: "[",
  layoutSidebarRight: "]",
  layoutPanel: "_",
  more: ":",
  add: "+",
  refresh: "r",
  collapseAll: "-",
  maximize: "^",
  restore: "v",
  sync: "~",
  remove: "-",
  discard: "<",
  goToFile: ">",
};

export const UI_ICONS: Readonly<Record<IconTier, Readonly<Record<IconName, string>>>> = {
  nerd: NERD,
  unicode: UNICODE,
  ascii: ASCII,
};

export function icon(name: IconName, tier: IconTier): string {
  return UI_ICONS[tier][name];
}

type FileType =
  | "typescript"
  | "javascript"
  | "json"
  | "markdown"
  | "python"
  | "go"
  | "shell"
  | "yaml"
  | "toml"
  | "html"
  | "css"
  | "image"
  | "lock"
  | "git";

const FILE_TYPES: Record<FileType, { nerd: string; color: TokenPath }> = {
  typescript: { nerd: nf(0xe628), color: "terminal.blue" }, // nf-seti-typescript
  javascript: { nerd: nf(0xe74e), color: "terminal.yellow" }, // nf-dev-javascript_alt
  json: { nerd: nf(0xeb0f), color: "terminal.yellow" }, // nf-cod-json (e60b, used before, is nf-seti-less)
  markdown: { nerd: nf(0xf48a), color: "terminal.cyan" }, // nf-oct-markdown
  python: { nerd: nf(0xe606), color: "terminal.yellow" }, // nf-seti-python
  go: { nerd: nf(0xe627), color: "terminal.cyan" }, // nf-seti-go
  shell: { nerd: nf(0xe795), color: "terminal.green" }, // nf-dev-terminal
  yaml: { nerd: nf(0xe615), color: "terminal.magenta" }, // nf-seti-config
  toml: { nerd: nf(0xe615), color: "terminal.magenta" }, // nf-seti-config
  html: { nerd: nf(0xe736), color: "terminal.red" }, // nf-dev-html5
  css: { nerd: nf(0xe749), color: "terminal.blue" }, // nf-dev-css3
  image: { nerd: nf(0xf1c5), color: "terminal.magenta" }, // nf-fa-file_image_o (file_picture_o)
  lock: { nerd: nf(0xf023), color: "fg.subtle" }, // nf-fa-lock
  git: { nerd: nf(0xe702), color: "terminal.red" }, // nf-dev-git
};

const BY_EXTENSION: Readonly<Record<string, FileType>> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  json5: "json",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  py: "python",
  pyi: "python",
  go: "go",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  sass: "css",
  less: "css",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  bmp: "image",
  ico: "image",
  svg: "image",
  tiff: "image",
  lock: "lock",
  lockb: "lock",
};

const BY_NAME: Readonly<Record<string, FileType>> = {
  ".gitignore": "git",
  ".gitattributes": "git",
  ".gitmodules": "git",
  ".gitkeep": "git",
  ".mailmap": "git",
  "package-lock.json": "lock",
  "pnpm-lock.yaml": "lock",
  "yarn.lock": "lock",
  "bun.lock": "lock",
  "bun.lockb": "lock",
  "cargo.lock": "lock",
  "gemfile.lock": "lock",
  "poetry.lock": "lock",
  "composer.lock": "lock",
  "go.sum": "lock",
  "go.mod": "go",
  ".bashrc": "shell",
  ".bash_profile": "shell",
  ".zshrc": "shell",
  ".zprofile": "shell",
  ".profile": "shell",
};

export type FileIconKind = "file" | "directory" | "directory-open";

export interface FileIcon {
  glyph: string;
  /** Semantic token for the glyph's color. */
  color: TokenPath;
}

function fileTypeOf(name: string): FileType | undefined {
  const lower = name.toLowerCase();
  const byName = BY_NAME[lower];
  if (byName) return byName;
  const dot = lower.lastIndexOf(".");
  if (dot <= 0 || dot === lower.length - 1) return undefined;
  return BY_EXTENSION[lower.slice(dot + 1)];
}

/** Icon and color token for an explorer entry, by well-known name or extension. */
export function iconForFile(name: string, kind: FileIconKind, tier: IconTier): FileIcon {
  if (kind !== "file") {
    return { glyph: icon(kind === "directory-open" ? "folderOpen" : "folder", tier), color: "fg.muted" };
  }
  const type = fileTypeOf(name);
  if (!type) return { glyph: icon("file", tier), color: "fg.muted" };
  const spec = FILE_TYPES[type];
  return { glyph: tier === "nerd" ? spec.nerd : icon("file", tier), color: spec.color };
}

export type IconSetting = "auto" | IconTier;

type Env = Record<string, string | undefined>;

/**
 * Resolves `ui.icons`. Nerd Fonts cannot be detected from inside a terminal, so `auto` never
 * picks `nerd`; onboarding offers it instead. `auto` picks `ascii` on the Linux console and
 * when the locale is explicitly not UTF-8, and `unicode` otherwise.
 */
export function resolveIconTier(setting: IconSetting, env: Env = process.env): IconTier {
  if (setting !== "auto") return setting;
  if (env.TERM === "linux") return "ascii";
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
  if (locale && !/utf-?8/i.test(locale)) return "ascii";
  return "unicode";
}
