/**
 * First-run onboarding as a step state machine. Nothing is written until `finish()`: the
 * theme step previews live (in memory only) and `skip()` restores the previous theme. The
 * same model can be started again later from a command; it starts from the current settings.
 */
import type { EXTERNAL_EDITORS, SettingPath } from "@/core/config/schema";
import { getDescriptor } from "@/core/config/schema";
import type { ConfigService } from "@/core/config/service";
import { deepEqual, getSetting } from "@/core/config/values";
import { errorMessage } from "@/core/errors";
import type { Disposable } from "@/core/events";
import { formatChord } from "@/core/keybindings/chord";
import { type AppDirs, tildify } from "@/core/paths";
import { Store } from "@/core/store";
import { UI_ICONS } from "@/themes/icons";
import { THEME_IDS, type ThemeId } from "@/themes/ids";
import { getTheme } from "@/themes/registry";
import { formatCommandLine } from "./command-line";
import { writeOnboardingMarker } from "./onboarding-marker";
import { formatSettingValue } from "./setting-controls";

export const ONBOARDING_STEPS = ["theme", "icons", "keyboard", "editor", "ai", "summary"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Derived from the config schema so a newly supported editor can never be rejected here. */
export type EditorChoice = (typeof EXTERNAL_EDITORS)[number];

export interface EditorCandidate {
  id: Exclude<EditorChoice, "auto">;
  label: string;
  path: string;
}

export interface AiDetection {
  found: boolean;
  path?: string;
  version?: string;
  /** Why detection failed, if it did (not "not installed"). */
  error?: string;
}

export interface OnboardingDeps {
  config: ConfigService;
  dirs: Pick<AppDirs, "state">;
  /** Whether the terminal speaks the kitty keyboard protocol (from the renderer). */
  kittyKeyboard: boolean;
  /** Platform for chord labels and the macOS Option note. Defaults to the current one. */
  platform?: string;
  detectEditors: () => Promise<EditorCandidate[]>;
  ai: { detect: () => Promise<AiDetection> };
  now?: () => Date;
  home?: string;
}

export type Async<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: T }
  | { readonly status: "error"; readonly error: string };

export interface ThemeOption {
  readonly id: ThemeId;
  readonly name: string;
}

export interface SummaryEntry {
  readonly path: SettingPath;
  readonly configKey: string;
  readonly title: string;
  readonly value: unknown;
  readonly valueLabel: string;
}

export interface OnboardingChoices {
  readonly theme: ThemeId;
  /** null until the user answers whether the sample glyphs render correctly. */
  readonly nerdFontRenders: boolean | null;
  readonly editor: EditorChoice | readonly string[];
}

export interface OnboardingState {
  readonly step: OnboardingStep;
  readonly stepIndex: number;
  readonly stepCount: number;
  readonly choices: OnboardingChoices;
  /** Whether the current step lets the user continue. */
  readonly canGoNext: boolean;
  readonly canGoBack: boolean;
  /** Per-step validity, for a progress indicator. */
  readonly valid: Readonly<Record<OnboardingStep, boolean>>;
  readonly themes: readonly ThemeOption[];
  readonly iconSamples: readonly { readonly name: string; readonly glyph: string }[];
  readonly keyboard: { readonly kittyKeyboard: boolean; readonly explanation: string };
  readonly editors: Async<readonly EditorCandidate[]>;
  readonly ai: Async<AiDetection>;
  readonly aiStatement: string;
  readonly summary: { readonly entries: readonly SummaryEntry[]; readonly filePath: string };
  readonly status: "active" | "finishing" | "finished" | "skipped";
  readonly error: string | null;
}

const AI_STATEMENT =
  "Lucy starts Claude Code only when you open the AI panel, using your existing login and permission settings. Lucy never sends prompts by itself and never adds permission-bypass flags.";

const SAMPLE_ICONS = ["folder", "explorer", "sourceControl", "branch", "search", "settings"] as const;

function keyboardExplanation(kitty: boolean, platform: string): string {
  const style = platform === "darwin" ? "mac" : "text";
  const label = (key: string) => formatChord(key, style, { platform });
  const base = kitty
    ? `Your terminal supports the kitty keyboard protocol, so shortcuts such as ${label("ctrl+shift+p")} work as written.`
    : `Your terminal uses classic keyboard input, which cannot tell ${label("ctrl+shift+p")} from ${label("ctrl+p")}. Every such shortcut has a fallback: ${label("f1")} opens the command palette, and ${label("ctrl+k")} followed by a letter reaches the views (${label("ctrl+k e")} for the Explorer).`;
  return platform === "darwin"
    ? `${base} Shortcuts with Option need "Use Option as Meta/Alt" in your terminal's settings.`
    : base;
}

export class OnboardingModel implements Disposable {
  readonly store: Store<OnboardingState>;
  private readonly deps: OnboardingDeps;
  private readonly originalTheme: ThemeId;
  private disposed = false;

  constructor(deps: OnboardingDeps) {
    this.deps = deps;
    const config = deps.config.config;
    this.originalTheme = config.ui.theme;
    const external = config.editor.external;
    const choices: OnboardingChoices = {
      theme: config.ui.theme,
      nerdFontRenders: config.ui.icons === "nerd" ? true : null,
      editor: external,
    };
    const platform = deps.platform ?? process.platform;
    this.store = new Store<OnboardingState>(
      this.derive({
        step: "theme",
        stepIndex: 0,
        stepCount: ONBOARDING_STEPS.length,
        choices,
        canGoNext: true,
        canGoBack: false,
        valid: { theme: true, icons: false, keyboard: true, editor: true, ai: true, summary: true },
        themes: THEME_IDS.map((id) => ({ id, name: getTheme(id).name })),
        iconSamples: SAMPLE_ICONS.map((name) => ({ name, glyph: UI_ICONS.nerd[name] })),
        keyboard: {
          kittyKeyboard: deps.kittyKeyboard,
          explanation: keyboardExplanation(deps.kittyKeyboard, platform),
        },
        editors: { status: "loading" },
        ai: { status: "loading" },
        aiStatement: AI_STATEMENT,
        summary: { entries: [], filePath: tildify(deps.config.path, deps.home) },
        status: "active",
        error: null,
      }),
    );
  }

  get state(): OnboardingState {
    return this.store.get();
  }

  /** Runs the injected detectors. Safe to call again; results replace earlier ones. */
  async start(): Promise<void> {
    await Promise.all([
      this.deps
        .detectEditors()
        .then((value) => this.patch({ editors: { status: "ready", value } }))
        .catch((error: unknown) => this.patch({ editors: { status: "error", error: errorMessage(error) } })),
      this.deps.ai
        .detect()
        .then((value) => this.patch({ ai: { status: "ready", value } }))
        .catch((error: unknown) => this.patch({ ai: { status: "error", error: errorMessage(error) } })),
    ]);
  }

  private patch(partial: Partial<OnboardingState>): void {
    if (this.disposed) return;
    this.store.set(this.derive({ ...this.store.get(), ...partial }));
  }

  /** Recomputes validity, navigation flags and the summary from the choices. */
  private derive(state: OnboardingState): OnboardingState {
    const valid: Record<OnboardingStep, boolean> = {
      theme: THEME_IDS.includes(state.choices.theme),
      icons: state.choices.nerdFontRenders !== null,
      keyboard: true,
      editor: true,
      ai: true,
      summary: true,
    };
    return {
      ...state,
      stepIndex: ONBOARDING_STEPS.indexOf(state.step),
      valid,
      canGoBack: state.status === "active" && state.step !== "theme",
      canGoNext: state.status === "active" && valid[state.step] && state.step !== "summary",
      summary: { ...state.summary, entries: this.pendingEntries(state.choices) },
    };
  }

  /** Settings the choices would change, compared with the current config. */
  private pendingEntries(choices: OnboardingChoices): SummaryEntry[] {
    const config = this.deps.config.config;
    const wanted: [SettingPath, unknown][] = [
      // The theme is compared with what was saved, not with the live preview.
      ["ui.theme", choices.theme],
      // "No" only moves away from Nerd Font; an explicit unicode/ascii choice is kept.
      [
        "ui.icons",
        choices.nerdFontRenders === true
          ? "nerd"
          : choices.nerdFontRenders === false && config.ui.icons === "nerd"
            ? "auto"
            : config.ui.icons,
      ],
      ["editor.external", choices.editor],
    ];
    const entries: SummaryEntry[] = [];
    for (const [path, value] of wanted) {
      const current = path === "ui.theme" ? this.originalTheme : getSetting(config, path);
      if (deepEqual(current, value)) continue;
      const descriptor = getDescriptor(path);
      entries.push({
        path,
        configKey: descriptor.tomlPath,
        title: descriptor.title,
        value,
        valueLabel: Array.isArray(value)
          ? formatCommandLine(value as string[])
          : formatSettingValue(descriptor, value),
      });
    }
    return entries;
  }

  // ---- Navigation -----------------------------------------------------------------------------

  next(): boolean {
    const state = this.store.get();
    if (!state.canGoNext) return false;
    this.patch({ step: ONBOARDING_STEPS[state.stepIndex + 1] ?? state.step, error: null });
    return true;
  }

  back(): boolean {
    const state = this.store.get();
    if (!state.canGoBack) return false;
    this.patch({ step: ONBOARDING_STEPS[state.stepIndex - 1] ?? state.step, error: null });
    return true;
  }

  // ---- Choices --------------------------------------------------------------------------------

  /** Picks a theme and previews it live (in memory; nothing is written). */
  async chooseTheme(theme: ThemeId): Promise<void> {
    if (!THEME_IDS.includes(theme)) return;
    this.patch({ choices: { ...this.store.get().choices, theme } });
    try {
      await this.deps.config.set("ui.theme", theme, { persist: false });
    } catch (error) {
      this.patch({ error: `Could not preview the theme: ${errorMessage(error)}` });
    }
  }

  /** Answers "do these Nerd Font glyphs render correctly?"; yes selects the Nerd Font tier. */
  answerNerdFont(renders: boolean): void {
    this.patch({ choices: { ...this.store.get().choices, nerdFontRenders: renders } });
  }

  /** "auto" or a detected editor. */
  chooseEditor(editor: EditorChoice): void {
    this.patch({ choices: { ...this.store.get().choices, editor } });
  }

  // ---- Completion -----------------------------------------------------------------------------

  /** Writes the chosen settings in one save, then marks onboarding complete. */
  async finish(): Promise<boolean> {
    const state = this.store.get();
    if (state.status !== "active" || state.step !== "summary") return false;
    this.patch({ status: "finishing", error: null });
    try {
      const entries = state.summary.entries.map(({ path, value }) => ({ path, value }));
      if (entries.length > 0) await this.deps.config.setMany(entries);
      await writeOnboardingMarker(this.deps.dirs, "finished", this.deps.now?.());
      this.patch({ status: "finished" });
      return true;
    } catch (error) {
      this.patch({ status: "active", error: `Could not save your choices: ${errorMessage(error)}` });
      return false;
    }
  }

  /** Marks onboarding complete without writing any setting; the theme preview is undone. */
  async skip(): Promise<boolean> {
    if (this.store.get().status !== "active") return false;
    try {
      await this.restoreTheme();
      await writeOnboardingMarker(this.deps.dirs, "skipped", this.deps.now?.());
      this.patch({ status: "skipped" });
      return true;
    } catch (error) {
      this.patch({ error: `Could not record that onboarding was skipped: ${errorMessage(error)}` });
      return false;
    }
  }

  private async restoreTheme(): Promise<void> {
    if (this.deps.config.config.ui.theme !== this.originalTheme) {
      await this.deps.config.set("ui.theme", this.originalTheme, { persist: false });
    }
  }

  /** Abandons the flow (window closed): undoes the preview, writes nothing. */
  async abandon(): Promise<void> {
    if (this.store.get().status === "active") await this.restoreTheme();
    this.dispose();
  }

  dispose(): void {
    this.disposed = true;
  }
}
