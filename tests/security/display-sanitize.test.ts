/**
 * Item: display sanitizing.
 *
 * Single-line labels (`sanitizeForDisplay`): controls, bidi controls and invisible spoofing aids
 * are replaced; the zero-width joiner and non-joiner stay because real text needs them.
 * Code lines (`sanitizeLineForDisplay`): controls become visible stand-ins one for one, so UTF-16
 * offsets computed on the original line remain valid.
 */
import { describe, expect, test } from "bun:test";
import { lineDisplayOffset, sanitizeForDisplay, sanitizeLineForDisplay } from "@/core/text";

const R = "�";

describe("sanitizeForDisplay (single-line labels)", () => {
  test("zero-width space, word joiner and other invisible characters are replaced", () => {
    for (const char of ["​", "⁠", "⁡", "⁤", "­", "᠎", "⁪", "﻿", "￹"]) {
      expect(sanitizeForDisplay(`ad${char}min`)).toBe(`ad${R}min`);
    }
  });

  test("bidi controls, including the Arabic letter mark, are replaced", () => {
    for (const char of ["؜", "‎", "‏", "‪", "‮", "⁦", "⁩"]) {
      expect(sanitizeForDisplay(`a${char}b`)).toBe(`a${R}b`);
    }
  });

  test("line and paragraph separators cannot break a row", () => {
    expect(sanitizeForDisplay("a b c")).toBe(`a${R}b${R}c`);
  });

  test("the zero-width joiner and non-joiner are kept: emoji sequences and scripts need them", () => {
    const family = "👩‍💻";
    expect(sanitizeForDisplay(family)).toBe(family);
    const persian = "می‌خواهم";
    expect(sanitizeForDisplay(persian)).toBe(persian);
  });

  test("controls and tabs as before", () => {
    expect(sanitizeForDisplay("a\u001b[31mb\u0007\u009b")).toBe(`a${R}[31mb${R}${R}`);
    expect(sanitizeForDisplay("a\tb", 4)).toBe("a    b");
  });
});

describe("sanitizeLineForDisplay (code lines)", () => {
  test("C0 controls become control pictures, DEL and C1 visible stand-ins, one unit each", () => {
    const line = "x\u001b]0;title\u0007y\u0000\u007f\u0085\u009bz\r";
    const safe = sanitizeLineForDisplay(line);
    expect(safe).toBe("x␛]0;title␇y␀␡��z␍");
    expect(safe.length).toBe(line.length);
    // No byte that a terminal would interpret survives.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: checking for control characters.
    expect(/[\u0000-\u001f\u007f-\u009f]/.test(safe)).toBe(false);
  });

  test("offsets are preserved: a highlight range on the original line marks the same text", () => {
    const line = 'const s = "‮evil‬"; // ​note 👩‍💻 done';
    const safe = sanitizeLineForDisplay(line);
    expect(safe.length).toBe(line.length);
    const start = line.indexOf("note");
    expect(safe.slice(start, start + 4)).toBe("note");
    const done = line.indexOf("done");
    expect(safe.slice(done)).toBe("done");
    expect(safe).toContain("👩‍💻");
    expect(safe).not.toContain("‮");
    expect(safe).not.toContain("​");
  });

  test("tabs are kept by default (the renderer expands them) and expanded with tabWidth", () => {
    expect(sanitizeLineForDisplay("\tx")).toBe("\tx");
    expect(sanitizeLineForDisplay("a\tb\tc", { tabWidth: 4 })).toBe("a   b   c");
    expect(sanitizeLineForDisplay("ab\u001b\tc", { tabWidth: 4 })).toBe("ab␛ c");
    expect(lineDisplayOffset("a\tb\tc", 4, 4)).toBe(8);
    expect(lineDisplayOffset("a\tb", 2)).toBe(2);
  });

  test("plain ASCII is returned as is", () => {
    const line = "export const x = 1; // ok";
    expect(sanitizeLineForDisplay(line)).toBe(line);
  });
});
