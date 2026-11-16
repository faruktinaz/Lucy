# Themes and design tokens

Components use **semantic tokens only** (`theme.tokens.bg.surface`, `tokens.syntax.keyword`).
Hex literals live only in the four theme files. The token table, with the role of every
token, is `TOKEN_DEFINITIONS` in `tokens.ts`; the `ThemeTokens` type is derived from it.

## Token groups (70 UI tokens + 20 terminal palette entries)

| Group       | Tokens                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bg`        | base, surface, raised, overlay, inset                                                                                                                   |
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

## Palette adjustments (documented in each theme file)

- Tokyo Night: `comment` (#565f89, 2.6:1) fails the comment floor, so comments use `dark5`
  (#737aa2). `terminal_black` (#414868, 1.9:1) is too dim for ANSI 8 and the scrollbar
  thumb, so both use `dark3` (#545c7e).
- Gruvbox Dark: bright red (#fb4934) is 4.3:1 on bg0, so keywords and removed-line text
  use it lightened just enough to reach 4.5:1. Neutral red (#cc241d, 2.7:1) is too dark for
  ANSI 1, which uses the bright red.
- Diff word tints use 20–24 % opacity so colored diff text stays at 4.5:1 on them.

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

| Theme                | Source                                                                                                              | License                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Catppuccin Mocha     | Catppuccin palette, github.com/catppuccin/palette                                                                   | MIT, © Catppuccin               |
| Tokyo Night          | github.com/enkia/tokyo-night-vscode-theme (original palette); "night" values as in github.com/folke/tokyonight.nvim | MIT (enkia); Apache-2.0 (folke) |
| Gruvbox Dark         | github.com/morhetz/gruvbox                                                                                          | MIT, © Pavel Pertsev            |
| High Contrast        | Original to Lucy                                                                                                    | Project license                 |
| Nerd Font codepoints | github.com/ryanoasis/nerd-fonts (codepoint assignments only, no font files)                                         | MIT                             |
