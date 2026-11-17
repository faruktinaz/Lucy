# Themes and design tokens

Components use **semantic tokens only** (`theme.tokens.bg.surface`, `tokens.syntax.keyword`).
Hex literals live only in the theme files (twelve built-in themes). The token table, with the role of every
token, is `TOKEN_DEFINITIONS` in `tokens.ts`; the `ThemeTokens` type is derived from it.

## Token groups (71 UI tokens + 20 terminal palette entries)

| Group       | Tokens                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bg`        | canvas, base, surface, raised, overlay, inset                                                                                                           |
| `fg`        | default, muted, subtle, onAccent, disabled                                                                                                              |
| `border`    | subtle, default, focus                                                                                                                                  |
| `accent`    | primary, secondary                                                                                                                                      |
| `state`     | hover, active, selectedBg, selectedFg, selectedInactiveBg, focusRing                                                                                    |
| `status`    | success, warning, error, info                                                                                                                           |
| `git`       | added, modified, deleted, renamed, untracked, conflicted, ignored                                                                                       |
| `diff`      | addedLineBg, removedLineBg, addedWordBg, removedWordBg, addedFg, removedFg, hunkHeaderBg, hunkHeaderFg, contextFg                                       |
| `syntax`    | keyword, string, number, comment, function, type, variable, parameter, constant, property, operator, punctuation, tag, attribute, heading, link, regexp |
| `editor`    | bg, lineNumber, lineNumberActive, activeLineBg, selectionBg, findMatchBg, findMatchActiveBg, indentGuide                                                |
| `badge`     | bg, fg                                                                                                                                                  |
| `scrollbar` | track, thumb                                                                                                                                            |
| `terminal`  | fg, bg, cursor, selectionBg, and the 16 ANSI colors (`black` … `brightWhite`)                                                                           |

Tints (diff lines, selection, find matches, hover) are derived with `blend()` from palette
colors over the canvas, so they stay subtle on every theme instead of being loud blocks.

## Contrast policy

Enforced for every theme by `tests/themes/contrast.test.ts` from the table in `contrast.ts`
(WCAG 2.x ratios; AA themes / the AAA High Contrast theme):

- Body text on every background: 4.5 / 7. Secondary (muted) text: 4.5 / 7.
- Hints and placeholders (`fg.subtle`): 3 / 4.5.
- Selected, hovered and inactive-selected rows, badges, on-accent text: 4.5 / 7.
- Accent, focus, status and git colors on base and surface: 3 / 4.5.
- Diff text and +/- colors on their line and word tints, hunk headers: 4.5 / 7.
- Syntax colors on the editor background: **4.5** / 7 (stricter than the 3:1 minimum), and
  3 / 4.5 on the cursor-line tint.
- **Comments: 3.5 / 4.5.** Deliberately the quietest syntax color, still comfortably readable.
- **Inactive line numbers: 2.5 / 4.5.** Deliberately quiet reference marks; the active line
  number meets 4.5 / 7.
- Terminal: text 4.5 / 7, ANSI colors 3 / 4.5, ANSI 8 (used for autosuggestions) 2 / 4.5.
- Decorative: control borders 1.3 / 4.5, dividers 1.15 / 3, scrollbar thumb 1.8 / 3.

Measured key pairs (default accent):

| Pair                            | Catppuccin Mocha     | Tokyo Night          | Gruvbox Dark         | High Contrast         |
| ------------------------------- | -------------------- | -------------------- | -------------------- | --------------------- |
| text on base / surface / raised | 11.34 / 12.14 / 8.69 | 10.59 / 11.14 / 8.32 | 10.75 / 11.95 / 8.45 | 19.80 / 21.00 / 17.04 |
| muted on base / surface         | 7.37 / 7.89          | 8.10 / 8.52          | 6.77 / 7.53          | 17.37 / 18.43         |
| subtle on base                  | 4.44                 | 4.10                 | 4.02                 | 10.77                 |
| selected text                   | 6.87                 | 6.86                 | 8.56                 | 9.77                  |
| accent on base                  | 7.79                 | 6.79                 | 5.48                 | 9.81                  |
| comment / inactive line number  | 5.81 / 3.36          | 4.10 / 2.61          | 4.02 / 3.03          | 8.13 / 8.13           |

| Pair                            | Dracula              | Nord                | One Dark           | Rosé Pine             |
| ------------------------------- | -------------------- | ------------------- | ------------------ | --------------------- |
| text on base / surface / raised | 13.36 / 14.81 / 8.59 | 9.25 / 10.36 / 7.45 | 6.57 / 7.22 / 4.58 | 13.39 / 14.04 / 11.51 |
| muted on base / surface         | 7.66 / 8.49          | 6.34 / 7.10         | 5.65 / 6.21        | 5.48 / 5.75           |
| subtle on base                  | 3.56                 | 3.51                | 3.73               | 3.76                  |
| selected text                   | 8.57                 | 6.61                | 4.54               | 8.04                  |
| accent on base                  | 5.90                 | 6.24                | 5.92               | 10.45                 |
| comment / inactive line number  | 3.56 / 3.03          | 3.51 / 2.50         | 3.73 / 2.70        | 3.76 / 3.42           |

| Pair                            | Kanagawa Wave        | Everforest Dark    | GitHub Dark           | Solarized Dark     |
| ------------------------------- | -------------------- | ------------------ | --------------------- | ------------------ |
| text on base / surface / raised | 11.26 / 12.16 / 9.75 | 7.38 / 8.62 / 5.57 | 16.02 / 14.64 / 12.88 | 5.61 / 6.22 / 4.86 |
| muted on base / surface         | 8.89 / 9.59          | 5.12 / 5.97        | 6.15 / 5.62           | 4.75 / 5.26        |
| subtle on base                  | 3.52                 | 3.84               | 4.12                  | 3.52               |
| selected text                   | 7.44                 | 4.56               | 11.85                 | 9.53               |
| accent on base                  | 5.94                 | 6.23               | 5.05                  | 4.68               |
| comment / inactive line number  | 3.52 / 2.52          | 3.84 / 3.21        | 6.15 / 4.12           | 3.52 / 2.79        |

## Palette adjustments (documented in each theme file)

- Tokyo Night: `comment` (#565f89, 2.6:1) fails the comment floor, so comments use `dark5`
  (#737aa2). `terminal_black` (#414868, 1.9:1) is too dim for ANSI 8 and the scrollbar
  thumb, so both use `dark3` (#545c7e).
- Gruvbox Dark: bright red (#fb4934) is 4.3:1 on bg0, so keywords and removed-line text
  use it lightened just enough to reach 4.5:1. Neutral red (#cc241d, 2.7:1) is too dark for
  ANSI 1, which uses the bright red.
- Dracula: `comment` (#6272a4, 3.0:1) is lightened to #6f7eac for comments and hints;
  removed diff text uses red lightened to #ff7676 on its tint.
- Nord: comments use the brightened nord3 (#616e88) of Nord's editor ports, lightened again
  to #7e889d (3.5:1); line numbers #637089 (2.5:1); ANSI 8 and the scrollbar thumb use
  #616e88 instead of nord3; numbers use nord15 lightened to #b590af; removed diff text uses
  nord11 lightened to #d5999e. Chrome and canvas are nord0 darkened.
- One Dark: comments use One Dark Pro's #7f848e; line numbers the gutter step #636d83; red
  is lightened to #e17078 for code and #e68990 for removed diff text.
- Rosé Pine: comments and hints use `muted` lightened to #74718b; keywords and links use
  `pine` lightened to #4f889f. Chrome and canvas are `base` darkened.
- Kanagawa Wave: comments use `fujiGray` lightened to #75756d; line numbers `sumiInk6`
  lightened to #5c5c73.
- Everforest Dark: diff text on its own `bg_green` / `bg_red` uses green #afc78c and red
  #ec9c9d. The canvas is `bg_dim` darkened.
- GitHub Dark: Markdown headings use #1f6feb lightened to #2c78ec; text on the accent is
  dark because white on #2f81f7 is 3.9:1.
- Solarized Dark (deliberately low contrast, the most adjustments): body text is base1,
  secondary text base0; comments base01 lightened to #6a7e84; blue, violet, magenta, orange
  and red are lightened just to 4.5:1 for code; ignored files use base00; ANSI 8 uses base01
  (canonically base03, the background itself) and ANSI 10 base01 lightened to 3:1.
- Diff word tints use 15–24 % opacity so colored diff text stays at 4.5:1 on them.

## Accent override

`withAccent(theme, accent)` takes `"default"`, a named accent (`blue`, `purple`, `green`,
`yellow`, `orange`, `red`, `teal`, each mapped to the theme's own palette) or `#rrggbb`. It
rebuilds the theme so focus, selection tints, badge and on-accent text follow the accent,
then guards contrast: the accent is moved toward white/black until it reaches 3:1 (4.5:1
for AAA) on base and surface, selection tints are reduced until selected text keeps 4.5:1
(7:1), and on-accent text flips between dark and light.

## Color modes

`detectColorMode(env)` reads only `NO_COLOR`, `COLORTERM` and `TERM` (no per-application
special cases): `COLORTERM=truecolor|24bit` or a `*-direct` TERM give truecolor, a
`*256color*` TERM gives 256, anything else 16. **`NO_COLOR`** (non-empty) selects the
16-color mode, so the user's own terminal palette decides every color; a full-screen UI
cannot drop color entirely without losing selection and diff states. An explicit
`ui.color_mode` in the config wins over `NO_COLOR`.

`resolveTheme(theme, mode)` maps tokens to xterm-256 indices 16–255 (fixed values, so the
contrast floors still hold) or ANSI 0–15 (hue family first, then normal/bright by lightness;
text and surfaces stay on the grey ramp; terminal palette tokens map to their own index;
success/added and error/deleted/removed and warning/modified use the conventional green,
red and yellow families so they never merge).
In 16-color mode the canvas family (`bg.canvas`, `bg.base`, `bg.surface`, `bg.inset`,
`editor.bg`, `terminal.bg`) of a dark theme is pinned to ANSI 0 and body text to ANSI 7/15,
because the terminal's own colors stand in for them; matching by lightness alone would send
a mid-dark base such as Nord's to ANSI 8.
Guards then keep important pairs apart: selection and find-match backgrounds never vanish
into the canvas, and text never lands on its own background.

## Icons

`icons.ts` has three tiers. `nerd`: Nerd Fonts codepoints (BMP Private Use Area; codicons
for UI, Seti/Devicons/Font Awesome for file types). `unicode`: BMP symbols with East Asian
Width "neutral" and no emoji presentation, so they are one cell in every terminal. `ascii`.
`ui.icons = "auto"` never picks `nerd` (fonts cannot be detected); it uses `ascii` on the
Linux console and non-UTF-8 locales, `unicode` otherwise. File icon colors are tokens.

## Palette sources and licenses

The palettes are used as published; the token mapping is original to Lucy. No theme files
were copied. To be merged into THIRD_PARTY_NOTICES (verify the license texts before release;
they were recorded offline):

**Unverified (recorded from memory, no network access when added):** all license holders and
URLs of the eight themes from Dracula to Solarized Dark; Nord's repository moved from
arcticicestudio to nordtheme, so the copyright line may differ; GitHub Dark values are from
the 2023 Primer dark scale (`fg.default` #e6edf3, `fg.muted` replaced by the older #8b949e,
which is also its comment color) and later Primer versions changed some values; the One Dark
UI steps #21252b, #181a1f, #9da5b4 and #636d83 are recalled from Atom's one-dark-ui and
syntax packages; Everforest and Kanagawa values are the "medium" and "wave" variants as
published in their palette tables. Compare each palette against its source before release.

| Theme                | Source                                                                                                                                                    | License                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Catppuccin Mocha     | Catppuccin palette, github.com/catppuccin/palette                                                                                                         | MIT, © Catppuccin                             |
| Tokyo Night          | github.com/enkia/tokyo-night-vscode-theme (original palette); "night" values as in github.com/folke/tokyonight.nvim                                       | MIT (enkia); Apache-2.0 (folke)               |
| Gruvbox Dark         | github.com/morhetz/gruvbox                                                                                                                                | MIT, © Pavel Pertsev                          |
| Dracula              | Dracula specification, draculatheme.com/spec (github.com/dracula/dracula-theme)                                                                           | MIT, © Dracula Theme                          |
| Nord                 | Nord palette, nordtheme.com (github.com/nordtheme/nord); comment color #616e88 from github.com/nordtheme/visual-studio-code                               | MIT, © Arctic Ice Studio & Sven Greb          |
| One Dark             | Atom's One Dark UI and syntax themes, github.com/atom/atom (packages/one-dark-ui, one-dark-syntax); comment #7f848e from github.com/Binaryify/OneDark-Pro | MIT, © GitHub Inc. (Atom); MIT (One Dark Pro) |
| Rosé Pine            | Rosé Pine palette, rosepinetheme.com (github.com/rose-pine/rose-pine-theme)                                                                               | MIT, © Rosé Pine                              |
| Kanagawa Wave        | github.com/rebelot/kanagawa.nvim                                                                                                                          | MIT, © Tommaso Laurenzi                       |
| Everforest Dark      | github.com/sainnhe/everforest (palette documentation)                                                                                                     | MIT, © sainnhe                                |
| GitHub Dark          | Primer primitives, github.com/primer/primitives; github.com/primer/github-vscode-theme ("Dark Default")                                                   | MIT, © GitHub Inc.                            |
| Solarized Dark       | Solarized, ethanschoonover.com/solarized (github.com/altercation/solarized)                                                                               | MIT, © Ethan Schoonover                       |
| High Contrast        | Original to Lucy                                                                                                                                          | Project license                               |
| Nerd Font codepoints | github.com/ryanoasis/nerd-fonts (codepoint assignments only, no font files)                                                                               | MIT                                           |
