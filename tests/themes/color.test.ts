import { describe, expect, test } from "bun:test";
import {
  ANSI_16,
  bestContrast,
  blend,
  chroma,
  contrastRatio,
  ensureContrast,
  hexToRgb,
  isHexColor,
  nearestAnsi16,
  nearestXterm256,
  normalizeHex,
  relativeLuminance,
  rgbToHex,
  XTERM_256,
} from "@/themes/color";

describe("hex and rgb conversion", () => {
  test("parses long and short forms, with or without #", () => {
    expect(hexToRgb("#89b4fa")).toEqual({ r: 0x89, g: 0xb4, b: 0xfa });
    expect(hexToRgb("89B4FA")).toEqual({ r: 0x89, g: 0xb4, b: 0xfa });
    expect(hexToRgb("#fff")).toEqual({ r: 255, g: 255, b: 255 });
  });

  test("rejects malformed input", () => {
    for (const bad of ["", "#12345", "#gggggg", "rgb(0,0,0)", "#1234567"]) {
      expect(() => hexToRgb(bad)).toThrow();
    }
  });

  test("formats lowercase, clamps and rounds channels", () => {
    expect(rgbToHex({ r: 255, g: 0, b: 16 })).toBe("#ff0010");
    expect(rgbToHex({ r: 300, g: -5, b: 127.6 })).toBe("#ff0080");
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
  });

  test("isHexColor accepts only #rrggbb", () => {
    expect(isHexColor("#a1b2c3")).toBe(true);
    expect(isHexColor("#abc")).toBe(false);
    expect(isHexColor("a1b2c3")).toBe(false);
  });
});

describe("blend", () => {
  test("alpha 0 and 1 return the endpoints", () => {
    expect(blend("#ff0000", "#000000", 0)).toBe("#000000");
    expect(blend("#ff0000", "#000000", 1)).toBe("#ff0000");
  });

  test("composites in sRGB space and clamps alpha", () => {
    expect(blend("#ffffff", "#000000", 0.5)).toBe("#808080");
    expect(blend("#ffffff", "#000000", 2)).toBe("#ffffff");
    expect(blend("#ffffff", "#000000", -1)).toBe("#000000");
  });
});

describe("WCAG luminance and contrast", () => {
  test("luminance endpoints", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 10);
  });

  test("contrast matches known reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
    // #767676 is the classic lightest grey that passes 4.5:1 on white.
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
  });

  test("is symmetric", () => {
    expect(contrastRatio("#89b4fa", "#1e1e2e")).toBe(contrastRatio("#1e1e2e", "#89b4fa"));
  });

  test("ensureContrast reaches the target and leaves passing colors alone", () => {
    expect(ensureContrast("#cdd6f4", "#1e1e2e", 4.5)).toBe("#cdd6f4");
    const lifted = ensureContrast("#303030", "#1e1e2e", 3);
    expect(contrastRatio(lifted, "#1e1e2e")).toBeGreaterThanOrEqual(3);
    const darkened = ensureContrast("#eeeeee", "#ffffff", 4.5);
    expect(contrastRatio(darkened, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  test("bestContrast picks the strongest candidate", () => {
    expect(bestContrast("#1e1e2e", ["#313244", "#cdd6f4", "#45475a"])).toBe("#cdd6f4");
  });
});

describe("palette mapping", () => {
  test("xterm-256 table has the standard cube and grey ramp", () => {
    expect(XTERM_256).toHaveLength(256);
    expect(XTERM_256[16]).toBe("#000000");
    expect(XTERM_256[196]).toBe("#ff0000");
    expect(XTERM_256[231]).toBe("#ffffff");
    expect(XTERM_256[232]).toBe("#080808");
    expect(XTERM_256[255]).toBe("#eeeeee");
  });

  test("nearestXterm256 is exact for cube colors and never picks 0-15", () => {
    expect(nearestXterm256("#ff0000")).toBe(196);
    expect(nearestXterm256("#5f87af")).toBe(67);
    for (const hex of ["#000000", "#ffffff", "#1e1e2e", "#cdd6f4", "#f38ba8"]) {
      expect(nearestXterm256(hex)).toBeGreaterThanOrEqual(16);
    }
  });

  test("nearestXterm256 honors exclusions", () => {
    expect(nearestXterm256("#ff0000", new Set([196]))).not.toBe(196);
  });

  test("nearestAnsi16 keeps the hue family of colorful inputs", () => {
    expect([4, 12]).toContain(nearestAnsi16("#89b4fa"));
    expect([1, 9]).toContain(nearestAnsi16("#f38ba8"));
    expect([2, 10]).toContain(nearestAnsi16("#a6e3a1"));
    expect([3, 11]).toContain(nearestAnsi16("#f9e2af"));
    expect([5, 13]).toContain(nearestAnsi16("#cba6f7"));
    expect([6, 14]).toContain(nearestAnsi16("#94e2d5"));
  });

  test("bright vs normal variant follows lightness", () => {
    expect(nearestAnsi16("#ff5555")).toBe(9);
    expect(nearestAnsi16("#8b0000")).toBe(1);
  });

  test("greys map to the grey ramp by lightness", () => {
    expect(nearestAnsi16("#000000")).toBe(0);
    expect(nearestAnsi16("#1e1e2e")).toBe(0);
    expect(nearestAnsi16("#808080")).toBe(8);
    expect(nearestAnsi16("#ffffff")).toBe(15);
  });

  test("role overrides: neutral forces greys, hue rescues desaturated colors", () => {
    // Tokyo Night's text is slightly blue; as text it must stay grey.
    expect(chroma("#c0caf5")).toBeGreaterThan(0.06);
    expect([7, 15]).toContain(nearestAnsi16("#c0caf5", { role: "neutral" }));
    // Gruvbox's blue is nearly grey; as an accent it must keep a hue.
    expect([0, 7, 8, 15]).toContain(nearestAnsi16("#83a598"));
    expect([0, 7, 8, 15]).not.toContain(nearestAnsi16("#83a598", { role: "hue" }));
  });

  test("exclusions fall back to the next family or grey", () => {
    const first = nearestAnsi16("#89b4fa");
    const second = nearestAnsi16("#89b4fa", { exclude: new Set([4, 12]) });
    expect(second).not.toBe(first);
    expect([4, 12]).not.toContain(second);
  });

  test("ANSI_16 nominal table has 16 entries", () => {
    expect(ANSI_16).toHaveLength(16);
    expect(ANSI_16.every(isHexColor)).toBe(true);
  });
});
