# Third-party notices

Lucy Workspace builds on the components below. Versions are the ones installed in `node_modules`
(lockfile `bun.lock`, 2026-11-16). Licenses and copyright lines were read from each package's own
`package.json` (`license` field) and license files. Upstream URLs are as stated in the package
metadata (`repository` field). Anything that could not be checked against a local file is marked
**unverified**.

Lucy's own license has not been chosen yet (see `docs/LICENSING.md`).

## How these notices apply

Lucy is currently run from source: `bun install` downloads each package from npm together with its
own license files, and Lucy redistributes none of them. The obligations below start to matter when
Lucy is distributed with dependencies included, for example as a `bun build --compile` binary (which
embeds the JavaScript, the `.wasm` grammars, OpenTUI's native library and the Bun runtime).

| License | Must the notice ship with a binary? |
| --- | --- |
| MIT / Expat | Yes: copyright line and permission notice in all copies or substantial portions |
| BSD-3-Clause | Yes: copyright line, conditions and disclaimer in the documentation of binary distributions |
| Apache-2.0 | Yes: a copy of the license, and the contents of any `NOTICE` file |
| Apache-2.0 WITH LLVM-exception | No, for portions compiled into a binary (the exception waives the attribution requirement) |
| LGPL-2.1-or-later | Yes, and more: license text, access to the library's source, and the ability for the user to replace or relink the library (section 6 of the license) |
| Zlib | No (altered source must be marked; the notice stays in source distributions) |
| Unicode-3.0 | Yes: copyright and permission notice in the copies or in associated documentation |
| stb (MIT or public domain, licensee's choice) | No, if the public-domain alternative is chosen |

## 1. Runtime dependencies (direct, `dependencies` in `package.json`)

| Package | Version | License | Copyright | Upstream |
| --- | --- | --- | --- | --- |
| `@opentui/core` | 0.9.1 | MIT | Copyright (c) 2025 opentui | https://github.com/anomalyco/opentui |
| `@opentui/react` | 0.9.1 | MIT | Copyright (c) 2025 opentui | https://github.com/anomalyco/opentui |
| `react` | 19.3.1 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. | https://github.com/react/react.git (as stated; homepage https://react.dev/) |
| `smol-toml` | 1.9.1 | BSD-3-Clause | Copyright (c) Squirrel Chat et al., All rights reserved. | github:squirrelchat/smol-toml |
| `zod` | 4.6.7 | MIT | Copyright (c) 2025 Colin McDonnell | https://github.com/colinhacks/zod |
| `tree-sitter-python` | 0.25.0 | MIT | Copyright (c) 2016 Max Brunsfeld | https://github.com/tree-sitter/tree-sitter-python |
| `tree-sitter-go` | 0.25.0 | MIT | Copyright (c) 2014 Max Brunsfeld | https://github.com/tree-sitter/tree-sitter-go |
| `tree-sitter-bash` | 0.25.1 | MIT | Copyright (c) 2017 Max Brunsfeld | https://github.com/tree-sitter/tree-sitter-bash |
| `tree-sitter-rust` | 0.24.0 | MIT | Copyright (c) 2017 Maxim Sokolov | https://github.com/tree-sitter/tree-sitter-rust |
| `tree-sitter-css` | 0.25.0 | MIT | Copyright (c) 2018 Max Brunsfeld | https://github.com/tree-sitter/tree-sitter-css |
| `tree-sitter-html` | 0.23.2 | MIT | Copyright (c) 2014 Max Brunsfeld | https://github.com/tree-sitter/tree-sitter-html |
| `@tree-sitter-grammars/tree-sitter-yaml` | 0.7.1 | MIT | Copyright (c) 2024 tree-sitter-grammars contributors; Copyright (c) 2019-2021 Ika | https://github.com/tree-sitter-grammars/tree-sitter-yaml |
| `@tree-sitter-grammars/tree-sitter-toml` | 0.7.0 | MIT | Copyright (c) Ika <ikatyang@gmail.com> | https://github.com/tree-sitter-grammars/tree-sitter-toml |

Of the grammar packages, Lucy loads only the `.wasm` file and none of the native bindings. Their
`install` scripts are blocked by Bun (not in `trustedDependencies`).

## 2. Transitive runtime components loaded at run time

### 2.1 JavaScript bundled inside `@opentui/core`

`@opentui/core` ships its dependencies pre-bundled into its own JavaScript files (the bundle
comments name the source paths). At run time these bundled copies are what runs, at the versions
below; the separately installed copies in `node_modules` may differ in version.

| Component | Bundled version | Installed version | License | Copyright | Upstream |
| --- | --- | --- | --- | --- | --- |
| `web-tree-sitter` (JS and `tree-sitter.wasm` runtime) | 0.25.10 | 0.25.10 | MIT | Copyright (c) 2018-2024 Max Brunsfeld | https://github.com/tree-sitter/tree-sitter |
| `diff` (jsdiff) | 9.0.0 | 9.0.0 | BSD-3-Clause | Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com> | https://github.com/kpdecker/jsdiff |
| `bun-ffi-structs` | 0.3.1 | 0.3.1 | MIT | Copyright 2025 Anomaly | https://github.com/anomalyco/bun-ffi-structs |
| `string-width` | 7.2.0 | 7.2.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) | sindresorhus/string-width |
| `strip-ansi` | 7.1.2 | 7.2.0 | MIT | Copyright (c) Sindre Sorhus | chalk/strip-ansi |
| `ansi-regex` | 6.2.2 | 6.6.0 | MIT | Copyright (c) Sindre Sorhus | chalk/ansi-regex |
| `get-east-asian-width` | 1.4.0 | 1.7.0 | MIT | Copyright (c) Sindre Sorhus | sindresorhus/get-east-asian-width |
| `emoji-regex` | 10.6.0 | 10.6.0 | MIT | Copyright Mathias Bynens <https://mathiasbynens.be/> | https://github.com/mathiasbynens/emoji-regex |

Copyright and license lines for the bundled versions were read from the installed copies; for the
three where the versions differ, the license is unchanged across those versions as far as the
installed files show (unverified for the exact bundled version).

### 2.2 React runtime pulled in by `@opentui/react`

| Package | Version | License | Copyright | Upstream |
| --- | --- | --- | --- | --- |
| `react-reconciler` | 0.33.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. | https://github.com/facebook/react |
| `scheduler` | 0.27.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. | https://github.com/facebook/react |

### 2.3 OpenTUI native library (`@opentui/core-darwin-arm64` 0.9.1, `libopentui.dylib`)

Package license field: **`MIT AND LGPL-2.1-or-later`**. The package ships one license file per
component. Only the macOS arm64 package is installed; the Linux and other platform packages
(`@opentui/core-linux-x64`, ...) are **unverified** (not installed here).

| Component | License | Copyright / source | Notes |
| --- | --- | --- | --- |
| OpenTUI native core | MIT | Copyright (c) 2025 opentui | `LICENSE` |
| FFmpeg 9.0.2 (decode-only: MOV/MP4, H.264, AAC, libswscale, libswresample) | LGPL-2.1-or-later | Source: https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz (per `FFMPEG-SOURCE.md`) | Statically linked into `libopentui.dylib` (FFmpeg strings are present in the binary). Used by OpenTUI's video support, which Lucy does not use, but the code is in the library. `LICENSE-FFMPEG` |
| Ghostty (libghostty-vt terminal emulator) | MIT | Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors | `LICENSE-GHOSTTY`, which also covers the items below |
| uucode | MIT | Copyright (c) 2026 Jacob Sandlund | in `LICENSE-GHOSTTY` |
| uucode UTF-8 decoder | MIT | Copyright (c) 2008-2009 Bjoern Hoehrmann <bjoern@hoehrmann.de> | in `LICENSE-GHOSTTY` |
| Unicode data | Unicode-3.0 | Copyright (c) 1991-2025 Unicode, Inc. | in `LICENSE-GHOSTTY` |
| Yoga (layout) | MIT | Copyright (c) Facebook, Inc. and its affiliates. | `LICENSE-YOGA` |
| Zig standard library | MIT (Expat) | Copyright (c) Zig contributors | `LICENSE-ZIG` |
| zlib 1.3.2 | Zlib | (C) 1995-2026 Jean-loup Gailly and Mark Adler | `LICENSE-ZLIB` |
| Wuffs | Apache-2.0 | (no copyright line in the file) | `LICENSE-WUFFS` |
| LLVM | Apache-2.0 WITH LLVM-exception | The LLVM Project | `LICENSE-LLVM` |
| libwebp | BSD-3-Clause, plus an additional patent grant | Copyright (c) 2010, Google Inc. All rights reserved. | `LICENSE-LIBWEBP`, `PATENTS-LIBWEBP`, `AUTHORS-LIBWEBP` |
| Little CMS (lcms2) | MIT | Copyright (c) 2023 Marti Maria Saguer | `LICENSE-LCMS2` |
| stb | MIT or Unlicense (public domain) | Copyright (c) 2017 Sean Barrett | `LICENSE-STB` |
| MinGW-w64 runtime | ZPL-2.1 (with marked public-domain, BSD and LGPL parts) | Copyright (c) 2009 - 2013 by the mingw-w64 project | `LICENSE-MINGW-W64`; applies to OpenTUI's Windows libraries |
| gdtoa (in MinGW-w64) | gdtoa/Lucent permissive notice | Copyright (C) 1998, 1999 by Lucent Technologies | `LICENSE-GDTOA`; the file says it applies to OpenTUI's Windows libraries |

`FFMPEG-SOURCE.md` states that the FFmpeg source is unmodified and that OpenTUI's source, its build
script and the pinned FFmpeg source are what is needed to rebuild and relink `libopentui` with a
modified FFmpeg. Anyone distributing `libopentui` (for example inside a compiled Lucy binary) must
meet the LGPL-2.1 terms for it.

### 2.4 Installed but not loaded in normal use

| Package | Version | License | Copyright | Why it is installed |
| --- | --- | --- | --- | --- |
| `react-devtools-core` | 7.0.1 | MIT (package metadata; **no license file in the package**) | Meta Platforms (unverified: no file) | Optional peer of `@opentui/react`; imported only when `DEV=true` |
| `ws` | 8.23.0 | MIT | Copyright (c) 2011 Einar Otto Stangvik; (c) 2013 Arnout Kazemier and contributors; (c) 2016 Luigi Pinca and contributors | Optional peer of `@opentui/react` |
| `ws` (nested under `react-devtools-core`) | 7.5.14 | MIT | (same authors; `LICENSE` present) | Dependency of `react-devtools-core` |
| `shell-quote` | 1.12.0 | MIT | Copyright (c) 2013 James Halliday (mail@substack.net) | Dependency of `react-devtools-core` |
| `node-gyp-build` | 4.8.4 | MIT | Copyright (c) 2017 Mathias Buus | Dependency of the grammar packages (native binding loader, unused) |
| `node-addon-api` | 8.9.2 | MIT | Copyright (c) 2017 Node.js API collaborators | Dependency of the grammar packages (unused) |

The empty folder `node_modules/@xterm/` contains no package.

## 3. Bundled assets

### 3.1 Grammars and queries shipped inside `@opentui/core` (`assets/`)

OpenTUI ships these Tree-sitter grammars (`.wasm`) and highlight queries, which Lucy uses for
TypeScript, TSX, JavaScript and Markdown. OpenTUI's package contains only its own MIT `LICENSE`; no
license file for these assets is included. Their licenses are therefore **unverified** locally.

| Asset | Query origin (from the comment at the top of each `.scm`) |
| --- | --- |
| `typescript`, `typescriptreact` (`tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm`) | nvim-treesitter `queries/ecma/highlights.scm` |
| `javascript` (`tree-sitter-javascript.wasm`) | tree-sitter-javascript `queries/highlights.scm` |
| `markdown`, `markdown_inline` | nvim-treesitter queries, "From MDeiml/tree-sitter-markdown & Helix" |
| `zig` (`tree-sitter-zig.wasm`) | nvim-treesitter `queries/zig/highlights.scm` |

Unverified, from general knowledge of these projects: the tree-sitter grammar repositories are
published under MIT, and nvim-treesitter under Apache-2.0. Confirm both before distributing a
binary that embeds these files.

### 3.2 Grammar `.wasm` files from the npm grammar packages

Loaded from the packages in section 1 and covered by their MIT licenses and copyright lines above.

### 3.3 Lucy's highlight queries (`src/adapters/syntax/queries/*.scm`)

`bash.scm`, `css.scm`, `go.scm`, `html.scm`, `python.scm`, `rust.scm`, `toml.scm`, `yaml.scm` were
written for Lucy against each grammar's node types. Their keyword, operator and builtin lists and
some naming heuristics derive from the `queries/highlights.scm` files of the grammar packages in
section 1 (per `src/adapters/syntax/README.md`). Because these derived portions are distributed in
Lucy's own source, the MIT notice is reproduced here:

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

The queries use nvim-treesitter's capture names (such as `@function`); names only, no query code
from nvim-treesitter.

### 3.4 Demo fixture (`examples/demo-project/`)

"Orbit" is a fictional project used by `lucy --demo`. Its `LICENSE` (MIT, "The Orbit contributors")
is part of the fixture content. Its binary files (`assets/logo.png`, `data/snapshot.bin`) are
generated by `src/app/demo/generate-assets.ts`, not copied from elsewhere. That the fixture text was
written for this repository is assumed, not verified.

## 4. Development-only dependencies (`devDependencies`, not shipped)

| Package | Version | License | Copyright | Upstream |
| --- | --- | --- | --- | --- |
| `@biomejs/biome` | 2.6.8 | MIT OR Apache-2.0 | Copyright (c) 2023 Biome Developers and Contributors. | https://github.com/biomejs/biome |
| `@biomejs/cli-darwin-arm64` | 2.6.8 | MIT OR Apache-2.0 (no license file in the package) | as above | https://github.com/biomejs/biome |
| `typescript` | 7.0.2 | Apache-2.0 (has `NOTICE.txt` listing third-party material) | No copyright line in `LICENSE`; `author`: Microsoft Corp. | https://github.com/microsoft/TypeScript |
| `@typescript/typescript-darwin-arm64` | 7.0.2 | Apache-2.0 (has `NOTICE.txt`) | as above | https://github.com/microsoft/TypeScript |
| `@types/bun` | 1.4.4 | MIT | Copyright (c) Microsoft Corporation. | https://github.com/DefinitelyTyped/DefinitelyTyped |
| `@types/react` | 19.3.0 | MIT | Copyright (c) Microsoft Corporation. | https://github.com/DefinitelyTyped/DefinitelyTyped |
| `@types/node` (via `bun-types`) | 26.6.6 | MIT | Copyright (c) Microsoft Corporation. | https://github.com/DefinitelyTyped/DefinitelyTyped |
| `bun-types` (via `@types/bun`) | 1.4.4 | MIT (no license file in the package) | unverified | https://github.com/oven-sh/bun |
| `undici-types` (via `bun-types`) | 8.12.4 | MIT | Copyright (c) Matteo Collina and Undici contributors | https://github.com/nodejs/undici |
| `csstype` (via `@types/react`) | 3.2.3 | MIT | Copyright (c) 2017-2018 Fredrik Nicol | https://github.com/frenic/csstype |

## 5. Runtime environment (not in `package.json`)

| Component | Version | License | Notes |
| --- | --- | --- | --- |
| Bun | 1.3.14 | **Unverified**: the local install (`~/.bun`) contains no license file | Required to run Lucy. A `bun build --compile` binary embeds the Bun runtime, so its license terms (including those of the JavaScript engine it links) must be checked before such a binary is distributed. |

## 6. Design references: color palettes

The themes use published palette values; the mapping to Lucy's tokens is original, and no theme
files were copied (`src/themes/README.md`). No local license file exists for these palettes, so the
licenses below are taken from `src/themes/README.md` and are **unverified**.

| Theme | Palette source | License (as stated in `src/themes/README.md`) |
| --- | --- | --- |
| Catppuccin Mocha | Catppuccin palette, github.com/catppuccin/palette | MIT, (c) Catppuccin |
| Tokyo Night | github.com/enkia/tokyo-night-vscode-theme (original palette); "night" values as in github.com/folke/tokyonight.nvim | MIT (enkia); Apache-2.0 (folke) |
| Gruvbox Dark | github.com/morhetz/gruvbox | MIT, (c) Pavel Pertsev |
| High Contrast | Original to Lucy | Lucy's own license |

## 7. External programs Lucy can launch but does not ship

Lucy contains no code from these programs. It looks them up on your `PATH` and runs them as
separate processes, so their licenses impose nothing on Lucy. All are optional except Git for
Source Control. Licenses were not checked (nothing is distributed).

| Program | Used for |
| --- | --- |
| `git` | Source Control, ignore detection, file listing, `git grep` search |
| `rg` (ripgrep) | Project search and file listing |
| `claude` (Claude Code) | The AI panel, run in a terminal |
| `micro`, `hx` (Helix), `nvim` (Neovim), `vim`, `nano`, `vi`, or `$VISUAL`/`$EDITOR` | External editor |
| `lazygit` | Listed as an optional Git UI in the tool overview |
| `tmux`, `fzf`, `atuin`, `zoxide` | Detected only (`--version`) for the tool overview |
| Your shell (`$SHELL` or `terminal.shell`) | The embedded terminal |
| `ps` | Finding and stopping terminal process trees |
| A Chromium-family browser | Development screenshots only (`scripts/screenshot/`), not used by the application |

## 8. Unverified items

- Licenses of the grammars and queries bundled in `@opentui/core/assets` (section 3.1), including
  nvim-treesitter's.
- License files of the non-macOS OpenTUI native packages (not installed).
- Bun runtime license terms (no local file).
- Palette licenses (section 6).
- `react-devtools-core`, `bun-types` and `@biomejs/cli-darwin-arm64` copyright lines (packages ship
  no license file; the `license` field is MIT, MIT and MIT OR Apache-2.0).
- Exact license text of the bundled `strip-ansi` 7.1.2, `ansi-regex` 6.2.2 and
  `get-east-asian-width` 1.4.0 (installed copies are newer versions).
