import { describe, expect, test } from "bun:test";
import { iconForFile, resolveIconTier, UI_ICONS } from "@/themes/icons";
import { tokenPaths } from "@/themes/tokens";
import { isEastAsianAmbiguous } from "./east-asian-ambiguous";

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

describe("unicode and ascii tiers", () => {
  for (const tier of ["unicode", "ascii"] as const) {
    test.each(Object.entries(UI_ICONS[tier]))(`${tier} %s is exactly one cell`, (_name, glyph) => {
      expect(Bun.stringWidth(glyph)).toBe(1);
      expect([...glyph]).toHaveLength(1);
      const codePoint = glyph.codePointAt(0) ?? 0;
      expect(codePoint).toBeLessThanOrEqual(0xffff);
      expect(isEastAsianAmbiguous(codePoint)).toBe(false);
      expect(PICTOGRAPHIC.test(glyph)).toBe(false);
    });
  }

  test("ascii glyphs are printable ASCII", () => {
    for (const glyph of Object.values(UI_ICONS.ascii)) expect(glyph).toMatch(/^[\x21-\x7e]$/);
  });

  test("the ambiguous-width fixture catches the classic offenders", () => {
    for (const char of ["●", "•", "→", "↑", "▶", "■", "…", "·"]) {
      expect(isEastAsianAmbiguous(char.codePointAt(0) ?? 0)).toBe(true);
    }
  });
});

describe("nerd tier", () => {
  test.each(Object.entries(UI_ICONS.nerd))("%s is one BMP Private Use Area codepoint", (_name, glyph) => {
    const codePoint = glyph.codePointAt(0) ?? 0;
    expect([...glyph]).toHaveLength(1);
    expect(codePoint >= 0xe000 && codePoint <= 0xf8ff).toBe(true);
    expect(Bun.stringWidth(glyph)).toBe(1);
  });

  test("every tier defines the same icon names", () => {
    const names = Object.keys(UI_ICONS.nerd).sort();
    expect(Object.keys(UI_ICONS.unicode).sort()).toEqual(names);
    expect(Object.keys(UI_ICONS.ascii).sort()).toEqual(names);
  });
});

describe("iconForFile", () => {
  const tokens = new Set<string>(tokenPaths());

  test.each([
    ["main.ts", "", "terminal.blue"],
    ["view.TSX", "", "terminal.blue"],
    ["index.js", "", "terminal.yellow"],
    ["package.json", String.fromCodePoint(0xeb0f), "terminal.yellow"],
    ["README.md", "", "terminal.cyan"],
    ["app.py", "", "terminal.yellow"],
    ["main.go", "", "terminal.cyan"],
    ["go.mod", "", "terminal.cyan"],
    ["build.sh", "", "terminal.green"],
    [".zshrc", "", "terminal.green"],
    ["ci.yml", "", "terminal.magenta"],
    ["config.toml", "", "terminal.magenta"],
    ["index.html", "", "terminal.red"],
    ["site.css", "", "terminal.blue"],
    ["logo.PNG", "", "terminal.magenta"],
    ["bun.lock", "", "fg.subtle"],
    ["Cargo.lock", "", "fg.subtle"],
    ["package-lock.json", "", "fg.subtle"],
    [".gitignore", "", "terminal.red"],
    ["LICENSE", "", "fg.muted"],
    [".env", "", "fg.muted"],
    ["archive.", "", "fg.muted"],
  ] as const)("%s", (name, glyph, color) => {
    const result = iconForFile(name, "file", "nerd");
    expect(result.glyph).toBe(glyph);
    expect(result.color).toBe(color);
    expect(tokens.has(result.color)).toBe(true);
  });

  test("folders and lower tiers", () => {
    expect(iconForFile("src", "directory", "nerd").glyph).toBe(UI_ICONS.nerd.folder);
    expect(iconForFile("src", "directory-open", "nerd").glyph).toBe(UI_ICONS.nerd.folderOpen);
    expect(iconForFile("main.ts", "file", "unicode")).toEqual({
      glyph: UI_ICONS.unicode.file,
      color: "terminal.blue",
    });
    expect(iconForFile("src", "directory", "ascii").glyph).toBe("+");
  });
});

describe("resolveIconTier", () => {
  test("explicit settings win", () => {
    expect(resolveIconTier("nerd", { TERM: "linux" })).toBe("nerd");
  });

  test("auto never guesses a Nerd Font", () => {
    expect(resolveIconTier("auto", { TERM: "xterm-256color", LANG: "en_US.UTF-8" })).toBe("unicode");
    expect(resolveIconTier("auto", {})).toBe("unicode");
  });

  test("auto falls back to ascii on the Linux console and non-UTF-8 locales", () => {
    expect(resolveIconTier("auto", { TERM: "linux" })).toBe("ascii");
    expect(resolveIconTier("auto", { LANG: "C" })).toBe("ascii");
    expect(resolveIconTier("auto", { LC_ALL: "tr_TR.ISO8859-9", LANG: "tr_TR.UTF-8" })).toBe("ascii");
    expect(resolveIconTier("auto", { LC_CTYPE: "tr_TR.utf8" })).toBe("unicode");
  });
});
