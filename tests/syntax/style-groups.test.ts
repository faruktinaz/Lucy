import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORE_SYNTAX_TOKENS,
  EXTENDED_SYNTAX_TOKENS,
  FALLBACK_TOKENIZERS,
  STYLE_GROUPS,
  SYNTAX_TOKEN_FALLBACKS,
  SYNTAX_TOKENS,
  syntaxGroupToToken,
} from "../../src/adapters/syntax";

const OUR_QUERIES = fileURLToPath(new URL("../../src/adapters/syntax/queries/", import.meta.url));
const OPENTUI_ASSETS = join(
  dirname(fileURLToPath(import.meta.resolve("@opentui/core/package.json"))),
  "assets",
);

function captureNames(file: string): string[] {
  // Drop string literals ("@media") and `;` comments so only real captures are counted.
  const code = readFileSync(file, "utf8")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .split("\n")
    .map((line) => line.replace(/;.*$/, ""))
    .join("\n");
  return [...new Set([...code.matchAll(/@([A-Za-z_][\w.-]*)/g)].map((m) => m[1] ?? ""))].filter(
    (name) => !name.startsWith("_"),
  );
}

/** OpenTUI's own rule: exact registered name, else the first segment, else unstyled. */
function openTuiResolution(group: string): string | null {
  if (STYLE_GROUPS.includes(group)) return syntaxGroupToToken(group);
  const first = group.split(".")[0] ?? "";
  return STYLE_GROUPS.includes(first) ? syntaxGroupToToken(first) : null;
}

const INTENTIONALLY_UNSTYLED = new Set([
  "spell",
  "nospell",
  "none",
  "conceal",
  "embedded",
  "cImport",
  "import",
]);

describe("style groups", () => {
  test("the token list is the fifteen core tokens plus extended roles", () => {
    expect(CORE_SYNTAX_TOKENS).toEqual([
      "keyword",
      "string",
      "number",
      "comment",
      "function",
      "type",
      "variable",
      "constant",
      "property",
      "operator",
      "punctuation",
      "tag",
      "attribute",
      "heading",
      "link",
    ]);
    expect([...SYNTAX_TOKENS]).toEqual([...CORE_SYNTAX_TOKENS, ...EXTENDED_SYNTAX_TOKENS]);
    for (const token of EXTENDED_SYNTAX_TOKENS) expect(token in SYNTAX_TOKEN_FALLBACKS).toBe(true);
  });

  test("every registered group maps to a token, and every token is reachable", () => {
    const reached = new Set<string>();
    for (const group of STYLE_GROUPS) {
      const token = syntaxGroupToToken(group);
      expect(token).not.toBeNull();
      if (token) reached.add(token);
    }
    expect([...reached].sort()).toEqual([...SYNTAX_TOKENS].sort());
  });

  test("mapping examples, including first-segment fallback", () => {
    const cases: [string, string | null][] = [
      ["keyword.return", "keyword"],
      ["keyword.conditional.ternary", "keyword"],
      ["function.method.call", "function"],
      ["string.special.url", "link"],
      ["string.escape", "regexp"],
      ["variable.parameter", "parameter"],
      ["variable.member", "property"],
      ["variable.builtin", "variable"],
      ["constructor", "type"],
      ["boolean", "constant"],
      ["constant.builtin", "constant"],
      ["markup.heading.3", "heading"],
      ["markup.raw.block", "code"],
      ["markup.list.checked", "list"],
      ["tag.attribute", "attribute"],
      ["markup", null],
      ["markup.unknown", null],
      ["spell", null],
      ["toString", null],
      ["__proto__", null],
      ["", null],
    ];
    for (const [group, token] of cases)
      expect(`${group} → ${syntaxGroupToToken(group)}`).toBe(`${group} → ${token}`);
  });

  test("every capture in our queries is styled, and resolves exactly like OpenTUI", () => {
    const files = readdirSync(OUR_QUERIES).filter((name) => name.endsWith(".scm"));
    expect(files.length).toBe(8);
    for (const file of files) {
      for (const group of captureNames(join(OUR_QUERIES, file))) {
        expect(`${file}:${group} → ${syntaxGroupToToken(group) !== null}`).toBe(`${file}:${group} → true`);
        expect(openTuiResolution(group)).toBe(syntaxGroupToToken(group));
      }
    }
  });

  test("OpenTUI's bundled queries resolve exactly like OpenTUI; only noise groups are unstyled", () => {
    for (const dir of readdirSync(OPENTUI_ASSETS)) {
      for (const group of captureNames(join(OPENTUI_ASSETS, dir, "highlights.scm"))) {
        expect(openTuiResolution(group)).toBe(syntaxGroupToToken(group));
        if (syntaxGroupToToken(group) === null)
          expect(`${dir}:${group}`).toBe(
            `${dir}:${[...INTENTIONALLY_UNSTYLED].find((g) => g === group) ?? "?"}`,
          );
      }
    }
  });

  test("every group a fallback tokenizer emits is styled", () => {
    const sample = '{"k": "v\\n", "n": 1, "b": true, "z": null} // c\n[s]\nk = v ; c\n!x*[a]\\# y';
    for (const tokenizer of FALLBACK_TOKENIZERS) {
      for (const range of tokenizer.tokenize(sample)) expect(syntaxGroupToToken(range.group)).not.toBeNull();
    }
  });
});
