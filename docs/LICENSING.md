# Choosing a license for Lucy Workspace

**Status: no license has been chosen.** The decision belongs to the maintainer. Until a `LICENSE`
file exists, the code is "all rights reserved" by default, even if the repository is public, and
`package.json` has no `license` field (it is marked `"private": true`). This document compares the
two candidates, MIT and Apache-2.0, against the dependencies actually installed (listed in
`THIRD_PARTY_NOTICES.md`) and gives a recommendation. It is not legal advice.

## 1. What each license means

| Question | MIT | Apache-2.0 |
| --- | --- | --- |
| Length and readability | About 170 words | About 4,500 words |
| What users may do | Use, copy, modify, distribute, sublicense, sell | Same |
| What redistributors must do | Keep the copyright line and permission notice | Include the license; keep copyright, patent and attribution notices; reproduce the `NOTICE` file if the project has one; mark files they changed |
| Explicit patent license from contributors | No (at most implied) | Yes (section 3), ending for anyone who sues claiming the work infringes a patent |
| Contributions | Not addressed; projects rely on "inbound = outbound" convention, often with a DCO sign-off | Section 5: contributions are under Apache-2.0 unless the contributor states otherwise, so no CLA is needed |
| Trademark | Not addressed | Section 6: no trademark rights granted |
| Use inside GPLv2-only projects | Compatible | **Not compatible** (FSF position) |
| Use inside GPLv3, LGPL, MPL-2.0 projects | Compatible | Compatible |

A `NOTICE` file is only needed under Apache-2.0 if the project chooses to have one; the license
does not require creating it. If it exists, every redistributor must carry its contents along.

## 2. Compatibility with Lucy's dependencies

Licenses found in the installed packages (`THIRD_PARTY_NOTICES.md`):

| License | Where | Compatible with MIT for Lucy? | With Apache-2.0? |
| --- | --- | --- | --- |
| MIT / Expat | OpenTUI (JS and native core), React, zod, all Tree-sitter grammar packages, web-tree-sitter, string-width family, Ghostty, Yoga, Zig std, lcms2, `ws`, type packages | Yes | Yes |
| BSD-3-Clause | `smol-toml`, `diff`, libwebp (native) | Yes | Yes |
| Apache-2.0 | Wuffs (native), TypeScript (dev only) | Yes (Lucy may be MIT while depending on Apache-2.0 code; the dependency keeps its terms) | Yes |
| Apache-2.0 WITH LLVM-exception | LLVM parts in the native library | Yes | Yes |
| MIT OR Apache-2.0 | Biome (dev only) | Yes | Yes |
| Zlib | zlib (native) | Yes | Yes |
| Unicode-3.0 | Unicode data in Ghostty (native) | Yes | Yes |
| MIT or Unlicense | stb (native) | Yes | Yes |
| ZPL-2.1, gdtoa notice | MinGW-w64 runtime, Windows builds of the native library only | Yes | Yes |
| **LGPL-2.1-or-later** | FFmpeg, statically linked inside OpenTUI's `libopentui.dylib` | Yes | Yes |

Every license found is permissive except LGPL-2.1-or-later, and none of them constrains the license
of Lucy's own source. The LGPL component lives in a separate shared library that Lucy loads at run
time through OpenTUI; LGPL allows that combination under any license. Its obligations (license text,
source access, the user's ability to replace the library) attach to **distributing that library**,
for example inside a compiled binary, and are the same whichever license Lucy picks. The same is
true for the Bun runtime that a compiled binary would embed (its terms are unverified locally; see
`THIRD_PARTY_NOTICES.md` section 5).

Copyleft in the other direction: MIT code can be taken into GPLv2, GPLv3, LGPL and MPL projects.
Apache-2.0 code can be taken into GPLv3, LGPL-3.0 and MPL-2.0 projects, but not into GPLv2-only
ones. Note that a compiled Lucy binary already contains Apache-2.0 code (Wuffs) through OpenTUI, so
this difference matters for Lucy's source, not for its binaries.

## 3. What comparable tools chose

From the projects' public pages, not verified from local files:

| Project | License |
| --- | --- |
| OpenTUI (Lucy's UI library) | MIT (verified: `node_modules/@opentui/core/LICENSE`) |
| Bun | MIT |
| lazygit, gitui, yazi, micro, Zellij, WezTerm, Ghostty | MIT |
| ripgrep | MIT or Unlicense |
| VS Code (Code - OSS) | MIT |
| Neovim | Apache-2.0 (parts under the Vim license) |
| OpenAI Codex CLI | Apache-2.0 |
| Helix | MPL-2.0 |
| Zed | GPL-3.0 / AGPL-3.0 for the editor, Apache-2.0 for its UI framework |

Terminal developer tools in this space mostly use MIT; Apache-2.0 is common where companies with
patent portfolios contribute.

## 4. Recommendation

**Choose MIT.**

- Every dependency is permissive (or, for FFmpeg, LGPL in a separately loaded library), so the
  choice is not constrained either way; MIT matches the license of OpenTUI and most comparable TUI
  tools.
- MIT is the most compatible choice for anyone who wants to reuse Lucy's code, including GPLv2-only
  projects, and it is short enough that users and contributors read it.
- Apache-2.0's main advantage, the explicit patent grant, matters most when companies holding
  patents contribute significant code. Lucy is a small, single-maintainer project with no known
  patent exposure. If that changes, a later relicensing is possible but needs every contributor's
  consent, so decide this before accepting outside contributions.
- A middle way, used by Rust projects and by Biome: **"MIT OR Apache-2.0"** (users choose). It gives
  users the patent grant if they want it and keeps GPLv2 compatibility, at the cost of two license
  files and a slightly longer explanation. It is a reasonable alternative if patent protection is a
  priority.

## 5. What the maintainer must do once decided

1. Add `LICENSE` at the repository root with the exact license text and a copyright line, for
   example `Copyright (c) 2026 <name or "The Lucy Workspace contributors">`. For the dual option,
   add `LICENSE-MIT` and `LICENSE-APACHE`.
2. Set `"license": "MIT"` (or `"MIT OR Apache-2.0"`, an SPDX expression) in `package.json`. Keep or
   remove `"private": true` depending on whether the package will be published to npm.
3. File headers: not required by MIT. If wanted, use a one-line `// SPDX-License-Identifier: MIT`
   in source files rather than the full notice. Do not add headers to files derived from
   third-party code (`src/adapters/syntax/queries/*.scm`) without keeping their attribution.
4. Contributor terms: state "inbound = outbound" in a `CONTRIBUTING.md` (contributions are accepted
   under the project license) and ask for a Developer Certificate of Origin sign-off
   (`git commit -s`). A CLA is not needed for either license.
5. Keep `THIRD_PARTY_NOTICES.md` current when dependencies change, and resolve its unverified items.
6. Before distributing a compiled binary: ship the notices it requires (MIT, BSD-3-Clause,
   Apache-2.0, Unicode-3.0 texts), meet LGPL-2.1 for `libopentui` (license text, FFmpeg source link,
   a documented way to replace the library), and check the Bun runtime's terms.
7. Confirm the demo fixture's own `LICENSE` (`examples/demo-project/LICENSE`, "The Orbit
   contributors") is intended as fixture content, and that the High Contrast theme and other
   original material fall under the chosen license.
