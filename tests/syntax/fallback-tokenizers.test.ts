import { describe, expect, test } from "bun:test";
import { fallbackTokenizerFor, type HighlightRange, tokenizeLines } from "../../src/adapters/syntax";
import { probe } from "./helpers";

function run(filetype: string, content: string) {
  const tokenizer = fallbackTokenizerFor(filetype);
  if (!tokenizer) throw new Error(`no tokenizer for ${filetype}`);
  const ranges: HighlightRange[] = tokenizer.tokenize(content);
  return { ranges, lines: tokenizeLines(content, ranges) };
}

describe("JSON tokenizer", () => {
  const content = `{
  // comment
  "name": "lucy",   /* block */
  "n": -1.5e3,
  "ok": true,
  "none": null,
  "esc": "a\\n\\u00e9b",
  "arr": ["x", 2, false],
  "nested" : { "k": 1 },
}`;
  const { lines } = run("json", content);

  test("keys, strings, numbers, literals, comments and escapes", () => {
    expect(probe(content, lines, '"name"')).toMatchObject({ group: "property", text: '"name"' });
    expect(probe(content, lines, '"lucy"')).toMatchObject({ group: "string", text: '"lucy"' });
    expect(probe(content, lines, "-1.5e3")).toMatchObject({ group: "number", text: "-1.5e3" });
    expect(probe(content, lines, "true")).toMatchObject({ token: "constant" });
    expect(probe(content, lines, "null")).toMatchObject({ token: "constant" });
    expect(probe(content, lines, "// comment")).toMatchObject({ group: "comment", text: "// comment" });
    expect(probe(content, lines, "/* block */")).toMatchObject({ group: "comment" });
    // Adjacent escapes merge into one token of the same group.
    expect(probe(content, lines, "\\n")).toMatchObject({ group: "string.escape", text: "\\n\\u00e9" });
    expect(probe(content, lines, 'b",')).toMatchObject({ group: "string" });
    expect(probe(content, lines, '"x"')).toMatchObject({ group: "string" });
    expect(probe(content, lines, '"nested"')).toMatchObject({ group: "property" });
    expect(probe(content, lines, "{ ")).toMatchObject({ token: "punctuation" });
  });

  test("JSON5 unquoted keys and single quotes; jsonc and json5 resolve to the same tokenizer", () => {
    const json5 = "{ key: 'v', hex: 0x1F, inf: Infinity }";
    const { lines: l5 } = run("json5", json5);
    expect(probe(json5, l5, "key")).toMatchObject({ group: "property" });
    expect(probe(json5, l5, "'v'")).toMatchObject({ group: "string" });
    expect(probe(json5, l5, "0x1F")).toMatchObject({ group: "number", text: "0x1F" });
    expect(probe(json5, l5, "Infinity")).toMatchObject({ group: "number" });
    expect(fallbackTokenizerFor("jsonc")).toBe(fallbackTokenizerFor("json"));
  });

  test("an unterminated string stops at the end of its line", () => {
    const broken = '{"a": "oops\n"b": 1}';
    const { lines: lb } = run("json", broken);
    expect(probe(broken, lb, '"b"')).toMatchObject({ group: "property" });
  });
});

describe("INI tokenizer", () => {
  const content = "; comment\n[core]\n  editor = vim # inline\n  autocrlf=false\nport: 8080\n# full line\n";
  const { lines } = run("ini", content);

  test("sections, keys, values and comments", () => {
    expect(probe(content, lines, "core")).toMatchObject({ token: "type", text: "core" });
    expect(probe(content, lines, "editor")).toMatchObject({ group: "property", text: "editor" });
    expect(probe(content, lines, "vim")).toMatchObject({ group: "string", text: "vim" });
    expect(probe(content, lines, "# inline")).toMatchObject({ group: "comment" });
    expect(probe(content, lines, "false")).toMatchObject({ token: "constant" });
    expect(probe(content, lines, "8080")).toMatchObject({ group: "number" });
    expect(probe(content, lines, "; comment")).toMatchObject({ group: "comment" });
    expect(probe(content, lines, "# full")).toMatchObject({ group: "comment" });
  });
});

describe("ignore-file tokenizer", () => {
  const content = "# deps\nnode_modules/\n!keep.log\n*.log\nfile[0-9].txt\n\\#literal\n*.png binary -diff\n";
  const { lines } = run("gitignore", content);

  test("comments, negation, globs, escapes and gitattributes attributes", () => {
    expect(probe(content, lines, "# deps")).toMatchObject({ group: "comment" });
    expect(probe(content, lines, "!keep")).toMatchObject({ group: "operator", text: "!" });
    expect(probe(content, lines, "*.log")).toMatchObject({ group: "operator", text: "*" });
    expect(probe(content, lines, "[0-9]")).toMatchObject({ token: "regexp", text: "[0-9]" });
    expect(probe(content, lines, "\\#")).toMatchObject({ token: "regexp", text: "\\#" });
    expect(probe(content, lines, "binary")).toMatchObject({ group: "attribute", text: "binary" });
    expect(probe(content, lines, "node_modules")).toMatchObject({ group: null });
  });
});
