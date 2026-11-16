import { describe, expect, test } from "bun:test";
import { contrastRatio } from "@/themes/color";
import { detectColorMode, resolveColorMode } from "@/themes/color-mode";
import { DEGRADATION_PAIRS, resolveTheme } from "@/themes/degrade";
import { listThemes } from "@/themes/registry";
import { withAccent } from "@/themes/theme";
import { getToken, TERMINAL_ANSI_ORDER, type TokenPath, tokenPaths } from "@/themes/tokens";

const variants = listThemes().flatMap((theme) => [
  theme,
  withAccent(theme, "yellow"),
  withAccent(theme, "#ffffff"),
  withAccent(theme, "#101010"),
]);

describe("resolveTheme", () => {
  test("truecolor returns the theme's tokens unchanged", () => {
    const theme = listThemes()[0];
    if (!theme) throw new Error("no themes");
    const resolved = resolveTheme(theme, "truecolor");
    expect(resolved.tokens).toBe(theme.tokens);
    expect(resolved.indexes).toEqual({});
  });

  describe.each(["256", "16"] as const)("%s colors", (mode) => {
    test.each(variants.map((t) => [`${t.id} accent ${t.accent}`, t] as const))("%s", (_label, theme) => {
      const resolved = resolveTheme(theme, mode);
      const [lo, hi] = mode === "256" ? [16, 255] : [0, 15];
      for (const path of tokenPaths()) {
        const index = resolved.indexes[path];
        expect(index).toBeGreaterThanOrEqual(lo);
        expect(index).toBeLessThanOrEqual(hi);
      }
      // The guard: important pairs never collapse to the same palette entry.
      for (const pair of DEGRADATION_PAIRS) {
        expect(`${pair.fg}=${resolved.indexes[pair.fg]}`).not.toBe(`${pair.fg}=${resolved.indexes[pair.bg]}`);
      }
      // Selection and the current find match stay visible against the canvas.
      expect(resolved.indexes["state.selectedBg"]).not.toBe(resolved.indexes["bg.base"]);
      expect(resolved.indexes["editor.selectionBg"]).not.toBe(resolved.indexes["editor.bg"]);
      expect(resolved.indexes["editor.findMatchActiveBg"]).not.toBe(resolved.indexes["editor.bg"]);
    });
  });

  test("256 colors keep real WCAG contrast for text pairs (entries 16-255 are fixed)", () => {
    for (const theme of variants) {
      const resolved = resolveTheme(theme, "256");
      for (const pair of DEGRADATION_PAIRS.filter((p) => p.strength === "text")) {
        const ratio = contrastRatio(getToken(resolved.tokens, pair.fg), getToken(resolved.tokens, pair.bg));
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("16 colors map the terminal palette onto the terminal's own ANSI entries", () => {
    const resolved = resolveTheme(listThemes()[0] ?? variants[0]!, "16");
    TERMINAL_ANSI_ORDER.forEach((name, index) => {
      expect(resolved.indexes[`terminal.${name}` as TokenPath]).toBe(index);
    });
  });

  test("16 colors keep text on the grey ramp and status colors in their hue family", () => {
    for (const theme of listThemes()) {
      const ix = resolveTheme(theme, "16").indexes;
      expect([7, 15]).toContain(ix["fg.default"] ?? -1);
      expect(ix["bg.base"]).toBe(0);
      expect([1, 9]).toContain(ix["status.error"] ?? -1);
      expect([2, 10]).toContain(ix["git.added"] ?? -1);
      expect([3, 11]).toContain(ix["git.modified"] ?? -1);
      expect(ix["git.added"]).not.toBe(ix["git.modified"]);
    }
  });
});

describe("detectColorMode", () => {
  test.each([
    [{ COLORTERM: "truecolor", TERM: "xterm-256color" }, "truecolor"],
    [{ COLORTERM: "24bit" }, "truecolor"],
    [{ COLORTERM: "TrueColor", TERM: "xterm" }, "truecolor"],
    [{ TERM: "xterm-direct" }, "truecolor"],
    [{ TERM: "xterm-256color" }, "256"],
    [{ TERM: "tmux-256color", COLORTERM: "yes" }, "256"],
    [{ TERM: "xterm" }, "16"],
    [{ TERM: "linux" }, "16"],
    [{ TERM: "dumb", COLORTERM: "" }, "16"],
    [{}, "16"],
    [{ NO_COLOR: "1", COLORTERM: "truecolor", TERM: "xterm-256color" }, "16"],
    [{ NO_COLOR: "", COLORTERM: "truecolor" }, "truecolor"],
  ] as const)("%o -> %s", (env, expected) => {
    expect(detectColorMode(env)).toBe(expected);
  });

  test("an explicit setting wins over detection and NO_COLOR", () => {
    expect(resolveColorMode("truecolor", { NO_COLOR: "1" })).toBe("truecolor");
    expect(resolveColorMode("256", { COLORTERM: "truecolor" })).toBe("256");
    expect(resolveColorMode("auto", { TERM: "xterm-256color" })).toBe("256");
  });
});
