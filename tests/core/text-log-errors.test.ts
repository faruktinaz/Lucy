import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, fromFsError, isLucyError, LucyError } from "@/core/errors";
import { configureLogger, flushLogs, log, redact } from "@/core/log";
import {
  displayWidth,
  padEndWidth,
  plural,
  sanitizeForDisplay,
  truncateEnd,
  truncateMiddle,
  truncateStart,
} from "@/core/text";
import { makeTempDirs, type TempDirs } from "./helpers";

describe("sanitizeForDisplay", () => {
  test("leaves plain ASCII and normal Unicode untouched", () => {
    expect(sanitizeForDisplay("src/main.ts")).toBe("src/main.ts");
    expect(sanitizeForDisplay("Türkçe dosya adı.md")).toBe("Türkçe dosya adı.md");
    expect(sanitizeForDisplay("👨‍👩‍👧 family")).toBe("👨‍👩‍👧 family");
  });

  test("tabs become spaces; control and bidi-override characters are replaced", () => {
    expect(sanitizeForDisplay("a\tb", 4)).toBe("a    b");
    expect(sanitizeForDisplay("bell\u0007\u001b[31mred")).toBe("bell��[31mred");
    expect(sanitizeForDisplay("invoice‮txt.exe")).toBe("invoice�txt.exe");
    expect(sanitizeForDisplay("a⁦b⁩c﻿")).toBe("a�b�c�");
    expect(sanitizeForDisplay("line\nbreak\r")).toBe("line�break�");
    expect(sanitizeForDisplay("c1\u0085")).toBe("c1�");
  });
});

describe("displayWidth", () => {
  test("counts terminal cells", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("漢字")).toBe(4);
    expect(displayWidth("é")).toBe(1);
    expect(displayWidth("é")).toBe(1);
    expect(displayWidth("👍")).toBe(2);
    expect(displayWidth("👨‍👩‍👧")).toBe(2);
    expect(displayWidth("🇹🇷")).toBe(2);
    expect(displayWidth("")).toBe(0);
  });
});

describe("truncation", () => {
  test("no-ops and degenerate widths", () => {
    expect(truncateEnd("short", 10)).toBe("short");
    expect(truncateEnd("anything", 0)).toBe("");
    expect(truncateStart("anything", -1)).toBe("");
    expect(truncateMiddle("anything", 1)).toBe("…");
  });

  test("ASCII", () => {
    expect(truncateEnd("a-very-long-name", 8)).toBe("a-very-…");
    expect(truncateStart("components/button.tsx", 12)).toBe("…/button.tsx");
    expect(truncateMiddle("src/features/index.ts", 13)).toBe("src/fe…dex.ts");
  });

  test("wide characters never overflow the width", () => {
    const text = "漢字漢字漢字";
    for (let width = 1; width <= 12; width++) {
      expect(displayWidth(truncateEnd(text, width))).toBeLessThanOrEqual(width);
      expect(displayWidth(truncateStart(text, width))).toBeLessThanOrEqual(width);
      expect(displayWidth(truncateMiddle(text, width))).toBeLessThanOrEqual(width);
    }
    expect(truncateEnd(text, 6)).toBe("漢字…");
    expect(truncateStart(text, 6)).toBe("…漢字");
  });

  test("emoji and ZWJ sequences are never split", () => {
    const text = "ab👨‍👩‍👧cd👍ef";
    expect(truncateEnd(text, 5)).toBe("ab👨‍👩‍👧…");
    expect(truncateEnd(text, 4)).toBe("ab…");
    expect(truncateStart(text, 6)).toBe("…d👍ef");
  });

  test("combining marks stay attached to their base", () => {
    const text = "café au lait";
    expect(truncateEnd(text, 5)).toBe("café…");
  });

  test("truncateStart keeps grapheme order (flags and Hangul jamo)", () => {
    // Regression: re-segmenting reversed text paired the wrong regional indicators
    // (🇹🇷 + 🇺 turned into 🇷🇺 + 🇹) and merged separate Hangul clusters.
    expect(truncateStart("abcdef🇹🇷🇺", 4)).toBe("…🇹🇷🇺");
    expect(truncateStart("xxxxxx가ᄀ", 5)).toBe("…가ᄀ");
    expect(truncateMiddle("a🇹🇷🇺bcdefgh🇹🇷🇺", 7)).toBe("a🇹🇷…🇹🇷🇺");
  });

  test("padEndWidth pads by cells and never truncates", () => {
    expect(padEndWidth("漢", 4)).toBe("漢  ");
    expect(padEndWidth("long", 2)).toBe("long");
  });

  test("plural", () => {
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(0, "file")).toBe("0 files");
    expect(plural(2, "match", "matches")).toBe("2 matches");
  });
});

describe("redact", () => {
  test("masks secret-looking keys at any depth", () => {
    expect(
      redact({
        user: "lucy",
        token: "abc",
        nested: { apiKey: "x", api_key: "y", Authorization: "Bearer z" },
      }),
    ).toEqual({
      user: "lucy",
      token: "[redacted]",
      nested: { apiKey: "[redacted]", api_key: "[redacted]", Authorization: "[redacted]" },
    });
  });

  test("masks secret-looking values in strings, arrays and errors", () => {
    const anthropic = `sk-ant-${"a".repeat(24)}`;
    const github = `ghp_${"b".repeat(30)}`;
    expect(redact(`key ${anthropic} end`)).toBe("key [redacted] end");
    expect(redact([github, "plain"])).toEqual(["[redacted]", "plain"]);
    const error = redact(new Error(`failed with AKIAABCDEFGHIJKLMNOP`)) as { message: string; name: string };
    expect(error.name).toBe("Error");
    expect(error.message).toBe("failed with [redacted]");
  });

  test("limits depth and passes primitives through", () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 10; i++) deep = { child: deep };
    expect(JSON.stringify(redact(deep))).toContain("[truncated]");
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
  });
});

describe("logger", () => {
  let temp: TempDirs;
  beforeEach(async () => {
    temp = await makeTempDirs();
  });
  afterEach(async () => {
    await flushLogs();
    configureLogger({});
    await temp.cleanup();
  });

  test("is a no-op until configured", () => {
    expect(() => log.info("nothing happens")).not.toThrow();
  });

  test("filters by level and scopes child loggers", () => {
    const lines: string[] = [];
    configureLogger({ sink: (line) => lines.push(line), level: "warn" });
    const git = log.child("git").child("status");
    git.debug("hidden");
    git.info("hidden");
    git.warn("shown", { count: 2 });
    git.error("also shown");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.* WARN {2}\[git:status\] shown \{"count":2\}$/);
    expect(lines[1]).toContain("ERROR [git:status] also shown");
  });

  test("redacts messages and data before writing", () => {
    const lines: string[] = [];
    configureLogger({ sink: (line) => lines.push(line) });
    log.info(`token ghp_${"c".repeat(30)}`, { password: "hunter2", ok: true });
    expect(lines[0]).toContain("token [redacted]");
    expect(lines[0]).toContain('"password":"[redacted]"');
    expect(lines[0]).not.toContain("hunter2");
  });

  test("survives unserializable data", () => {
    const lines: string[] = [];
    configureLogger({ sink: (line) => lines.push(line) });
    log.info("cyclic", { big: 10n });
    expect(lines[0]).toContain("[unserializable]");
  });

  test("writes to a file, creating its directory", async () => {
    const file = join(temp.root, "logs", "nested", "lucy.log");
    configureLogger({ file, level: "debug" });
    log.child("test").debug("first");
    log.child("test").info("second");
    await flushLogs();
    const content = await readFile(file, "utf8");
    expect(content.trim().split("\n")).toHaveLength(2);
    expect(content).toContain("DEBUG [test] first");
    expect(content).toContain("INFO  [test] second");
  });
});

describe("errors", () => {
  test("LucyError carries a stable code, details and cause", () => {
    const cause = new Error("root");
    const error = new LucyError("TIMEOUT", "Took too long", { cause, details: { ms: 5 } });
    expect(error.name).toBe("LucyError");
    expect(error.code).toBe("TIMEOUT");
    expect(error.details).toEqual({ ms: 5 });
    expect(error.cause).toBe(cause);
    expect(isLucyError(error)).toBe(true);
    expect(isLucyError(error, "TIMEOUT")).toBe(true);
    expect(isLucyError(error, "NOT_FOUND")).toBe(false);
    expect(isLucyError(new Error("x"))).toBe(false);
  });

  test("errorMessage handles any thrown value", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("text")).toBe("text");
    expect(errorMessage({ weird: true })).toBe("Unknown error");
  });

  test.each([
    ["ENOENT", "NOT_FOUND"],
    ["ENOTDIR", "NOT_FOUND"],
    ["EEXIST", "ALREADY_EXISTS"],
    ["ENOTEMPTY", "ALREADY_EXISTS"],
    ["EACCES", "PERMISSION_DENIED"],
    ["EPERM", "PERMISSION_DENIED"],
    ["EROFS", "PERMISSION_DENIED"],
    ["EIO", "IO_ERROR"],
  ] as const)("fromFsError maps %s to %s", (code, expected) => {
    const original = Object.assign(new Error("fs"), { code });
    const mapped = fromFsError(original, "/some/path");
    expect(mapped.code).toBe(expected);
    expect(mapped.cause).toBe(original);
    expect(mapped.message).toContain("/some/path");
  });
});
