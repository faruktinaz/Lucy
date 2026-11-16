import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  assertLocalSource,
  LucyTreeSitterClient,
  SyntaxService,
  type SyntaxTokenName,
  tokenizeLines,
} from "../../src/adapters/syntax";
import { isLucyError } from "../../src/core/errors";
import { listTree, makeTempDir, probe, removeTempDirs } from "./helpers";

const root = makeTempDir("service");
const cacheDir = join(root, "cache");
let service: SyntaxService;
const workerLogs: string[] = [];
let fetchCalls = 0;
const realFetch = globalThis.fetch;

beforeAll(() => {
  // Any main-thread network access fails loudly and is counted.
  globalThis.fetch = ((..._args: unknown[]) => {
    fetchCalls++;
    throw new Error("network access is not allowed in syntax tests");
  }) as unknown as typeof fetch;
  service = new SyntaxService({ dataPath: cacheDir });
});

afterAll(async () => {
  await service.disposeAsync();
  globalThis.fetch = realFetch;
  removeTempDirs();
});

async function expectCancelled(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(isLucyError(error, "CANCELLED")).toBe(true);
    return;
  }
  throw new Error("expected the promise to reject with CANCELLED");
}

describe("lazy start and data directory", () => {
  test("nothing starts and nothing is written before first use", async () => {
    expect(service.isStarted).toBe(false);
    expect(existsSync(cacheDir)).toBe(false);
    service.client.on("worker:log", (type, message) => workerLogs.push(`${type}: ${message}`));
    expect(service.isStarted).toBe(true);
    const ranges = await service.highlight("const a = 1", "typescript");
    expect(ranges.length).toBeGreaterThan(0);
    expect(listTree(cacheDir)).toEqual(["tree-sitter/", "tree-sitter/languages/", "tree-sitter/queries/"]);
  });
});

interface LanguageCase {
  readonly language: string;
  readonly content: string;
  /** [needle, expected token, occurrence index] */
  readonly expect: readonly (readonly [string, SyntaxTokenName, number?])[];
}

const CASES: readonly LanguageCase[] = [
  {
    language: "typescript",
    content: `// comment
export function add(a: number, b = 2): number {
  const s = "str";
  return a + 42;
}
`,
    expect: [
      ["// comment", "comment"],
      ["export", "keyword"],
      ["function", "keyword"],
      ["add", "function"],
      ["number", "type"],
      ['"str"', "string"],
      ["42", "number"],
      ["return", "keyword"],
    ],
  },
  {
    language: "tsx",
    content: `export const App = () => <div className="x">{name}</div>;\n`,
    expect: [
      ["const", "keyword"],
      ["div", "tag"],
      ["className", "attribute"],
      ['"x"', "string"],
    ],
  },
  {
    language: "javascript",
    content: `function f(x) { return "s" + 1; } // c\n`,
    expect: [
      ["function", "keyword"],
      ["f(", "function"],
      ['"s"', "string"],
      ["1;", "number"],
      ["// c", "comment"],
    ],
  },
  {
    language: "jsx",
    content: `const el = <Button label="hi" />;\n`,
    expect: [
      ["const", "keyword"],
      ['"hi"', "string"],
    ],
  },
  {
    language: "markdown",
    content:
      "# Title\n\nSome **bold** and *it* and `code` and [link](https://x.dev).\n\n- item\n\n```python\ndef f(): pass\n```\n",
    expect: [
      ["Title", "heading"],
      ["bold", "strong"],
      ["it*", "emphasis"],
      ["code", "code"],
      ["link", "link"],
      ["- item", "list"],
      ["def", "keyword"],
    ],
  },
  {
    language: "json",
    content: `{\n  "name": "lucy",\n  "count": 3,\n  "ok": true,\n  "none": null\n}\n`,
    expect: [
      ['"name"', "property"],
      ['"lucy"', "string"],
      ["3", "number"],
      ["true", "constant"],
      ["null", "constant"],
      ["{", "punctuation"],
    ],
  },
  {
    language: "jsonc",
    content: `{\n  // comment\n  "compilerOptions": { "strict": true, },\n}\n`,
    expect: [
      ["// comment", "comment"],
      ['"compilerOptions"', "property"],
      ['"strict"', "property"],
    ],
  },
  {
    language: "yaml",
    content: `# config\nname: lucy\nversion: 1.2\nenabled: true\npaths:\n  - "src"\n  - docs  # inline\n`,
    expect: [
      ["# config", "comment"],
      ["name", "property"],
      ["lucy", "string"],
      ["1.2", "number"],
      ["true", "constant"],
      ["paths", "property"],
      ['"src"', "string"],
      ["docs", "string"],
      ["# inline", "comment"],
    ],
  },
  {
    language: "toml",
    content: `# settings\ntitle = "Lucy"\n[server]\nport = 8080\ndebug = false\n[[plugins]]\nname = 'x'\n`,
    expect: [
      ["# settings", "comment"],
      ["title", "property"],
      ['"Lucy"', "string"],
      ["server", "type"],
      ["port", "property"],
      ["8080", "number"],
      ["false", "constant"],
      ["plugins", "type"],
      ["'x'", "string"],
    ],
  },
  {
    language: "python",
    content: `import os

@dataclass
class Point(Base):
    def norm(self, scale: float = 1.0) -> float:
        """Doc."""
        if scale and not self.x:
            return 0  # zero
        print(f"x={self.x}")
        return MAX_VALUE
`,
    expect: [
      ["import", "keyword"],
      ["os", "type"],
      ["@", "attribute"],
      ["dataclass", "attribute"],
      ["class Point", "keyword"],
      ["Point", "type"],
      ["def", "keyword"],
      ["norm", "function"],
      ["self", "variable"],
      ["scale", "parameter"],
      ["float", "type"],
      ["1.0", "number"],
      ['"""Doc."""', "string"],
      ["and", "keyword"],
      ["# zero", "comment"],
      ["print", "function"],
      ["{", "punctuation", 0],
      ["MAX_VALUE", "constant"],
    ],
  },
  {
    language: "go",
    content: `package main

import "fmt"

// Greet says hi.
func Greet(name string) (int, error) {
\tmsg := "hello, " + name
\tfmt.Println(msg, 'x', 3.14)
\treturn 0, nil
}
`,
    expect: [
      ["package", "keyword"],
      ['"fmt"', "string"],
      ["// Greet", "comment"],
      ["func", "keyword"],
      ["Greet", "function", 1],
      ["name", "parameter"],
      ["string", "type"],
      ['"hello, "', "string"],
      ["Println", "function"],
      ["'x'", "string"],
      ["3.14", "number"],
      ["nil", "constant"],
      ["return", "keyword"],
    ],
  },
  {
    language: "shell",
    content: `#!/usr/bin/env bash
# Deploy script
NAME="world"
greet() {
  local who="$1"
  echo "Hello, \${who}" | tee -a "$LOG"
}
if [[ -n "$NAME" ]]; then greet "$NAME"; fi
`,
    expect: [
      ["# Deploy", "comment"],
      ["NAME", "variable"],
      ['"world"', "string"],
      ["greet", "function"],
      ["local", "keyword"],
      ["echo", "function"],
      ['"Hello', "string"],
      ["${", "punctuation"],
      ["who}", "variable"],
      ["-a", "parameter"],
      ["if", "keyword"],
      ["fi", "keyword"],
    ],
  },
  {
    language: "dotenv",
    content: `# env\nexport API_URL="https://example.invalid"\nDEBUG=1\n`,
    expect: [
      ["# env", "comment"],
      ["export", "keyword"],
      ["API_URL", "variable"],
      ['"https', "string"],
      ["DEBUG", "variable"],
    ],
  },
  {
    language: "rust",
    content: `use std::collections::HashMap;

/// Adds one.
#[inline]
pub fn add_one(x: u32) -> u32 {
    let s = "rust";
    println!("{}", s);
    x + 1 // done
}
`,
    expect: [
      ["use", "keyword"],
      ["HashMap", "type"],
      ["/// Adds", "comment"],
      ["#[inline]", "attribute"],
      ["inline]", "attribute"],
      ["pub", "keyword"],
      ["fn", "keyword"],
      ["add_one", "function"],
      ["x:", "parameter"],
      ["u32", "type"],
      ["let", "keyword"],
      ['"rust"', "string"],
      ["println", "function"],
      ["1 //", "number"],
      ["// done", "comment"],
    ],
  },
  {
    language: "css",
    content: `/* theme */\n@media (max-width: 600px) {\n  .btn:hover > a { color: #ff0000; margin: 0 4px !important; }\n}\n`,
    expect: [
      ["/* theme", "comment"],
      ["@media", "keyword"],
      ["max-width", "property"],
      ["600px", "number"],
      ["btn", "type"],
      ["hover", "attribute"],
      ["a {", "tag"],
      ["color", "property"],
      ["#ff0000", "number"],
      ["!important", "keyword"],
    ],
  },
  {
    language: "scss",
    content: `.a { color: red; }\n`,
    expect: [["color", "property"]],
  },
  {
    language: "html",
    content: `<!DOCTYPE html>\n<!-- note -->\n<div class="card" id=main>Tom &amp; Jerry</div>\n`,
    expect: [
      ["<!-- note", "comment"],
      ["div", "tag"],
      ["class", "attribute"],
      ['"card"', "string"],
      ["&amp;", "regexp"],
    ],
  },
  {
    language: "xml",
    content: `<root a="1"><child/></root>\n`,
    expect: [
      ["root", "tag"],
      ["a=", "attribute"],
      ['"1"', "string"],
    ],
  },
  {
    language: "starlark",
    content: `load("//x:y.bzl", "rule")\ncc_library(name = "lib")\n`,
    expect: [
      ["cc_library", "function"],
      ['"lib"', "string"],
    ],
  },
  {
    language: "git-config",
    content: `[user]\n\tname = Lucy\n# c\n`,
    expect: [
      ["user", "type"],
      ["name", "property"],
      ["Lucy", "string"],
      ["# c", "comment"],
    ],
  },
  {
    language: "ignore",
    content: `# build output\ndist/\n!dist/keep\n*.log\n`,
    expect: [
      ["# build", "comment"],
      ["!", "operator"],
      ["*", "operator"],
    ],
  },
];

describe("highlighting per language (through the worker and tokenizeLines)", () => {
  for (const testCase of CASES) {
    test(testCase.language, async () => {
      const ranges = await service.highlight(testCase.content, testCase.language);
      const lines = tokenizeLines(testCase.content, ranges);
      for (const [needle, token, nth] of testCase.expect) {
        const found = probe(testCase.content, lines, needle, nth ?? 0);
        expect(`${needle} → ${found.token} (${found.group})`).toBe(`${needle} → ${token} (${found.group})`);
      }
    });
  }
});

describe("offsets", () => {
  test("ranges are UTF-16 code units, not bytes (TypeScript with Turkish text and emoji)", async () => {
    const content = 'const ğüşİö = "çğ😀"; let x = 1 // é ş\n';
    const ranges = await service.highlight(content, "typescript");
    const text = (group: string) =>
      ranges.filter((r) => r.group === group).map((r) => content.slice(r.start, r.end));
    expect(text("string")).toEqual(['"çğ😀"']);
    expect(text("keyword")).toContain("let");
    expect(text("comment")).toEqual(["// é ş"]);
    const letRange = ranges.find((r) => content.slice(r.start, r.end) === "let");
    expect(letRange?.start).toBe(content.indexOf("let"));
    // In UTF-8 bytes `let` would start 9 bytes later.
    expect(Buffer.byteLength(content.slice(0, content.indexOf("let")))).toBe(content.indexOf("let") + 9);
  });

  test("Python with Turkish identifiers and emoji, per-line columns included", async () => {
    const content = 'def çalış():\n    return "😀ş"  # yorum ğ\n';
    const ranges = await service.highlight(content, "python");
    const lines = tokenizeLines(content, ranges);
    expect(probe(content, lines, "def")).toMatchObject({ token: "keyword", text: "def" });
    expect(probe(content, lines, "çalış")).toMatchObject({ token: "function", text: "çalış" });
    expect(probe(content, lines, '"😀ş"')).toMatchObject({ token: "string", text: '"😀ş"' });
    expect(probe(content, lines, "# yorum")).toMatchObject({ token: "comment", text: "# yorum ğ" });
    expect(lines[1]?.find((t) => t.group === "comment")).toEqual({ start: 18, end: 27, group: "comment" });
  });
});

describe("unknown and plain-text content", () => {
  test("unknown languages and plain text give no ranges and no error", async () => {
    expect(await service.highlight("x = 1", "cobol")).toEqual([]);
    expect(await service.highlight("x = 1", "plaintext")).toEqual([]);
    expect(await service.highlight("FROM node:22", "dockerfile")).toEqual([]);
    expect(await service.highlight("", "typescript")).toEqual([]);
    const direct = await service.client.highlightOnce("x", "cobol");
    expect(direct.highlights ?? []).toEqual([]);
    expect(direct.error).toBeUndefined();
  });

  test("filetypeFor gives the <code> filetype, or undefined for plain text", () => {
    expect(service.filetypeFor("src/a.py")).toBe("python");
    expect(service.filetypeFor("bin/tool", "#!/bin/zsh")).toBe("bash");
    expect(service.filetypeFor("tsconfig.json")).toBe("jsonc");
    expect(service.filetypeFor("Cargo.toml")).toBe("toml");
    expect(service.filetypeFor("App.tsx")).toBe("typescriptreact");
    expect(service.filetypeFor("Dockerfile")).toBeUndefined();
    expect(service.filetypeFor("notes.txt")).toBeUndefined();
    expect(service.filetypeFor("a.cob")).toBeUndefined();
    expect(service.languageFor(".zshrc").displayName).toBe("Shell Script");
  });

  test("the client serves fallback filetypes to <code>", async () => {
    const result = await service.client.highlightOnce('{"a": 1}', "json");
    expect(result.highlights?.map(([start, end, group]) => [start, end, group])).toContainEqual([
      1,
      4,
      "property",
    ]);
  });
});

describe("cancellation", () => {
  const big = Array.from({ length: 3000 }, (_, i) => `export const v${i}: number = ${i}; // n`).join("\n");

  test("an already aborted signal rejects with CANCELLED", async () => {
    const controller = new AbortController();
    controller.abort();
    await expectCancelled(service.highlight(big, "typescript", { signal: controller.signal }));
    await expectCancelled(service.highlight('{"a":1}', "json", { signal: controller.signal }));
  });

  test("aborting while the worker is busy rejects at once, and the service keeps working", async () => {
    const controller = new AbortController();
    const started = performance.now();
    const pending = service.highlight(big, "typescript", { signal: controller.signal });
    controller.abort();
    await expectCancelled(pending);
    expect(performance.now() - started).toBeLessThan(50);
    const after = await service.highlight("let ok = true", "typescript");
    expect(after.length).toBeGreaterThan(0);
  });
});

describe("size guard", () => {
  test("content above the limits is skipped without starting a worker", async () => {
    const small = new SyntaxService({ dataPath: join(root, "small"), maxBytes: 2000, maxLines: 50 });
    const manyLines = Array.from({ length: 60 }, (_, i) => `x = ${i}`).join("\n");
    expect(await small.highlight(manyLines, "python")).toEqual([]);
    expect(await small.highlight(`x = "${"a".repeat(3000)}"`, "python")).toEqual([]);
    expect(await small.highlight(`[${"1,".repeat(1500)}1]`, "json")).toEqual([]);
    expect(small.isStarted).toBe(false);
    expect(existsSync(join(root, "small"))).toBe(false);
    expect((await small.highlight("x = 1", "python")).length).toBeGreaterThan(0);
    await small.disposeAsync();
  });

  test("default limits: 1 MiB of UTF-8 and 20,000 lines", async () => {
    const mib = 1024 * 1024;
    expect(service.exceedsSizeLimit("a".repeat(mib))).toBe(false);
    expect(service.exceedsSizeLimit("a".repeat(mib + 1))).toBe(true);
    expect(service.exceedsSizeLimit("ş".repeat(600_000))).toBe(true);
    expect(service.exceedsSizeLimit("\n".repeat(19_999))).toBe(false);
    expect(service.exceedsSizeLimit("\n".repeat(20_000))).toBe(true);
    const started = performance.now();
    const result = await service.client.highlightOnce("let a = 1;\n".repeat(30_000), "typescript");
    expect(result.highlights).toEqual([]);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("offline guarantees", () => {
  test("every registered grammar source is an absolute local file", () => {
    const parsers = service.registeredParsers();
    expect(parsers.map((p) => p.filetype).sort()).toEqual([
      "bash",
      "css",
      "go",
      "html",
      "python",
      "rust",
      "toml",
      "yaml",
    ]);
    for (const parser of parsers) {
      for (const source of [
        parser.wasm,
        ...parser.queries.highlights,
        ...(parser.queries.injections ?? []),
      ]) {
        expect(source).not.toMatch(/^[a-z][a-z0-9+.-]*:\/\//i);
        expect(isAbsolute(source)).toBe(true);
        expect(existsSync(source)).toBe(true);
      }
    }
  });

  test("URL and relative sources are refused before reaching the worker", () => {
    const remote = {
      filetype: "x",
      wasm: "https://example.invalid/x.wasm",
      queries: { highlights: ["/q.scm"] },
    };
    const refused = (fn: () => unknown): boolean => {
      try {
        fn();
      } catch (error) {
        return isLucyError(error, "INVALID_ARGUMENT");
      }
      return false;
    };
    expect(refused(() => service.client.addFiletypeParser(remote))).toBe(true);
    expect(
      refused(() =>
        service.client.addFiletypeParser({
          ...remote,
          wasm: "/x.wasm",
          queries: { highlights: ["http://a/q.scm"] },
        }),
      ),
    ).toBe(true);
    expect(refused(() => service.client.addFiletypeParser({ ...remote, wasm: "relative/x.wasm" }))).toBe(
      true,
    );
    expect(refused(() => assertLocalSource("file:///tmp/x.wasm"))).toBe(true);
    expect(
      refused(
        () =>
          new LucyTreeSitterClient({
            dataPath: join(root, "never"),
            parsers: [remote],
            isTooLarge: () => false,
          }),
      ),
    ).toBe(true);
    expect(existsSync(join(root, "never"))).toBe(false);
  });

  test("timings: 5k-line TypeScript and Python files", async () => {
    const ts = Array.from(
      { length: 5000 },
      (_, i) =>
        [
          `export function compute${i}(input: number, label = "item-${i}"): string {`,
          `  const doubled = input * 2 + ${i}; // double it`,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: this string is TypeScript source text.
          "  return `${label}:${doubled}`;",
          "}",
        ][i % 4],
    ).join("\n");
    const py = Array.from(
      { length: 5000 },
      (_, i) =>
        [
          `def compute_${i}(value: int, label: str = "item") -> str:`,
          `    """Return a label for ${i}."""`,
          `    doubled = value * 2 + ${i}  # double it`,
          `    return f"{label}:{doubled}"`,
        ][i % 4],
    ).join("\n");
    // Cold: a fresh service, so this includes starting the worker and loading the grammar.
    const cold = new SyntaxService({ dataPath: join(root, "cold") });
    for (const [name, content, language, what] of [
      ["TypeScript", ts, "typescript", "worker start + grammar load"],
      ["Python", py, "python", "grammar load, worker already running"],
    ] as const) {
      const c0 = performance.now();
      const ranges = await cold.highlight(content, language);
      console.log(
        `[timing] ${name} 5,000 lines, cold (${what}): ${(performance.now() - c0).toFixed(0)} ms, ${ranges.length} ranges`,
      );
    }
    await cold.disposeAsync();
    for (const [name, content, language] of [
      ["TypeScript", ts, "typescript"],
      ["Python", py, "python"],
    ] as const) {
      const t0 = performance.now();
      const ranges = await service.highlight(content, language);
      const t1 = performance.now();
      await service.highlight(content, language);
      const t2 = performance.now();
      const lines = tokenizeLines(content, ranges);
      const t3 = performance.now();
      console.log(
        `[timing] ${name} 5,000 lines (${(content.length / 1024).toFixed(0)} KiB, ${ranges.length} ranges): ` +
          `warm highlight ${(t1 - t0).toFixed(0)} ms, again ${(t2 - t1).toFixed(0)} ms; tokenizeLines ${(t3 - t2).toFixed(0)} ms`,
      );
      expect(lines.length).toBe(5000);
      expect(ranges.length).toBeGreaterThan(10_000);
      expect(t1 - t0).toBeLessThan(5000);
    }
  }, 30_000);

  test("no fetch, no download, nothing outside the data directory", () => {
    expect(fetchCalls).toBe(0);
    expect(workerLogs.filter((line) => /download|http:|https:/i.test(line))).toEqual([]);
    expect(workerLogs.filter((line) => !line.startsWith("log:"))).toEqual([]);
    expect(listTree(cacheDir)).toEqual(["tree-sitter/", "tree-sitter/languages/", "tree-sitter/queries/"]);
  });
});
