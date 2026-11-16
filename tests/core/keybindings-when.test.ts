import { describe, expect, test } from "bun:test";
import { ContextKeys, contextFrom } from "@/core/keybindings/context-keys";
import { evaluateWhen, parseWhen, WhenParseError, whenKeys, whenOverlap } from "@/core/keybindings/when";

const evaluate = (source: string, values: Record<string, unknown>) =>
  evaluateWhen(parseWhen(source), (key) => values[key]);

describe("when language", () => {
  test.each([
    ["editorFocus", { editorFocus: true }, true],
    ["editorFocus", {}, false],
    ["!editorFocus", {}, true],
    ["!!editorFocus", { editorFocus: true }, true],
    ["a && b", { a: true, b: true }, true],
    ["a && b", { a: true }, false],
    ["a || b", { b: true }, true],
    ["a || b && c", { a: true }, true],
    ["(a || b) && c", { a: true }, false],
    ["!(a && b)", { a: true }, true],
    ["sidebarView == 'scm'", { sidebarView: "scm" }, true],
    ['sidebarView == "scm"', { sidebarView: "explorer" }, false],
    ["sidebarView != 'scm'", { sidebarView: "explorer" }, true],
    ["sidebarView != 'scm'", {}, true],
    ["!sidebarView == 'scm'", { sidebarView: "scm" }, false],
    ["count == '3'", { count: 3 }, true],
    ["flag == 'true'", { flag: true }, true],
    ["name == 'it\\'s'", { name: "it's" }, true],
    ["git.hasChanges && view-mode == 'x'", { "git.hasChanges": true, "view-mode": "x" }, true],
    ["true", {}, true],
    ["false || true", {}, true],
    ["emptyString", { emptyString: "" }, false],
    ["zero", { zero: 0 }, false],
    ["text", { text: "x" }, true],
    ["object", { object: {} }, false],
  ])("%s with %o is %s", (source, values, expected) => {
    expect(evaluate(source, values)).toBe(expected);
  });

  test("identifiers are only context lookups, never code", () => {
    expect(evaluate("constructor", {})).toBe(false);
    expect(evaluate("__proto__ || toString", {})).toBe(false);
  });

  test.each([
    ["", 0],
    ["a &&", 4],
    ["(a", 2],
    ["a)", 1],
    ["a == b", 5],
    ["a == 'x", 5],
    ["a & b", 2],
    ["a $ b", 2],
  ])("%j fails at position %d", (source, position) => {
    try {
      parseWhen(source);
      throw new Error("expected a parse error");
    } catch (error) {
      expect(error).toBeInstanceOf(WhenParseError);
      expect((error as WhenParseError).position).toBe(position);
    }
  });

  test("rejects absurdly long or deeply nested input", () => {
    expect(() => parseWhen(`${"a || ".repeat(300)}a`)).toThrow(WhenParseError);
    expect(() => parseWhen(`${"!".repeat(40)}a`)).toThrow(WhenParseError);
  });

  test("whenKeys lists keys and compared values", () => {
    const keys = whenKeys(parseWhen("a && (v == 'x' || v == 'y') && !b"));
    expect([...keys.keys()].sort()).toEqual(["a", "b", "v"]);
    expect([...(keys.get("v") ?? [])].sort()).toEqual(["x", "y"]);
  });

  test("whenOverlap decides whether two clauses can hold together", () => {
    const w = parseWhen;
    expect(whenOverlap(undefined, undefined)).toBe(true);
    expect(whenOverlap(w("editorFocus"), undefined)).toBe(true);
    expect(whenOverlap(w("editorFocus"), w("!editorFocus"))).toBe(false);
    expect(whenOverlap(w("v == 'scm'"), w("v == 'explorer'"))).toBe(false);
    expect(whenOverlap(w("v == 'scm'"), w("v != 'explorer'"))).toBe(true);
    expect(whenOverlap(w("a && b"), w("!a || c"))).toBe(true);
    expect(whenOverlap(w("a && !a"), undefined)).toBe(false);
  });
});

describe("ContextKeys", () => {
  test("set, get, delete and evaluate", () => {
    const context = new ContextKeys();
    context.set("sidebarView", "scm");
    expect(context.get("sidebarView")).toBe("scm");
    expect(context.evaluate("sidebarView == 'scm'")).toBe(true);
    expect(context.evaluate(undefined)).toBe(true);
    expect(context.evaluate("  ")).toBe(true);
    context.delete("sidebarView");
    expect(context.get("sidebarView")).toBeUndefined();
    expect(context.snapshot()).toEqual({});
  });

  test("emits only real changes, batched by setMany", () => {
    const context = new ContextKeys();
    const events: string[][] = [];
    context.onDidChange((e) => events.push(e.keys));
    context.set("a", true);
    context.set("a", true);
    context.setMany({ a: true, b: 1, c: undefined });
    context.delete("missing");
    context.delete("a");
    expect(events).toEqual([["a"], ["b"], ["a"]]);
    context.dispose();
  });

  test("invalid expressions throw a WhenParseError", () => {
    expect(() => new ContextKeys().evaluate("a &&")).toThrow(WhenParseError);
  });

  test("contextFrom wraps a plain object", () => {
    expect(contextFrom({ x: 1 }).get("x")).toBe(1);
  });
});
