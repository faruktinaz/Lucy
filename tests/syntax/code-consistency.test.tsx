/**
 * `<code>` with Lucy's client and a `SyntaxStyle` built from `STYLE_GROUPS` must color every cell
 * exactly as `tokenizeLines` predicts, so the diff view and the code viewer always agree.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type CodeRenderable, SyntaxStyle } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import {
  configureOpenTuiDataPath,
  languageById,
  STYLE_GROUPS,
  SYNTAX_TOKENS,
  SyntaxService,
  syntaxGroupToToken,
} from "../../src/adapters/syntax";
import type { Disposable } from "../../src/core/events";
import { makeTempDir, removeTempDirs } from "./helpers";

const WIDTH = 100;
const DEFAULT_FG = "#fafafa";
const root = makeTempDir("consistency");
let service: SyntaxService;
let setup: TestRendererSetup;
let style: SyntaxStyle;
let globalOverride: Disposable;

const hex = (n: number): string => n.toString(16).padStart(2, "0");
/** One distinct color per token, so a captured cell color identifies its token. */
const tokenColor = (index: number): string => `#${hex(8 + index * 10)}4080`;
const colorToToken = new Map<string, string>(SYNTAX_TOKENS.map((token, i) => [tokenColor(i), token]));
colorToToken.set(DEFAULT_FG, "default");

beforeAll(async () => {
  // Belt and braces: if anything fell back to OpenTUI's global client it would write here.
  globalOverride = configureOpenTuiDataPath(join(root, "opentui-global"));
  service = new SyntaxService({ dataPath: join(root, "cache") });
  setup = await testRender(<box />, { width: WIDTH, height: 30 });
  const styles: Record<string, { fg: string }> = { default: { fg: DEFAULT_FG } };
  for (const group of STYLE_GROUPS) {
    const token = syntaxGroupToToken(group);
    if (token) styles[group] = { fg: tokenColor(SYNTAX_TOKENS.indexOf(token)) };
  }
  style = SyntaxStyle.fromStyles(styles, setup.renderer.nativeScene);
});

afterAll(async () => {
  await act(async () => setup.renderer.destroy());
  style.destroy();
  await service.disposeAsync();
  globalOverride.dispose();
  removeTempDirs();
});

const SAMPLES: readonly (readonly [string, string])[] = [
  [
    "typescript",
    `import { readFile } from "node:fs/promises";
// Load a config file.
export async function load(path: string, retries = 3): Promise<Config | null> {
  const text = await readFile(path, "utf8");
  if (!text) return null;
  return { ...JSON.parse(text), loadedAt: new Date(), pattern: /a+b/g } as Config;
}`,
  ],
  [
    "python",
    `import os
@cache
class Store(Base):
    """Docs."""
    def get(self, key: str, default=None) -> str | None:
        value = os.environ.get(key, default)  # read
        return f"{key}={value!r}" if value else None`,
  ],
  [
    "yaml",
    `# deploy
name: app
on:
  push: { branches: [main] }
steps:
  - run: echo "hi"
    timeout: 10
    enabled: true`,
  ],
  [
    "shell",
    `#!/bin/bash
set -euo pipefail
NAME="\${1:-world}"
for f in *.txt; do echo "file: $f" >> "$NAME.log"; done`,
  ],
  [
    "rust",
    `#[derive(Debug)]
pub struct P<'a> { name: &'a str }
fn main() { let v: Vec<u8> = Vec::new(); println!("{:?}", v); }`,
  ],
  ["json", `{ "name": "lucy", "n": 1.5, "ok": false, "list": ["a\\tb", null] }`],
  [
    "toml",
    `[package]\nname = "lucy" # n\nversion = "0.1.0"\n[dependencies]\nserde = { version = "1", features = ["derive"] }`,
  ],
  ["css", `.btn:hover > a, #id { color: #fff; margin: 0 4px !important; --gap: 2px; }`],
  [
    "sql",
    "-- report\nSELECT u.id, COUNT(*) AS n FROM users u WHERE u.name = 'it''s' AND u.age > :min\nGROUP BY u.id; /* end */",
  ],
  ["dotenv", '# db\nDATABASE_URL=postgres://localhost/app\nDEBUG=true\nGREETING="Hi $USER\\n" # c'],
  ["c", "#include <stdio.h>\nstatic int add(int a, int b) { return a + b; } // sum\nint x = MAX + 0x1F;"],
  [
    "vue",
    '<template><div :class="x">{{ n }}</div></template>\n<script lang="ts">const n: number = 1;</script>\n<style>.x { color: red; }</style>',
  ],
];

describe("<code> colors match tokenizeLines", () => {
  for (const [languageId, content] of SAMPLES) {
    test(languageId, async () => {
      const filetype = languageById(languageId)?.filetype;
      if (!filetype) throw new Error(`no filetype for ${languageId}`);
      const lines = content.split("\n");
      let code: CodeRenderable | null = null;
      const reactRoot = createRoot(setup.renderer);
      await act(async () => {
        reactRoot.render(
          <code
            ref={(r: CodeRenderable | null) => {
              code = r;
            }}
            content={content}
            filetype={filetype}
            syntaxStyle={style}
            treeSitterClient={service.client}
            fg={DEFAULT_FG}
            wrapMode="none"
            width={WIDTH}
            height={lines.length}
          />,
        );
      });
      const view = code as CodeRenderable | null;
      if (!view) throw new Error("code renderable not mounted");
      // Highlighting starts on the first frame; colors land on a later one.
      await setup.renderOnce();
      await view.highlightingDone;
      await setup.renderOnce();
      const frame = setup.captureSpans();

      const expected = service.tokenizeLines(content, await service.highlight(content, languageId));
      // Guard against a vacuous pass where both sides are uncolored.
      expect(expected.flat().length).toBeGreaterThan(lines.length);
      lines.forEach((line, row) => {
        const actual: string[] = [];
        for (const span of frame.lines[row]?.spans ?? []) {
          const [r, g, b] = span.fg.toInts();
          const name = colorToToken.get(`#${hex(r)}${hex(g)}${hex(b)}`) ?? `?${hex(r)}${hex(g)}${hex(b)}`;
          for (let i = 0; i < span.width; i++) actual.push(name);
        }
        const want = Array.from({ length: line.length }, (_, column) => {
          const token = expected[row]?.find((t) => t.start <= column && column < t.end);
          return token ? (syntaxGroupToToken(token.group) ?? "default") : "default";
        });
        const describeRow = (names: readonly string[]): string =>
          [...line].map((char, i) => `${char}:${names[i]}`).join(" ");
        expect(describeRow(actual.slice(0, line.length))).toBe(describeRow(want));
      });
      await act(async () => reactRoot.unmount());
    });
  }

  test("nothing fell back to OpenTUI's global client", () => {
    expect(existsSync(join(root, "opentui-global"))).toBe(false);
  });
});
