import { describe, expect, test } from "bun:test";
import { getDescriptor } from "@/core/config/schema";
import { contrastRatio, isHexColor, relativeLuminance } from "@/themes/color";
import { ACCENT_NAMES, DEFAULT_THEME_ID, THEME_IDS } from "@/themes/ids";
import { getTheme, listThemes, themeFromSettings } from "@/themes/registry";
import { contrastTargets, resolveAccent, withAccent } from "@/themes/theme";
import {
  getToken,
  mapTokens,
  TERMINAL_ANSI_ORDER,
  TOKEN_DEFINITIONS,
  tokenDescription,
  tokenPaths,
  withToken,
} from "@/themes/tokens";

describe("token model", () => {
  test("has 71 UI tokens plus a 20-entry terminal palette", () => {
    const paths = tokenPaths();
    expect(paths.filter((p) => !p.startsWith("terminal.")).length).toBe(71);
    expect(paths.filter((p) => p.startsWith("terminal.")).length).toBe(20);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("every token documents its role", () => {
    for (const path of tokenPaths()) expect(tokenDescription(path).length).toBeGreaterThan(5);
  });

  test("terminal ANSI order covers all 16 colors", () => {
    expect(TERMINAL_ANSI_ORDER).toHaveLength(16);
    for (const name of TERMINAL_ANSI_ORDER) expect(name in TOKEN_DEFINITIONS.terminal).toBe(true);
  });

  test("getToken / withToken / mapTokens", () => {
    const tokens = getTheme("catppuccin-mocha").tokens;
    expect(getToken(tokens, "bg.base")).toBe("#1e1e2e");
    const changed = withToken(tokens, "bg.base", "#000000");
    expect(getToken(changed, "bg.base")).toBe("#000000");
    expect(getToken(tokens, "bg.base")).toBe("#1e1e2e");
    expect(changed.fg).toBe(tokens.fg);
    const upper = mapTokens(tokens, (value) => value.toUpperCase());
    expect(getToken(upper, "syntax.keyword")).toBe("#CBA6F7");
  });
});

describe.each(listThemes().map((t) => [t.id, t] as const))("theme %s", (_id, theme) => {
  test("defines every token as #rrggbb, with no extras", () => {
    for (const path of tokenPaths()) expect(isHexColor(getToken(theme.tokens, path))).toBe(true);
    for (const [group, names] of Object.entries(theme.tokens)) {
      expect(Object.keys(names).sort()).toEqual(Object.keys(TOKEN_DEFINITIONS[group as "bg"]).sort());
    }
  });

  test("maps every named accent to a palette color", () => {
    for (const name of ACCENT_NAMES) expect(isHexColor(theme.accents[name])).toBe(true);
  });

  test("the canvas is the darkest backdrop: never lighter than base or surface", () => {
    const { canvas, base, surface } = theme.tokens.bg;
    expect(relativeLuminance(canvas)).toBeLessThanOrEqual(relativeLuminance(base));
    expect(relativeLuminance(canvas)).toBeLessThanOrEqual(relativeLuminance(surface));
  });

  test("every theme has a distinct name", () => {
    expect(listThemes().filter((t) => t.name === theme.name)).toHaveLength(1);
  });

  test("tints are subtle: diff and selection backgrounds stay close to the canvas", () => {
    const base = theme.tokens.editor.bg;
    for (const bg of [theme.tokens.diff.addedLineBg, theme.tokens.diff.removedLineBg]) {
      expect(contrastRatio(bg, base)).toBeLessThan(1.6);
      expect(bg).not.toBe(base);
    }
  });
});

describe("Catppuccin Mocha anchors fixed by the product owner", () => {
  const t = getTheme("catppuccin-mocha").tokens;
  test.each([
    ["bg.base", "#1e1e2e"],
    ["bg.surface", "#181825"],
    ["bg.raised", "#313244"],
    ["fg.default", "#cdd6f4"],
    ["fg.muted", "#a6adc8"],
    ["accent.primary", "#89b4fa"],
    ["accent.secondary", "#cba6f7"],
    ["status.success", "#a6e3a1"],
    ["status.warning", "#f9e2af"],
    ["status.error", "#f38ba8"],
  ] as const)("%s is %s", (path, hex) => {
    expect(getToken(t, path)).toBe(hex);
  });
});

/**
 * The dark themes added after the first four. Pinning base, body text and the default accent
 * to the published palette catches accidental drift; the contrast suite covers the rest.
 */
describe.each([
  ["dracula", "Dracula", "purple", "#282a36", "#f8f8f2", "#bd93f9"],
  ["nord", "Nord", "teal", "#2e3440", "#d8dee9", "#88c0d0"],
  ["one-dark", "One Dark", "blue", "#282c34", "#abb2bf", "#61afef"],
  ["rose-pine", "Rosé Pine", "orange", "#191724", "#e0def4", "#ebbcba"],
  ["kanagawa-wave", "Kanagawa Wave", "blue", "#1f1f28", "#dcd7ba", "#7e9cd8"],
  ["everforest-dark", "Everforest Dark", "green", "#2d353b", "#d3c6aa", "#a7c080"],
  ["github-dark", "GitHub Dark", "blue", "#0d1117", "#e6edf3", "#2f81f7"],
  ["solarized-dark", "Solarized Dark", "yellow", "#002b36", "#93a1a1", "#b58900"],
] as const)("dark theme %s", (id, name, defaultAccent, base, text, accent) => {
  const theme = getTheme(id);

  test("is registered under its own id with its display name", () => {
    expect(theme.id).toBe(id);
    expect(theme.name).toBe(name);
    expect(getDescriptor("ui.theme").options?.find((o) => o.value === id)?.label).toBe(name);
  });

  test("is a dark AA theme built on its published palette", () => {
    expect(theme.appearance).toBe("dark");
    expect(theme.contrastLevel).toBe("AA");
    expect(theme.tokens.bg.base).toBe(base);
    expect(theme.tokens.editor.bg).toBe(base);
    expect(theme.tokens.fg.default).toBe(text);
  });

  test("uses its own default accent unchanged", () => {
    expect(theme.defaultAccent).toBe(defaultAccent);
    expect(theme.accents[defaultAccent]).toBe(accent);
    expect(theme.accent).toBe(accent);
    expect(theme.tokens.accent.primary).toBe(accent);
  });

  test("the canvas is strictly darker than the chrome and the editor", () => {
    const { canvas, surface } = theme.tokens.bg;
    expect(relativeLuminance(canvas)).toBeLessThan(relativeLuminance(surface));
    expect(relativeLuminance(canvas)).toBeLessThan(relativeLuminance(base));
  });
});

describe("registry", () => {
  test("lists the twelve themes in order and defaults to Catppuccin Mocha", () => {
    expect(THEME_IDS).toHaveLength(12);
    expect(listThemes().map((t) => t.id)).toEqual([...THEME_IDS]);
    // High Contrast stays last so the accessibility option is easy to find in the picker.
    expect(THEME_IDS.at(-1)).toBe("high-contrast");
    expect(DEFAULT_THEME_ID).toBe("catppuccin-mocha");
    expect(getTheme("no-such-theme").id).toBe("catppuccin-mocha");
  });

  test("the config schema offers exactly the built-in themes", () => {
    expect(getDescriptor("ui.theme").options?.map((o) => o.value)).toEqual([...THEME_IDS]);
  });

  test("themeFromSettings applies the accent", () => {
    expect(themeFromSettings("tokyo-night").accent).toBe(getTheme("tokyo-night").accent);
    expect(themeFromSettings("tokyo-night", "purple").tokens.accent.primary).toBe(
      getTheme("tokyo-night").accents.purple,
    );
  });
});

describe("accent override", () => {
  const mocha = getTheme("catppuccin-mocha");

  test("named accent recomputes focus, selection and badge", () => {
    const purple = withAccent(mocha, "purple");
    expect(purple.tokens.accent.primary).toBe("#cba6f7");
    expect(purple.tokens.border.focus).toBe("#cba6f7");
    expect(purple.tokens.state.focusRing).toBe("#cba6f7");
    expect(purple.tokens.badge.bg).toBe("#cba6f7");
    expect(purple.tokens.state.selectedBg).not.toBe(mocha.tokens.state.selectedBg);
    expect(purple.tokens.editor.selectionBg).not.toBe(mocha.tokens.editor.selectionBg);
    // Accent-independent tokens are untouched.
    expect(purple.tokens.bg).toEqual(mocha.tokens.bg);
    expect(purple.tokens.syntax).toEqual(mocha.tokens.syntax);
  });

  test("default and unknown values resolve to the theme default", () => {
    expect(withAccent(mocha, "default").tokens).toEqual(mocha.tokens);
    expect(resolveAccent(mocha, "chartreuse")).toBe(mocha.accents.blue);
    expect(resolveAccent(mocha, "#ABCDEF")).toBe("#abcdef");
  });

  test("a too-dark custom accent is lifted to 3:1 on base and surface", () => {
    const dim = withAccent(mocha, "#202030");
    expect(contrastRatio(dim.tokens.accent.primary, dim.tokens.bg.base)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(dim.tokens.accent.primary, dim.tokens.bg.surface)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(dim.tokens.border.focus, dim.tokens.bg.surface)).toBeGreaterThanOrEqual(3);
  });

  test("a very light accent keeps selected text and on-accent text readable", () => {
    for (const accent of ["#ffff00", "#ffffff", "#00ff00"]) {
      const t = withAccent(mocha, accent).tokens;
      expect(contrastRatio(t.state.selectedFg, t.state.selectedBg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.fg.default, t.editor.selectionBg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.fg.onAccent, t.accent.primary)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.badge.fg, t.badge.bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("AAA themes guard at the stricter targets", () => {
    const hc = withAccent(getTheme("high-contrast"), "#3050a0");
    const targets = contrastTargets("AAA");
    expect(contrastRatio(hc.tokens.accent.primary, hc.tokens.bg.base)).toBeGreaterThanOrEqual(targets.ui);
    expect(contrastRatio(hc.tokens.state.selectedFg, hc.tokens.state.selectedBg)).toBeGreaterThanOrEqual(
      targets.text,
    );
  });
});
