import { describe, expect, test } from "bun:test";
import { getDescriptor } from "@/core/config/schema";
import { contrastRatio, isHexColor } from "@/themes/color";
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
  test("has 70 UI tokens plus a 20-entry terminal palette", () => {
    const paths = tokenPaths();
    expect(paths.filter((p) => !p.startsWith("terminal.")).length).toBe(70);
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

describe("registry", () => {
  test("lists the four themes in order and defaults to Catppuccin Mocha", () => {
    expect(listThemes().map((t) => t.id)).toEqual([...THEME_IDS]);
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
