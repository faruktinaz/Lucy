# Syntax service

Language detection, offline syntax highlighting and the mapping from highlight groups to theme
tokens. No UI code lives here.

## Using it

```ts
import { configureOpenTuiDataPath, STYLE_GROUPS, SyntaxService, syntaxGroupToToken } from "@/adapters/syntax";

// Bootstrap, before the first renderer exists:
configureOpenTuiDataPath(join(appDirs.cache, "opentui")); // OpenTUI's global client never writes to ~/.local/share
const syntax = new SyntaxService({ dataPath: join(appDirs.cache, "tree-sitter") });

// A SyntaxStyle from theme tokens (the UI owns the colors):
const styles = Object.fromEntries(STYLE_GROUPS.map((g) => [g, styleFor(syntaxGroupToToken(g)!)]));

// Views on OpenTUI's <code>/<markdown>:
<code treeSitterClient={syntax.client} filetype={syntax.filetypeFor(path, firstLine)} … />

// Custom-rendered rows (diff view):
const ranges = await syntax.highlight(content, language.id, { signal });
const lines = syntax.tokenizeLines(content, ranges); // per line: sorted, non-overlapping { start, end, group }
```

- `syntax.client` is created lazily on first access (that starts the worker). Always pass it to
  `<code>` and `<markdown>`: it carries Lucy's grammars and fallback tokenizers, so Markdown fences in
  Python, Go, JSON, YAML, … are colored too.
- Offsets and columns are UTF-16 code units. The worker reports web-tree-sitter `startIndex`, which is
  UTF-16 for JavaScript strings (tested with Turkish text and emoji).
- `tokenizeLines` resolves overlaps exactly like OpenTUI (only styled groups take part; more dot
  segments win; on a tie the later range wins), so a diff row and `<code>` color the same text
  identically. `tests/syntax/code-consistency.test.tsx` checks this cell by cell.
- `syntaxGroupToToken` applies OpenTUI's own lookup (exact name, then first segment only), so a
  `SyntaxStyle` built from `STYLE_GROUPS` needs nothing else.
- Size guard: above 1 MiB (UTF-8) or 20,000 lines nothing is highlighted, in `highlight()` and in
  the client used by `<code>`. `exceedsSizeLimit(content)` lets the UI say why.
- `highlight()` never throws except `LucyError("CANCELLED")` when its signal aborts. Unknown
  languages, plain text and worker failures resolve to `[]`.

## Where colors come from

| Language                                                                                                                             | Source                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| TypeScript, TSX, JavaScript, JSX, Markdown                                                                                           | OpenTUI's bundled grammars and queries                         |
| Python (and Starlark), Go, Bash/sh/zsh (and `.env`), YAML, TOML, Rust, CSS (and SCSS/Less, best effort), HTML (and XML, best effort) | npm grammar package (`.wasm`) + Lucy's own query in `queries/` |
| JSON, JSON with Comments, JSON5                                                                                                      | `fallback/json-tokenizer.ts`                                   |
| INI, Properties, Git Config, EditorConfig, `.npmrc`                                                                                  | `fallback/conf-tokenizer.ts`                                   |
| `.gitignore`-style files, `.gitattributes`                                                                                           | `fallback/ignore-tokenizer.ts`                                 |
| Dockerfile, Makefile, Diff, `go.mod`, `go.sum`, plain text                                                                           | detected (status bar name) but not colored                     |

### Why our own queries

The packaged `queries/highlights.scm` files assume tree-sitter's first-match-wins order (generic
`(identifier) @variable` after `@function`), while OpenTUI lets the later capture win a tie, so
function names came out as variables. They also use names OpenTUI does not style (`@escape`,
`@embedded`, `@constructor` for whole pairs). Our queries use nvim-treesitter capture names, put
generic patterns first, and only use predicates the worker supports (`#match?`, `#any-of?`).
`tests/syntax/style-groups.test.ts` fails if a query uses a capture that maps to no token.

### Why JSON is a tokenizer

The only packaged JSON grammar, `tree-sitter-json`, is on Bun's built-in trusted-dependency list
(`bun pm default-trusted`), so `bun install` would run its `node-gyp-build` install script and
load a native binary, on every fresh clone. Lucy does not run install scripts. JSON's lexical
grammar is regular, so the tokenizer is exact for JSON/JSONC (keys, strings, escapes, numbers,
literals, comments, punctuation) and close for JSON5. It is served through the client, so `<code>`
and `<markdown>` color JSON as well.

## Dependencies and install scripts

Grammar packages are pinned exactly. They declare an `install` script (`node-gyp-build`, for the
native Node binding we never use); Bun blocks it because none of them is trusted
(`bun pm untrusted` lists all eight). Do not add them to `trustedDependencies`. Their regular
dependencies `node-gyp-build` and `node-addon-api` (MIT, no scripts) are installed but unused;
the optional peer `tree-sitter` is not installed.

| Package                                  | Version | License | wasm     |
| ---------------------------------------- | ------- | ------- | -------- |
| `tree-sitter-python`                     | 0.25.0  | MIT     | 458 KB   |
| `tree-sitter-go`                         | 0.25.0  | MIT     | 217 KB   |
| `tree-sitter-bash`                       | 0.25.1  | MIT     | 1,358 KB |
| `@tree-sitter-grammars/tree-sitter-yaml` | 0.7.1   | MIT     | 189 KB   |
| `@tree-sitter-grammars/tree-sitter-toml` | 0.7.0   | MIT     | 24 KB    |
| `tree-sitter-rust`                       | 0.24.0  | MIT     | 1,103 KB |
| `tree-sitter-css`                        | 0.25.0  | MIT     | 129 KB   |
| `tree-sitter-html`                       | 0.23.2  | MIT     | 18 KB    |

## Offline and disk rules

- Every grammar source must be an absolute local path. `assertLocalSource` rejects URLs (any
  `scheme://`) and relative paths; `LucyTreeSitterClient.addFiletypeParser` enforces it, because the
  worker would `fetch()` an http(s) source and cache it on disk.
- The worker always creates `<dataPath>/tree-sitter/{languages,queries}`. With local sources
  nothing else is written there.
- `configureOpenTuiDataPath(dir)` redirects OpenTUI's global client (used by any widget that is
  not given our client). `DataPathsManager` only exposes `appName`, and `XDG_DATA_HOME` would leak into
  child processes, so it shadows the singleton's `globalDataPath` getter and emits the manager's own
  `paths:changed` event, which a live global client already listens to.

## Packaging (`bun build --compile`), not solved yet

- In a compiled binary there is no `node_modules`, so `import.meta.resolve("tree-sitter-*/…wasm")`
  and `new URL("./queries/*.scm", import.meta.url)` in `grammars.ts` will not find files. Replace
  them with `import wasm from "tree-sitter-python/tree-sitter-python.wasm" with { type: "file" }`
  (same for each `.scm`). Bun then embeds the files and returns `/$bunfs/root/…` paths, which
  OpenTUI's client already understands (its bundled grammars ship that way; see
  `docs/dev/OPENTUI_NOTES.md` §14). `assertLocalSource` accepts them because they are absolute.
- Only the eight `.wasm` files (about 3.5 MB) and the eight `.scm` files (about 17 KB) are needed. The
  packages' `prebuilds/`, `src/` and `bindings/` must not be embedded; nothing imports them.
- Check `existsSync` on `/$bunfs` paths in `resolveGrammars()` once a compiled build exists.

## Known limitations

- HTML: no injections, so `<script>` and `<style>` contents are not colored.
- XML uses the HTML grammar: tags, attributes, strings and comments are right; `<?xml ?>` is not.
- SCSS and Less use the CSS grammar: `$variables`, mixins and some nesting forms are not colored.
- Fallback tokenizers serve `highlightOnce` only; a `<code streaming>` view of JSON or INI (OpenTUI's
  `highlightAppend` path) stays uncolored.
- `tokenizeLines` returns one group per span. OpenTUI merges attributes of nested groups (for example
  bold from `markup.strong` inside a heading); the diff view shows only the winning group.

## Attribution

The queries in `queries/` were written for Lucy against each grammar's node types. Their keyword,
operator and builtin lists and some naming heuristics derive from the `queries/highlights.scm` files
of the packages above, which are distributed under the MIT License:

- tree-sitter-python: Copyright (c) 2016 Max Brunsfeld
- tree-sitter-go: Copyright (c) 2014 Max Brunsfeld
- tree-sitter-bash: Copyright (c) 2017 Max Brunsfeld
- tree-sitter-rust: Copyright (c) 2017 Maxim Sokolov
- tree-sitter-css: Copyright (c) 2018 Max Brunsfeld
- tree-sitter-html: Copyright (c) 2014 Max Brunsfeld
- @tree-sitter-grammars/tree-sitter-yaml: Copyright (c) 2024 tree-sitter-grammars contributors,
  Copyright (c) 2019-2021 Ika
- @tree-sitter-grammars/tree-sitter-toml: Copyright (c) Ika <ikatyang@gmail.com>

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
> NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
> OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
> CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

The grammar `.wasm` files themselves are loaded from the installed packages and carry those
packages' licenses.
