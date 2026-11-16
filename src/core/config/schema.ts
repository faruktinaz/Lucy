/**
 * The settings schema: one descriptor per setting, and the single source of truth for
 * validation, defaults, the `Config` type, the TOML key names and the Settings UI.
 *
 * Paths are `section.key` in camelCase (`layout.sidebarWidth`); the TOML spelling is derived
 * (`[layout] sidebar_width`). Only settings that this milestone's features honor belong
 * here: an option that does nothing is worse than a missing one.
 */
import { z } from "zod";
import { ACCENT_NAMES, THEME_IDS } from "../../themes/ids";

export const CONFIG_VERSION = 1;

export type SettingCategory =
  | "Appearance"
  | "Layout"
  | "Editor"
  | "Explorer"
  | "Search"
  | "Source Control"
  | "AI"
  | "Terminal"
  | "Workspace"
  | "Keyboard";

/**
 * How the Settings UI should present a setting.
 * - `enum`: pick one of `options`.
 * - `enum-or-color`: pick one of `options` or type a `#rrggbb` color.
 * - `enum-or-command`: pick one of `options` or enter a command as an argv list.
 * - `keybinding-map`: command id to chord(s), edited in the keybindings screen.
 */
export type SettingType =
  | "boolean"
  | "integer"
  | "string"
  | "string-list"
  | "enum"
  | "enum-or-color"
  | "enum-or-command"
  | "keybinding-map";

export interface SettingOption {
  readonly value: string;
  readonly label: string;
}

export interface SettingDescriptor<P extends string = string, V = unknown> {
  /** camelCase path used in code: `section.key`. */
  readonly path: P;
  readonly section: string;
  /** camelCase key within the section. */
  readonly key: string;
  /** snake_case key as written in config.toml. */
  readonly tomlKey: string;
  /** Dotted TOML path for messages: `layout.sidebar_width`. */
  readonly tomlPath: string;
  readonly title: string;
  readonly description: string;
  readonly category: SettingCategory;
  readonly type: SettingType;
  readonly default: V;
  readonly options?: readonly SettingOption[];
  readonly min?: number;
  readonly max?: number;
  readonly unit?: string;
  /** Human-readable description of a valid value, used in validation messages. */
  readonly expected: string;
  readonly schema: z.ZodType<V>;
  /** The change takes effect only after Lucy restarts (the Settings UI says so). */
  readonly requiresRestart?: boolean;
  /** The UI applies the value while the user browses options, before committing. */
  readonly livePreview?: boolean;
}

type BehaviorFlags = Pick<SettingDescriptor, "requiresRestart" | "livePreview">;

/**
 * Behavior that is not part of validation, kept in one table instead of threading options
 * through every helper. Restart: the renderer negotiates colors at startup, and watchers and
 * Git integration are wired once per workspace.
 */
const BEHAVIOR_FLAGS: Readonly<Record<string, BehaviorFlags>> = {
  "ui.theme": { livePreview: true },
  "ui.accent": { livePreview: true },
  "ui.density": { livePreview: true },
  "ui.icons": { livePreview: true },
  "ui.colorMode": { requiresRestart: true },
  "git.enabled": { requiresRestart: true },
  "workspace.watch": { requiresRestart: true },
};

function withBehaviorFlags<const T extends readonly SettingDescriptor<string, unknown>[]>(list: T): T {
  return list.map((descriptor) => ({ ...descriptor, ...BEHAVIOR_FLAGS[descriptor.path] })) as unknown as T;
}

interface Meta {
  title: string;
  description: string;
  category: SettingCategory;
}

type SettingPathShape = `${string}.${string}`;

export function toSnakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function describe<const P extends SettingPathShape, V>(
  path: P,
  type: SettingType,
  defaultValue: V,
  schema: z.ZodType<V>,
  expected: string,
  meta: Meta,
  extra: Partial<Pick<SettingDescriptor, "options" | "min" | "max" | "unit">> = {},
): SettingDescriptor<P, V> {
  const dot = path.indexOf(".");
  const section = path.slice(0, dot);
  const key = path.slice(dot + 1);
  const tomlKey = toSnakeCase(key);
  return {
    path,
    section,
    key,
    tomlKey,
    tomlPath: `${section}.${tomlKey}`,
    ...meta,
    type,
    default: defaultValue,
    expected,
    schema,
    ...extra,
  };
}

/** Strings handed to processes or paths must not smuggle NUL bytes in via TOML escapes. */
const safeText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !s.includes("\0"), "must not contain NUL characters");

function bool<const P extends SettingPathShape>(path: P, defaultValue: boolean, meta: Meta) {
  return describe(path, "boolean", defaultValue, z.boolean(), "true or false", meta);
}

function int<const P extends SettingPathShape>(
  path: P,
  defaultValue: number,
  range: { min: number; max: number; unit?: string },
  meta: Meta,
) {
  const unit = range.unit ? ` ${range.unit}` : "";
  return describe(
    path,
    "integer",
    defaultValue,
    z.number().int().min(range.min).max(range.max),
    `a whole number from ${range.min} to ${range.max}${unit}`,
    meta,
    range,
  );
}

function text<const P extends SettingPathShape>(
  path: P,
  defaultValue: string,
  maxLength: number,
  meta: Meta,
) {
  return describe(path, "string", defaultValue, safeText(maxLength), "text", meta);
}

function list<const P extends SettingPathShape>(
  path: P,
  defaultValue: string[],
  item: { maxItems: number; maxLength: number; allowEmpty: boolean },
  meta: Meta,
) {
  const element = item.allowEmpty ? safeText(item.maxLength) : safeText(item.maxLength).min(1);
  return describe(
    path,
    "string-list",
    defaultValue,
    z.array(element).max(item.maxItems),
    `a list of up to ${item.maxItems} strings`,
    meta,
  );
}

function quoteList(values: readonly string[]): string {
  return values.map((v) => `"${v}"`).join(", ");
}

function choice<const P extends SettingPathShape, const O extends readonly (readonly [string, string])[]>(
  path: P,
  options: O,
  defaultValue: O[number][0],
  meta: Meta,
) {
  const values = options.map(([value]) => value) as [O[number][0], ...O[number][0][]];
  return describe(
    path,
    "enum",
    defaultValue,
    z.enum(values) as unknown as z.ZodType<O[number][0]>,
    `one of ${quoteList(values)}`,
    meta,
    { options: options.map(([value, label]) => ({ value, label })) },
  );
}

const THEME_LABELS: Record<(typeof THEME_IDS)[number], string> = {
  "catppuccin-mocha": "Catppuccin Mocha",
  "tokyo-night": "Tokyo Night",
  "gruvbox-dark": "Gruvbox Dark",
  "high-contrast": "High Contrast",
};

const ACCENT_VALUES = ["default", ...ACCENT_NAMES] as const;

export const EXTERNAL_EDITORS = ["auto", "micro", "hx", "nvim", "vim", "nano", "vi"] as const;
export type ExternalEditorSetting = (typeof EXTERNAL_EDITORS)[number] | string[];

/** A user binding: one chord string, several, or `false` to remove the command's bindings. */
export type KeybindingOverride = string | string[] | false;
export type KeybindingOverrides = Record<string, KeybindingOverride>;

const chordText = safeText(100).min(1);
export const keybindingOverrideSchema: z.ZodType<KeybindingOverride> = z.union([
  chordText,
  z.array(chordText).min(1).max(8),
  z.literal(false),
]);

const appearance = { category: "Appearance" } as const;
const layout = { category: "Layout" } as const;
const editor = { category: "Editor" } as const;
const explorer = { category: "Explorer" } as const;
const search = { category: "Search" } as const;
const git = { category: "Source Control" } as const;
const ai = { category: "AI" } as const;
const terminal = { category: "Terminal" } as const;
const workspace = { category: "Workspace" } as const;
const keyboard = { category: "Keyboard" } as const;

export const settingsSchema = withBehaviorFlags([
  // [ui]
  choice(
    "ui.theme",
    THEME_IDS.map((id) => [id, THEME_LABELS[id]] as const),
    "catppuccin-mocha",
    {
      ...appearance,
      title: "Color theme",
      description: "The color theme for the whole workspace.",
    },
  ),
  describe(
    "ui.accent",
    "enum-or-color",
    "default" as string,
    z.union([z.enum(ACCENT_VALUES), z.string().regex(/^#[0-9a-fA-F]{6}$/)]),
    `"default", one of ${quoteList(ACCENT_NAMES)}, or a #rrggbb color`,
    {
      ...appearance,
      title: "Accent color",
      description:
        "Color for focus, selection and active indicators. Named accents use the theme's own palette; a custom color is adjusted if needed to stay readable.",
    },
    { options: ACCENT_VALUES.map((value) => ({ value, label: value[0]?.toUpperCase() + value.slice(1) })) },
  ),
  choice(
    "ui.density",
    [
      ["comfortable", "Comfortable"],
      ["compact", "Compact"],
    ],
    "comfortable",
    { ...appearance, title: "Density", description: "Spacing between rows and around panels." },
  ),
  choice(
    "ui.icons",
    [
      ["auto", "Automatic"],
      ["nerd", "Nerd Font"],
      ["unicode", "Unicode symbols"],
      ["ascii", "ASCII"],
    ],
    "auto",
    {
      ...appearance,
      title: "Icons",
      description:
        "Icon set. Nerd Font glyphs need a patched font; automatic uses Unicode symbols, or ASCII on the Linux console and non-UTF-8 locales.",
    },
  ),
  bool("ui.animations", true, {
    ...appearance,
    title: "Animations",
    description: "Subtle transitions such as panel slides. Turn off for remote or slow terminals.",
  }),
  choice(
    "ui.colorMode",
    [
      ["auto", "Automatic"],
      ["truecolor", "24-bit color"],
      ["256", "256 colors"],
      ["16", "16 colors"],
    ],
    "auto",
    {
      ...appearance,
      title: "Color mode",
      description:
        "How many colors the terminal can show. Automatic reads COLORTERM, TERM and NO_COLOR; an explicit value overrides them.",
    },
  ),

  // [layout]
  choice(
    "layout.sidebarSide",
    [
      ["left", "Left"],
      ["right", "Right"],
    ],
    "left",
    { ...layout, title: "Sidebar position", description: "Which side the sidebar is on." },
  ),
  int(
    "layout.sidebarWidth",
    30,
    { min: 16, max: 80, unit: "columns" },
    {
      ...layout,
      title: "Sidebar width",
      description: "Initial sidebar width. Resizing in the app is remembered per workspace.",
    },
  ),
  int(
    "layout.aiPanelWidth",
    64,
    { min: 30, max: 200, unit: "columns" },
    { ...layout, title: "AI panel width", description: "Initial width of the Claude Code panel." },
  ),
  int(
    "layout.bottomPanelHeight",
    12,
    { min: 4, max: 60, unit: "rows" },
    { ...layout, title: "Bottom panel height", description: "Initial height of the terminal panel." },
  ),
  bool("layout.showCommandBar", true, {
    ...layout,
    title: "Command bar",
    description: "Show the command bar at the top of the window.",
  }),
  bool("layout.showStatusBar", true, {
    ...layout,
    title: "Status bar",
    description: "Show the status bar at the bottom of the window.",
  }),
  bool("layout.showActivityBar", true, {
    ...layout,
    title: "Activity bar",
    description: "Show the narrow bar that switches between Explorer, Search and Source Control.",
  }),

  // [editor]
  bool("editor.lineNumbers", true, { ...editor, title: "Line numbers", description: "Show line numbers." }),
  bool("editor.wrap", false, { ...editor, title: "Word wrap", description: "Wrap long lines." }),
  int(
    "editor.tabWidth",
    4,
    { min: 1, max: 16, unit: "columns" },
    { ...editor, title: "Tab width", description: "Width of a tab character." },
  ),
  bool("editor.highlightActiveLine", true, {
    ...editor,
    title: "Highlight cursor line",
    description: "Tint the background of the line with the cursor.",
  }),
  describe(
    "editor.external",
    "enum-or-command",
    "auto" as ExternalEditorSetting,
    z.union([z.enum(EXTERNAL_EDITORS), z.array(safeText(4096).min(1)).min(1).max(32)]),
    `one of ${quoteList(EXTERNAL_EDITORS)}, or a command as a list of strings such as ["code", "--wait"]`,
    {
      ...editor,
      title: "External editor",
      description:
        "Editor used for editing files. Automatic prefers $VISUAL, then $EDITOR, then the first installed terminal editor. A custom command may use the {file}, {line} and {column} placeholders; without {file} the path is appended as the last argument.",
    },
    {
      options: [
        { value: "auto", label: "Automatic" },
        { value: "micro", label: "micro" },
        { value: "hx", label: "Helix" },
        { value: "nvim", label: "Neovim" },
        { value: "vim", label: "Vim" },
        { value: "nano", label: "nano" },
        { value: "vi", label: "vi" },
      ],
    },
  ),
  int(
    "editor.maxFileSizeMb",
    5,
    { min: 1, max: 512, unit: "MB" },
    {
      ...editor,
      title: "Largest file to open",
      description: "Files above this size open in a lightweight preview instead of the viewer.",
    },
  ),
  bool("editor.previewTabs", true, {
    ...editor,
    title: "Preview tabs",
    description: "Single-clicking a file reuses one preview tab until you edit or pin it.",
  }),

  // [explorer]
  bool("explorer.showHidden", true, {
    ...explorer,
    title: "Show hidden files",
    description: "Show files and folders whose names start with a dot.",
  }),
  bool("explorer.showIgnored", true, {
    ...explorer,
    title: "Show ignored files",
    description: "Show files ignored by Git, dimmed.",
  }),
  list(
    "explorer.exclude",
    [".git", ".DS_Store"],
    { maxItems: 200, maxLength: 512, allowEmpty: false },
    {
      ...explorer,
      title: "Excluded names",
      description: "File and folder names or glob patterns that never appear in the explorer.",
    },
  ),
  bool("explorer.confirmDelete", true, {
    ...explorer,
    title: "Confirm delete",
    description: "Ask before deleting files.",
  }),

  // [search]
  choice(
    "search.engine",
    [
      ["auto", "Automatic"],
      ["ripgrep", "ripgrep"],
      ["git-grep", "git grep"],
      ["builtin", "Built-in"],
    ],
    "auto",
    {
      ...search,
      title: "Search engine",
      description: "Automatic prefers ripgrep, then git grep, then the built-in search.",
    },
  ),
  int(
    "search.maxResults",
    5000,
    { min: 100, max: 100000, unit: "matches" },
    { ...search, title: "Result limit", description: "Stop searching after this many matches." },
  ),
  bool("search.smartCase", true, {
    ...search,
    title: "Smart case",
    description: "Ignore case unless the query contains an uppercase letter.",
  }),

  // [git]
  bool("git.enabled", true, {
    ...git,
    title: "Source Control",
    description: "Enable Git integration.",
  }),
  bool("git.autoRefresh", true, {
    ...git,
    title: "Refresh automatically",
    description: "Refresh Git status when files change.",
  }),
  bool("git.confirmPush", true, {
    ...git,
    title: "Confirm push",
    description: "Ask before pushing to a remote.",
  }),
  choice(
    "git.defaultDiffView",
    [
      ["auto", "Automatic"],
      ["split", "Side by side"],
      ["unified", "Unified"],
    ],
    "auto",
    {
      ...git,
      title: "Diff layout",
      description: "Automatic shows side by side when the editor is wide enough.",
    },
  ),
  int(
    "git.networkTimeoutSeconds",
    60,
    { min: 5, max: 600, unit: "seconds" },
    {
      ...git,
      title: "Network timeout",
      description: "How long fetch, pull and push may run before they are stopped.",
    },
  ),

  // [ai]
  choice("ai.provider", [["claude", "Claude Code"]], "claude", {
    ...ai,
    title: "AI provider",
    description: "The coding agent that runs in the AI panel.",
  }),
  text("ai.executable", "", 4096, {
    ...ai,
    title: "Claude Code executable",
    description: "Path to the claude executable. Empty finds it on PATH.",
  }),
  list(
    "ai.args",
    [],
    { maxItems: 64, maxLength: 4096, allowEmpty: true },
    { ...ai, title: "Extra arguments", description: "Arguments added to every Claude Code session." },
  ),
  choice(
    "ai.onPanelClose",
    [
      ["keep-running", "Keep running"],
      ["terminate", "Stop the session"],
      ["ask", "Ask"],
    ],
    "keep-running",
    {
      ...ai,
      title: "When the AI panel closes",
      description: "Keep running lets a session continue in the background while the panel is hidden.",
    },
  ),
  choice(
    "ai.defaultMode",
    [
      ["new", "New session"],
      ["continue", "Continue the last session"],
    ],
    "new",
    { ...ai, title: "Opening the AI panel", description: "Start a new session or continue the last one." },
  ),

  // [terminal]
  text("terminal.shell", "", 4096, {
    ...terminal,
    title: "Shell",
    description: "Shell for the embedded terminal. Empty uses $SHELL.",
  }),
  list(
    "terminal.args",
    [],
    { maxItems: 64, maxLength: 4096, allowEmpty: true },
    { ...terminal, title: "Shell arguments", description: "Arguments passed to the shell." },
  ),
  int(
    "terminal.scrollback",
    5000,
    { min: 100, max: 100000, unit: "lines" },
    { ...terminal, title: "Scrollback", description: "Lines kept in the terminal history." },
  ),

  // [workspace]
  bool("workspace.restore", true, {
    ...workspace,
    title: "Restore workspace",
    description: "Reopen files and layout from the last session in this folder.",
  }),
  bool("workspace.watch", true, {
    ...workspace,
    title: "Watch files",
    description: "Update the explorer and Source Control when files change on disk.",
  }),

  // [keybindings]
  choice(
    "keybindings.mode",
    [
      ["character", "By character"],
      ["physical", "By key position"],
    ],
    "character",
    {
      ...keyboard,
      title: "Match shortcuts",
      description:
        "By character matches the character a key types on your layout. By key position matches the physical key (US layout position) when the terminal reports it, which helps on non-Latin layouts.",
    },
  ),
  describe(
    "keybindings.bindings",
    "keybinding-map",
    {} as KeybindingOverrides,
    z.record(safeText(200).min(1), keybindingOverrideSchema),
    'a table of command ids to a chord such as "ctrl+b", a list of chords, or false',
    {
      ...keyboard,
      title: "Custom shortcuts",
      description: "Overrides for default shortcuts. A list sets several; false removes a shortcut.",
    },
  ),
] as const);

type AnySetting = (typeof settingsSchema)[number];

export type SettingPath = AnySetting["path"];

export type SettingValue<P extends SettingPath> = Extract<AnySetting, { path: P }>["default"];

type SectionOf<P> = P extends `${infer S}.${string}` ? S : never;

export type ConfigSection = SectionOf<SettingPath>;

/** The fully defaulted, validated configuration. Treat it as immutable. */
export type Config = {
  [S in ConfigSection]: {
    [D in AnySetting as D["path"] extends `${S}.${infer K}` ? K : never]: D["default"];
  };
};

export const CONFIG_SECTIONS: readonly ConfigSection[] = [
  ...new Set(settingsSchema.map((d) => d.section)),
] as ConfigSection[];

const BY_PATH = new Map<string, AnySetting>(settingsSchema.map((d) => [d.path, d]));

export function getDescriptor<P extends SettingPath>(path: P): Extract<AnySetting, { path: P }>;
export function getDescriptor(path: string): AnySetting | undefined;
export function getDescriptor(path: string): AnySetting | undefined {
  return BY_PATH.get(path);
}

export function isSettingPath(path: string): path is SettingPath {
  return BY_PATH.has(path);
}
