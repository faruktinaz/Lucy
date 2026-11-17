/**
 * The resolved look of the UI: theme tokens mapped to the terminal's color capability once
 * per change, plus the appearance settings every component needs (icon tier, density,
 * animations). Components read it through `useTheme()` and use only `colors.*` tokens.
 */
import { type NativeResourceOwner, RGBA, type StyleDefinitionInput, SyntaxStyle } from "@opentui/core";
import {
  STYLE_GROUPS,
  SYNTAX_TOKEN_ATTRIBUTES,
  SYNTAX_TOKEN_FALLBACKS,
  type SyntaxTokenName,
  syntaxGroupToToken,
} from "@/adapters/syntax/style-groups";
import type { ConfigService } from "@/core/config";
import { type Disposable, Emitter } from "@/core/events";
import { Store } from "@/core/store";
import {
  type AccentSetting,
  blend,
  type ColorMode,
  contrastRatio,
  type IconTier,
  resolveColorMode,
  resolveIconTier,
  resolveTheme,
  TERMINAL_ANSI_ORDER,
  type ThemeId,
  type ThemeTokens,
  type TokenGroup,
  type TokenPath,
  themeFromSettings,
} from "@/themes";

export type Density = "comfortable" | "compact";

/** Every token as an OpenTUI color. Indexed (palette) colors in 256- and 16-color modes. */
export type ColorTokens = {
  readonly [G in TokenGroup]: { readonly [K in keyof ThemeTokens[G]]: RGBA };
};

export interface TerminalPalette {
  readonly foreground: string;
  readonly background: string;
  readonly cursor: string;
  readonly selection: string;
  /** ANSI 0..15. */
  readonly ansi: readonly string[];
}

/**
 * The island layout's colors. Cards must stand apart from the canvas: when a theme's chrome
 * tokens are (almost) the canvas color, the card fill is lifted toward `bg.raised`. High
 * Contrast outlines its cards instead, so shape never depends on color alone there.
 */
export interface ShellColors {
  readonly canvas: RGBA;
  /** Sidebar, agent panel, bottom panel. */
  readonly panel: RGBA;
  /** The editor area: the brightest card, where the work is. */
  readonly editor: RGBA;
  /** Soft drop shadow under floating overlays. */
  readonly shadow: RGBA;
  /** Draw cards with a thin outline instead of lips (High Contrast). */
  readonly outline: boolean;
}

/** Minimum contrast between a card and the canvas before the card is lifted. */
const CARD_SEPARATION = 1.06;

function deriveShell(
  hex: ThemeTokens,
  colors: ColorTokens,
  colorMode: ColorMode,
  highContrast: boolean,
): ShellColors {
  const canvas = colors.bg.canvas;
  const shadow = withAlpha(canvas, 0.7);
  // Palette modes keep the terminal's own colors: no derived blends there.
  if (colorMode !== "truecolor" || highContrast) {
    return { canvas, panel: colors.bg.surface, editor: colors.bg.base, shadow, outline: highContrast };
  }
  const lift = (token: string): RGBA => {
    if (contrastRatio(token, hex.bg.canvas) >= CARD_SEPARATION) return RGBA.fromHex(token);
    let t = 0.25;
    let lifted = blend(hex.bg.raised, token, t);
    while (contrastRatio(lifted, hex.bg.canvas) < CARD_SEPARATION && t < 1) {
      t += 0.15;
      lifted = blend(hex.bg.raised, token, Math.min(1, t));
    }
    return RGBA.fromHex(lifted);
  };
  return { canvas, panel: lift(hex.bg.surface), editor: lift(hex.bg.base), shadow, outline: false };
}

export interface UiTheme {
  readonly id: ThemeId;
  readonly name: string;
  readonly appearance: "dark" | "light";
  /** The theme targets WCAG AAA: never rely on color alone (add markers, bold). */
  readonly highContrast: boolean;
  readonly colorMode: ColorMode;
  /** Resolved hex value of every token (palette color in 256/16 modes). */
  readonly hex: ThemeTokens;
  readonly colors: ColorTokens;
  readonly icons: IconTier;
  readonly density: Density;
  /** `ui.cornerStyle`: soft corners on cards and pills, or plain blocks. */
  readonly cornerStyle: "rounded" | "square";
  /**
   * Pill ends can be drawn as Nerd Font half circles (U+E0B4 / U+E0B6): only with the nerd
   * icon tier (the font is there) and rounded corners.
   */
  readonly roundCaps: boolean;
  /** Colors of the island layout, derived from the tokens (see `deriveShell`). */
  readonly shell: ShellColors;
  readonly animations: boolean;
  /** Built from the syntax tokens; `null` when no renderer is attached (unit tests). */
  readonly syntaxStyle: SyntaxStyle | null;
  /** Colors for embedded terminals (`OSC 10/11` prelude and palette). */
  readonly terminal: TerminalPalette;
  /** Increases on every change, handy as a React key. */
  readonly revision: number;
}

export interface ThemeServiceOptions {
  config: ConfigService;
  env?: Record<string, string | undefined>;
  /** Owner of native resources (the renderer's `nativeScene`); without it no SyntaxStyle is built. */
  styleOwner?: NativeResourceOwner;
}

/** A color token by path, e.g. `colorOf(theme, "git.added")`. */
export function colorOf(theme: UiTheme, path: TokenPath): RGBA {
  const [group, name] = path.split(".") as [TokenGroup, string];
  const value = (theme.colors[group] as Record<string, RGBA | undefined>)[name];
  return value ?? theme.colors.fg.default;
}

/** The same color with an alpha channel (for dimmed backdrops). Palette colors stay opaque. */
export function withAlpha(color: RGBA, alpha: number): RGBA {
  if (color.intent !== "rgb") return color;
  return RGBA.fromValues(color.r, color.g, color.b, alpha);
}

function toColors(hex: ThemeTokens, indexes: Readonly<Partial<Record<TokenPath, number>>>): ColorTokens {
  const out: Record<string, Record<string, RGBA>> = {};
  for (const [group, names] of Object.entries(hex) as [string, Record<string, string>][]) {
    const mapped: Record<string, RGBA> = {};
    for (const [name, value] of Object.entries(names)) {
      const index = indexes[`${group}.${name}` as TokenPath];
      // Palette indexes keep the terminal's own colors in 256/16-color mode; the hex value is
      // the snapshot used for screenshots and blending.
      mapped[name] = index === undefined ? RGBA.fromHex(value) : RGBA.fromIndex(index, value);
    }
    out[group] = mapped;
  }
  return out as unknown as ColorTokens;
}

function syntaxColor(tokens: ThemeTokens, token: SyntaxTokenName): string | null {
  const own = (tokens.syntax as Record<string, string | undefined>)[token];
  if (own) return own;
  const fallback = (SYNTAX_TOKEN_FALLBACKS as Record<string, SyntaxTokenName | null | undefined>)[token];
  if (fallback === null || fallback === undefined) return null;
  return (tokens.syntax as Record<string, string | undefined>)[fallback] ?? null;
}

/** Builds the OpenTUI style table for every highlight group from the theme's syntax tokens. */
export function buildSyntaxStyle(
  theme: Pick<UiTheme, "hex" | "colors">,
  owner: NativeResourceOwner,
): SyntaxStyle {
  const styles: Record<string, StyleDefinitionInput> = { default: { fg: theme.colors.fg.default } };
  for (const group of STYLE_GROUPS) {
    const token = syntaxGroupToToken(group);
    if (!token) continue;
    const hex = syntaxColor(theme.hex, token);
    const attributes = SYNTAX_TOKEN_ATTRIBUTES[token] ?? {};
    const color =
      hex === null
        ? theme.colors.fg.default
        : ((theme.colors.syntax as Record<string, RGBA | undefined>)[token] ?? RGBA.fromHex(hex));
    styles[group] = { fg: color, ...attributes };
  }
  return SyntaxStyle.fromStyles(styles, owner);
}

const APPEARANCE_SETTINGS = [
  "ui.theme",
  "ui.accent",
  "ui.colorMode",
  "ui.icons",
  "ui.density",
  "ui.animations",
  "ui.cornerStyle",
];

export class ThemeService implements Disposable {
  readonly store: Store<UiTheme>;
  private readonly changes = new Emitter<UiTheme>();
  private readonly subscription: Disposable;
  /** Styles are destroyed one generation late, once no `<code>` can still hold them. */
  private retired: SyntaxStyle | null = null;
  private revision = 0;

  constructor(private readonly options: ThemeServiceOptions) {
    this.store = new Store(this.build());
    this.subscription = options.config.onDidChange((event) => {
      if (event.changed.some((path) => APPEARANCE_SETTINGS.includes(path))) this.rebuild();
    });
  }

  get current(): UiTheme {
    return this.store.get();
  }

  /** Recomputes the theme (after a setting or terminal capability change). */
  rebuild(): void {
    const previous = this.store.get();
    const next = this.build();
    this.retired?.destroy();
    this.retired = previous.syntaxStyle;
    this.store.set(next);
    this.changes.emit(next);
  }

  /** Shows a theme without saving it (the theme picker's live preview). */
  async preview(themeId: ThemeId): Promise<void> {
    await this.options.config.set("ui.theme", themeId, { persist: false });
  }

  onDidChange(listener: (theme: UiTheme) => void): Disposable {
    return this.changes.on(listener);
  }

  private build(): UiTheme {
    const { config } = this.options;
    const env = this.options.env ?? process.env;
    const base = themeFromSettings(config.get("ui.theme"), config.get("ui.accent") as AccentSetting);
    const colorMode = resolveColorMode(config.get("ui.colorMode"), env);
    const resolved = resolveTheme(base, colorMode);
    const colors = toColors(resolved.tokens, resolved.indexes);
    const hex = resolved.tokens;
    const terminal: TerminalPalette = {
      foreground: hex.terminal.fg,
      background: hex.terminal.bg,
      cursor: hex.terminal.cursor,
      selection: hex.terminal.selectionBg,
      ansi: TERMINAL_ANSI_ORDER.map((name) => hex.terminal[name]),
    };
    const owner = this.options.styleOwner;
    return {
      id: base.id,
      name: base.name,
      appearance: base.appearance,
      highContrast: base.contrastLevel === "AAA",
      colorMode,
      hex,
      colors,
      icons: resolveIconTier(config.get("ui.icons"), env),
      density: config.get("ui.density"),
      cornerStyle: config.get("ui.cornerStyle"),
      roundCaps:
        config.get("ui.cornerStyle") === "rounded" && resolveIconTier(config.get("ui.icons"), env) === "nerd",
      shell: deriveShell(hex, colors, colorMode, base.contrastLevel === "AAA"),
      animations: config.get("ui.animations"),
      syntaxStyle: owner ? buildSyntaxStyle({ hex, colors }, owner) : null,
      terminal,
      revision: ++this.revision,
    };
  }

  dispose(): void {
    this.subscription.dispose();
    this.changes.dispose();
    this.retired?.destroy();
    this.retired = null;
    this.store.get().syntaxStyle?.destroy();
  }
}
