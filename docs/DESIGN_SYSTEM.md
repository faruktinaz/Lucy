# Design system

How Lucy looks and why, and the components every view is built from. The code is in
`src/ui`; open "Developer: Show Component Gallery" in the app to see every primitive in every
state with the live theme.

## 1. Principles

- **Islands, not blocks.** The window background is `bg.canvas`. The sidebar, the editor
  area, the agent panel and the bottom panel are separate filled cards floating on it, one
  column apart, with softened corners. The bars (command bar, status bar) sit directly on the
  canvas. No line grids: the cards are told apart by their fills (High Contrast adds a thin
  rounded outline, so shape never depends on color).
- **Pills instead of bars.** Highlights are shapes with rounded ends, inset from the card
  edge: the selected row, tabs, buttons, badges, key hints, text fields, the search field.
- **Built around the loop.** Run the agent, see what it changed, review, make small edits,
  commit. Defaults and the Welcome view lead with that loop (section 5).
- **Restrained color.** Text is default, muted or subtle. The accent marks focus and the
  active item; status colors mark real states. Nothing is colored for decoration.
- **Quiet chrome.** Command bar, status bar and headers use muted text; only key facts (the
  workspace name, the branch) use the default color.
- **Obvious states.** Hover, focus, selection (focused and unfocused list), pressed and
  disabled look different everywhere, the same way everywhere.
- **Keyboard first, mouse complete.** Every action has a command and, where it matters, a
  chord that works in a legacy terminal; everything is also clickable.
- **Honest.** Anything visible works, or says plainly that it is not available yet
  (`placeholderView`, `placeholderEditor`).
- **Calm feedback.** Short sentences, no exclamation marks, delayed spinners, errors that say
  what happened and what to do.

## 2. Tokens

Components read colors only from the theme: `const theme = useTheme(); theme.colors.fg.muted`.
The token table and the role of every token is `TOKEN_DEFINITIONS` in `src/themes/tokens.ts`
(see also `src/themes/README.md`).

Rules:

- No hex literals under `src/ui` or `src/features`, and no `RGBA.fromHex`/`fromInts` outside
  `src/ui/theme/ui-theme.ts`. Enforced by `tests/ui/containment-restore.test.tsx`; another test
  checks that every color on the first screen belongs to the active theme.
- `colorOf(theme, "git.added")` turns a `TokenPath` (file-icon colors, git status) into a
  color. `withAlpha(color, alpha)` makes the dimmed overlay backdrop; palette colors stay
  opaque, so 256- and 16-color modes get no dimming.
- `UiTheme` (`src/ui/theme/ui-theme.ts`) is resolved once per change by `ThemeService`: theme
  plus accent (`ui.accent`), mapped to the color mode (`ui.colorMode`, detected from
  `COLORTERM`/`TERM`/`NO_COLOR`). In 256- and 16-color modes `colors.*` are palette-indexed
  (`RGBA.fromIndex`), so the user's terminal palette decides in 16-color mode. `hex` holds the
  resolved hex values, `terminal` the palette for embedded terminals, `syntaxStyle` the OpenTUI
  `SyntaxStyle` built from `STYLE_GROUPS` (rebuilt on change; the previous one is destroyed one
  generation late).
- `UiTheme` also carries `icons` (tier), `density`, `animations` and `highContrast`.

High Contrast never relies on color alone (`theme.highContrast` is true for AAA themes):

| Element | Extra cue in High Contrast |
| --- | --- |
| Selected list row | a `▌` marker in the first column |
| Panel titles | always bold; the focused one is bold and accent |
| Active editor tab / panel tab | bold / underlined |
| View switcher | the active view's name is bold |
| Cards | a thin rounded `border.subtle` outline (instead of half-block lips), overlays a `border.default` keyline |
| Text fields | a `▏ ▕` keyline in the padding cells (`border.default`, `border.focus` when focused) |
| Buttons | focus is bold and underlined in every theme |
| Pending key sequence | the hint text is bold |

### Surfaces

| Region | Fill | Text |
| --- | --- | --- |
| Window background, command bar, status bar, gaps between cards | `bg.canvas` (`theme.shell.canvas`) | muted; key facts default |
| Sidebar, agent panel, bottom panel cards | `bg.surface` (`theme.shell.panel`) | muted; key facts default |
| Editor card (tab strip, breadcrumb, editor view, Welcome) | `bg.base` (`theme.shell.editor`) | default; breadcrumb subtle |
| Active tab, switcher pill, search pill, key hints, ghost buttons, toasts | `bg.raised` | subtle / muted / default |
| Text fields | `bg.inset` pill | default, placeholder subtle |
| Quick pick, dialogs, menus | `bg.overlay` card with lips and a soft shadow (`theme.shell.shadow`) | default |

`theme.shell` (`ShellColors` in `src/ui/theme/ui-theme.ts`) is derived from the tokens once per
theme change: when a theme's chrome token is almost the canvas color (contrast below 1.06),
the card fill is lifted toward `bg.raised` so the island still reads; in 256/16-color modes
the tokens are used as they are.
| Modal backdrop | `bg.inset` at alpha 0.55 (truecolor only) | |
| Hover / pressed | `state.hover` / `state.active` | default |
| Selected row: list focused / unfocused | `state.selectedBg` / `state.selectedInactiveBg` | `state.selectedFg` / default |

### Text hierarchy

`Label` renders one `<text>`; `Span` styles a run inside it.

| Variant | Tone | Weight | Use |
| --- | --- | --- | --- |
| `body` | default | regular | content |
| `title` | default | bold | dialog titles, empty-state titles |
| `secondary` | muted | regular | descriptions, paths beside names |
| `hint` | subtle | regular | placeholders, keybinding labels |
| `section` | muted | bold, UPPERCASE | small section titles only |

`TextTone`: `default`, `muted`, `subtle`, `disabled`, `accent`, `success`, `warning`, `error`,
`info`, `onAccent`, `selected` (`toneColor(theme, tone)`). Italic only for preview tabs and
quiet annotations. `attrs({ bold, italic, underline, dim, strikethrough })` builds OpenTUI
attribute bits.

## 3. Spacing and sizes

`src/ui/tokens/spacing.ts`. All values are terminal cells.

`SPACE = { none: 0, xs: 1, sm: 2, md: 3, lg: 4 }`.

`SIZE`: `commandBarHeight` 1, `statusBarHeight` 1, `tabStripHeight` 1, `panelHeaderHeight` 1,
`activityBarWidth` 4 (unused since the view switcher replaced the activity bar), `treeIndent` 2, `toastWidth` 46, `maxToasts` 3, `dialogWidth` 58,
`quickPickWidth` 84, `quickPickMaxRows` 12, `menuMinWidth` 26.

Density (`ui.density`, `useDensity()`) changes padding and gaps, never structure:

| `DensityMetrics` | comfortable | compact |
| --- | --- | --- |
| `rowPaddingX` (rows and headers in panels) | 1 | 1 |
| `sectionGap` (blank rows between sections) | 1 | 0 |
| `overlayPaddingX` / `overlayPaddingY` | 2 / 1 | 1 / 0 |
| `tabPaddingX` | 2 | 1 |
| `statusGap` | 2 | 1 |
| `emptyStateTop` | 2 | 1 |

Alignment: panel headers, rows and empty states share the same left edge (`rowPaddingX`
from the panel edge); the last column of a panel is padding, which is where scrollbars and
resize handles sit.

## 4. Components

### Shapes (`src/ui/primitives/shape.tsx`)

A cell is a hard rectangle; softness comes from glyphs that fill part of a cell in the
shape's color over whatever is behind it.

| Shape | rounded + nerd icons | rounded, no Nerd Font | `ui.cornerStyle = "square"` |
| --- | --- | --- | --- |
| Card (`Card`, `CardLip`) | half-block lips `▄`/`▀` top and bottom with quadrant corners `▗ ▖ ▝ ▘` | same (block elements need no special font) | lips without the corner notch |
| Pill ends (`CapCell`, `CapSpan`, `Pill`) | Nerd Font half circles U+E0B6 / U+E0B4 | half blocks `▐` / `▌` (slim ends) | a plain cell of the pill color |

The lips make every card start and end half a row inside its cell, so stacked cards (editor
over bottom panel) show half a row of canvas between them, matching the one-column gap beside
them. The thin-line alternative (a rounded `border.subtle` outline) was compared on real
renders: it costs a column on each side and reads as the classic boxed-pane TUI, so it is
used only for High Contrast. `theme.roundCaps` and `theme.cornerStyle` switch live with the
`ui.cornerStyle` and `ui.icons` settings. `RowFrame` (from `list.tsx`) gives any row the list
row's inset pill shape.

All in `src/ui/primitives` unless noted. States are default / hover / focused / selected /
selected-unfocused / pressed / disabled where they apply.

| Component | States and behaviour | Example |
| --- | --- | --- |
| `Label`, `Span` | tones and variants above | `<Label variant="secondary">3 files</Label>` |
| `Icon`, `FileIcon` | tier from `ui.icons`; always followed by a space (`space={false}` only in fixed cells); file icons use their token color | `<Label><Icon name="branch" />main</Label>` |
| `Badge`, `CountLabel`, `formatCount` | filled pill for attention; quiet number for headers; `99+`, `1k` | `<CountLabel count={12} />` |
| `KeyHint`, `formatKeys` | subtle `Ctrl+K E`; `command` looks up the current binding | `<KeyHint command="file.quickOpen" />` |
| `Button` | `primary`/`ghost`/`danger`; hover bold (ghost: `state.hover`), pressed `state.active`, focused bold+underline (ghost: selection tint), disabled; colors from `buttonColors(theme, variant, state)` | `<Button label="Commit" variant="primary" onPress={...} />` |
| `IconButton` | subtle until hovered; `active` for toggles that are on; disabled | `<IconButton icon="refresh" hint={{ text: "Refresh" }} onPress={...} />` |
| `TextField`, `TextAreaField` | inset field, placeholder, leading icon (accent when focused, error when `invalid`); `TextFieldHandle` (`focus`, `value`, `setValue`); Alt+Enter submits a textarea | `<TextField icon="search" placeholder="Search" focused onInput={setQuery} />` |
| `List<T>` | virtualized window keyed by slot index; `renderRow(item, ListRowState)`; Up/Down or j/k, Home/End, PageUp/PageDown, Enter activates (via `useKeyHandler`); click selects, double-click activates (`activateOnClick` for single click), right click `onContextMenu`, wheel scrolls (`wheelStep`); keeps the selection visible (`scrollToReveal`); `rowBackground(theme, state)` gives the row fill; optional scrollbar | see below |
| `TreeRowContent`, `TreeIndent`, `Chevron`, `treeIndent` | 2 cells per depth, quiet `│` guides, chevron or blank, icon, truncated label, subtle description, right-aligned status letter, `dimmed`, `strikethrough` | inside `renderRow` |
| `PanelHeader` | uppercase muted title, accent when focused; `detail`; icon actions right-aligned | `<PanelHeader title="Explorer" focused={useZoneFocused()} actions={...} />` |
| `SectionHeader` | collapsible; chevron, bold uppercase title, count; actions only on hover or focus; selected states | `<SectionHeader title="Changes" expanded count={5} onToggle={...} />` |
| `Tabs` | `editor`: active tab on `bg.base`, others muted, fixed 2-cell slot for dirty dot or close (close on hover and on the active clean tab), italic preview; `panel`: uppercase, active bold; overflow hides tabs outside a window around the active one and shows `+N` (`onOverflow`); `visibleTabRange`, `tabWidth` | `<Tabs items={...} activeId={id} width={w} onSelect={...} />` |
| `Scrollbar`, `scrollbarThumb` | thumb only, a one-eighth block in `scrollbar.thumb` over the last column | used by `List` |
| `ResizeHandle`, `useDragResize` | invisible until hovered; thin accent line while hovered or dragging; drag capture | `<ResizeHandle edge="right" size={...} onResize={...} />` |
| `Spinner`, `useDelayedFlag` | appears after `SPINNER_DELAY_MS` (300 ms); braille frames, static with `ui.animations` off | `<Label><Spinner label="Indexing files" /></Label>` |
| `EmptyState`, `ErrorState` | title, one muted sentence, actions with real keybindings (`StateAction`: `command` or `onPress`, `keys`) | `<EmptyState title="No changes" description="..." actions={[{ label: "Commit history", command: "git.log" }]} />` |
| `PanelBoundary` | error boundary per view: "X stopped working", the message, Retry remounts | wraps every view in the shell |
| `HighlightedText`, `highlightRuns` | matched characters in accent and bold | `<HighlightedText text={label} positions={match.positions} color={...} />` |
| `usePointer` | click, double-click (`DOUBLE_CLICK_MS` 400), context click, hover, pressed; the innermost handler claims a click; `hint` shows in the status bar | `const p = usePointer({ onClick }); <box {...p.props} />` |
| `useMeasure` | size after layout through `onSizeChange` | `const { size, onSizeChange } = useMeasure()` |

```tsx
<List
  items={rows}
  selectedIndex={selected}
  focused={useZoneFocused()}
  onSelect={setSelected}
  onActivate={(index) => open(rows[index])}
  renderRow={(row, state) => (
    <TreeRowContent depth={row.depth} expandable={row.dir} expanded={row.open}
      icon={<FileIcon name={row.name} kind={row.dir ? "directory" : "file"} />}
      label={row.name} status={row.letter} statusColor={theme.colors.git.modified} state={state} />
  )}
/>
```

Overlays (`src/ui/overlays`), all rendered once by `OverlayHost` at the root:

| Component | Notes |
| --- | --- |
| `OverlayFrame` | the card: `bg.overlay` fill with a rounded `border.default` keyline and optional title |
| `QuickPickOverlay` | below the command bar, centered, at most 84 wide and 12 rows; search icon and input; fuzzy highlights; descriptions subtle; keybinding or group label on the right; footer with key hints |
| `DialogOverlay` | centered at 28 % height, 58 wide; bold title (warning icon when `danger`), muted message, prompt input with error line, buttons right-aligned; safe action focused first |
| `MenuPanel`, `MenuOverlay`, `menuWidth` | items with optional icon and right-aligned keybinding; separators; disabled and danger items; flips to stay on screen |
| `ToastCard`, `ToastStack` | bottom right above the status bar, `bg.raised`, a thin status-colored `▎` edge, bold title, muted message, actions; close on hover; at most three |
| `OverlayHost` | the modal backdrop (click closes the top overlay), quick pick, dialog, menu, toasts |

Placeholders (`src/ui/shell/placeholders.tsx`): `placeholderView({ title, description,
actions, details })` and `placeholderEditor({ description, actions, details })` for features
that are not built yet. `details` may be a live `Readable` (the Source Control stub shows real
Git state).

## 5. Layout

### Anatomy

```
  orbit  demo          ( ⌕ Search files and commands   Ctrl+P )          ◧ ⬓ ◨  ⊞ ⚙   command bar (canvas)
 ▗▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▖ ▗▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▖ ▗▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▖   card lips (soft corners)
   ⧉ ⌕ (⑂ Changes) ✦  ✓ ⋯ ( README.md ) main.ts ●       Claude Code   + ×   switcher | pill tabs | panel header
   ▾ STAGED  4           src › main.ts
   ( TS main.ts      M ) editor view                    agent view           selected row = inset pill
 ▝▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▘ ▝▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▘ ▝▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▘
  ⎇ main ⇡1 ◉ 11         hint area                 TypeScript   Catppuccin Mocha    status bar (canvas)
```

(`( )` marks pill ends in this sketch.)

- **Command bar** (1 row, on the canvas): workspace name (bold; `demo` tag in demo mode), a
  centered search pill that opens Quick Open and shows its keybinding, layout toggles, then
  Integrations and Settings (they used to live in the activity bar).
- **View switcher** (the sidebar card's header; there is no activity bar): the active view as
  a pill with icon and short name (Files, Search, Changes, Sessions), the others as icons with
  their count; hover hints give the full names and keybindings. Views with `order >= 90`
  (Integrations) are utilities, reached from the command bar and the palette. The view's
  actions sit on the right; those that do not fit go into a `⋯` menu. `layout.showActivityBar`
  now shows or hides the switcher.
- **Sidebar card**: the switcher, then the active view; every view stays mounted. A resize
  handle sits on its inner edge.
- **Editor card**: pill tab strip, breadcrumb (subtle path, last segment muted), then the
  active tab's editor view; the Welcome view when nothing is open: `lucy`, one line on what
  Lucy is, the workspace, then the loop: Start Claude Code (accent), Review changes (with the
  count from the Source Control view), Open a file, Search, All commands, each with a key pill.
- **Auxiliary panel** (right; left when the sidebar is on the right): header with the view
  title and a close button; stays mounted while hidden.
- **Bottom panel** (under the editor column): panel tabs, maximize/restore and close; the
  header row is the drag handle; stays mounted while hidden.
- **Status bar**: left items, the hint area (pending key sequence, the armed leader, short
  messages, hover hints), right items.

### Default layout (no saved layout)

`applyReviewFirstLayout` (`src/app/workbench/layout-defaults.ts`) runs only when nothing was
restored: the agent panel opens beside the editor when the terminal is at least 120 columns
wide (the sidebar stays the preferred side when it narrows), and the sidebar switches to
Changes as soon as Git reports changes (unless the user picked a view first); otherwise it
stays on Files. A saved layout is restored exactly as before.

### Responsive rules

`computeEffectiveLayout` (`src/app/workbench/layout-compute.ts`) turns what the user asked for
(`LayoutState`) into what fits (`EffectiveLayout`). `LAYOUT_LIMITS`:

| Rule | Value |
| --- | --- |
| Too small: friendly screen instead of the workbench (which stays mounted) | below 60 × 16 |
| Wide: sidebar, editor and auxiliary panel coexist | 110 columns and more |
| Medium: one side region beside the editor (the focused one, else the last opened); the other comes back when the terminal grows | 80 to 109 |
| Narrow: a side region opens as a full-width drawer while it has focus; Escape or focusing the editor closes it; the search pill collapses to an icon; status items drop by priority | below 80 |
| Short: the bottom panel is maximized or hidden, the command bar hides | below 24 rows |
| Zen: only the editor (no bars) | `view.toggleZenMode` |
| Editor minimum width | `max(40, 40 % of the width)`; the auxiliary panel shrinks first, then the sidebar, then one side hides |
| Side widths | sidebar 16 to `min(80, 40 %)`, auxiliary 30 to `min(200, 40 %)`; defaults from `layout.sidebarWidth`, `layout.aiPanelWidth` |
| Bottom height | 4 to `min(60, content height - 6)`; default `layout.bottomPanelHeight` |

## 6. Make it look its best

Lucy draws with the terminal's font and cell grid; it cannot change either, and it never
edits terminal configuration. These terminal settings make the cards and pills look softer
and less cramped. Ghostty (`~/.config/ghostty/config`):

```
font-family = "JetBrainsMono Nerd Font"   # a Nerd Font gives round pill ends and file icons
font-size = 14
adjust-cell-height = 20%                  # more line height: rows breathe, half-block lips look finer
window-padding-x = 12                     # space between the window edge and the canvas
window-padding-y = 10
window-padding-balance = true
window-padding-color = extend             # padding takes the canvas color, so cards float on it
cursor-style-blink = false
```

Then set `ui.icons = "nerd"` in Lucy's settings. Kitty: `modify_font cell_height 120%` and
`window_padding_width 10`; WezTerm: `line_height = 1.2` and `window_padding`. Any terminal:
pick a font with good box-drawing and block glyphs (most programming fonts), and avoid
letter-spacing tweaks, which break the cell grid.

## 7. Icons

Three tiers in `src/themes/icons.ts` (`UI_ICONS`, `icon(name, tier)`, `iconForFile`):

- `nerd`: Nerd Font private-use glyphs (codicons for UI, Seti/Devicons/Font Awesome for file
  types). Every code point was checked against the glyph names inside JetBrainsMono Nerd Font
  and looked at in a rendered screenshot.
- `unicode`: narrow BMP symbols; the default.
- `ascii`: printable ASCII for the Linux console and non-UTF-8 locales.

`ui.icons = "auto"` never picks `nerd` (fonts cannot be detected); users opt in. Screenshots
use `nerd` because the renderer draws with JetBrainsMono Nerd Font.

Adding an icon: add the name to `IconName` and all three tables. Build the nerd glyph with
`nf(0xeb37)` (`String.fromCodePoint`): formatters rewrite `\u` escapes into invisible literal
characters. `tests/themes/icons.test.ts` requires the unicode and ascii glyphs to be exactly
one cell, not East Asian ambiguous, not emoji-capable, and the same names in every tier.
Structural glyphs outside the icon set (`▎ ▕ ─ │`, box corners) are East Asian ambiguous;
they are used only for edges and keylines.

## 8. Motion

Only the spinner moves: it appears after 300 ms (so fast work never flashes) and turns static
with `ui.animations = false`. No transitions, no blinking.

## 9. Do and don't

| Do | Don't |
| --- | --- |
| Use `useTheme().colors.*` tokens | Write hex colors or build `RGBA` values |
| Use `Label` variants for hierarchy | Add colors to make something stand out |
| Show actions with their real keybindings (`KeyHint command=...`) | Hard-code key labels |
| Truncate with the helpers in `src/core/text.ts`; sanitize repository text with `sanitizeForDisplay` | Let a long or Turkish name push a row out of alignment |
| Keep terminals and other stateful views mounted; toggle `visible` | Unmount a view to hide it |
| Use `List` for anything that can grow | Mount thousands of rows |
| Say "not available yet" for unbuilt features | Show buttons that do nothing |
| Put row padding in the outer cells and align to the header's left edge | Start content in column 0 of a panel |
| Use `usePointer` for clicks | Treat the `up` after a drag as a click |

## 10. Screenshots

`bun run screenshots` renders every scenario against the demo workspace (real, isolated Git
state) with the Nerd Font tier and writes
`docs/screenshots/<theme>/<scenario>-<cols>x<rows>.{png,svg,txt}`. Defaults: Catppuccin
Mocha and High Contrast at 120x35, 90x28 and 70x24; scenarios can choose their own themes and
sizes. Flags: `--only a,b`, `--theme <id>`, `--no-png` (no browser needed), `--out <dir>`. PNGs
need a Chromium-family browser (`LUCY_SCREENSHOT_BROWSER` overrides discovery).

Built-in scenarios: `shell`, `shell-compact`, `shell-square`, `shell-unicode-icons`, `workbench`,
`command-palette`, `quick-open`, `theme-picker`, `confirm-dialog`, `toast`, `context-menu`,
`zen`, `narrow-drawer`, `gallery`. Add yours in
`scripts/scenarios/` (see `docs/ARCHITECTURE.md` §3.10).

Review checklist, for every new view, in Catppuccin Mocha and High Contrast, at 120x35, 90x28
and 70x24:

- Alignment to the cell: content shares the header's left edge; right-aligned columns line up.
- Rhythm: one blank row between sections in comfortable density, none in compact.
- Hierarchy: one bold thing per region at most; secondary text muted, tertiary subtle.
- States: hover, focus, selection with and without list focus, disabled; High Contrast cues.
- Truncation: long names, Turkish names (`çalışma-notları.md`, `İçerik.ts`), narrow widths.
- Noise: nothing colored without a reason; no stray lines in the main layout.
- Keyboard: every action reachable; labels match `keybindingLabel`.
