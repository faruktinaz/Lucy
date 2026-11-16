/**
 * The contrast suite is a product requirement: every requirement in CONTRAST_REQUIREMENTS
 * (see src/themes/README.md for the policy) must hold for every built-in theme.
 */
import { describe, expect, test } from "bun:test";
import { contrastRatio } from "@/themes/color";
import { auditContrast, CONTRAST_REQUIREMENTS } from "@/themes/contrast";
import { ACCENT_NAMES } from "@/themes/ids";
import { listThemes } from "@/themes/registry";
import { withAccent } from "@/themes/theme";
import { getToken, type TokenPath } from "@/themes/tokens";

const themes = listThemes();

describe.each(themes.map((t) => [t.id, t] as const))("%s", (_id, theme) => {
  const results = auditContrast(theme);

  test.each(results.map((r) => [`${r.fg} on ${r.bg} (${r.role})`, r] as const))("%s", (_label, result) => {
    expect(result.ratio).toBeGreaterThanOrEqual(result.min);
  });

  test("key thresholds from the brief", () => {
    const body = theme.contrastLevel === "AAA" ? 7 : 4.5;
    const ratio = (fg: TokenPath, bg: TokenPath) =>
      contrastRatio(getToken(theme.tokens, fg), getToken(theme.tokens, bg));
    for (const bg of ["bg.base", "bg.surface", "bg.raised"] as const) {
      expect(ratio("fg.default", bg)).toBeGreaterThanOrEqual(body);
    }
    expect(ratio("fg.muted", "bg.base")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("fg.muted", "bg.surface")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("fg.subtle", "bg.base")).toBeGreaterThanOrEqual(3);
    expect(ratio("state.selectedFg", "state.selectedBg")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("syntax.comment", "editor.bg")).toBeGreaterThanOrEqual(3.5);
    expect(ratio("editor.lineNumber", "editor.bg")).toBeGreaterThanOrEqual(2.5);
  });

  test.each(ACCENT_NAMES.map((name) => [name]))("accent %s keeps every requirement", (name) => {
    const failures = auditContrast(withAccent(theme, name)).filter((r) => !r.pass);
    expect(failures.map((f) => `${f.fg} on ${f.bg}: ${f.ratio.toFixed(2)} < ${f.min}`)).toEqual([]);
  });
});

test("High Contrast is genuinely high contrast", () => {
  const hc = themes.find((t) => t.id === "high-contrast");
  expect(hc?.contrastLevel).toBe("AAA");
  if (!hc) return;
  const ratio = (fg: TokenPath, bg: TokenPath) =>
    contrastRatio(getToken(hc.tokens, fg), getToken(hc.tokens, bg));
  // Near-black canvas, white text, strong borders, no reliance on dim text.
  expect(ratio("bg.base", "bg.surface")).toBeLessThan(1.2);
  expect(getToken(hc.tokens, "fg.default")).toBe("#ffffff");
  expect(ratio("border.default", "bg.base")).toBeGreaterThanOrEqual(7);
  for (const fg of ["fg.muted", "fg.subtle", "syntax.comment", "editor.lineNumber", "git.ignored"] as const) {
    expect(ratio(fg, "bg.base")).toBeGreaterThanOrEqual(7);
  }
});

test("the policy covers every pair the brief names", () => {
  const has = (fg: TokenPath, bg: TokenPath) => CONTRAST_REQUIREMENTS.some((r) => r.fg === fg && r.bg === bg);
  expect(has("fg.default", "bg.raised")).toBe(true);
  expect(has("fg.subtle", "bg.surface")).toBe(true);
  expect(has("git.ignored", "bg.surface")).toBe(true);
  expect(has("diff.addedFg", "diff.addedLineBg")).toBe(true);
  expect(has("syntax.comment", "editor.bg")).toBe(true);
  expect(has("editor.lineNumber", "editor.bg")).toBe(true);
});
