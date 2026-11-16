# Design system

How Lucy looks and why, and the components every view is built from. The code is in
`src/ui`; open "Developer: Show Component Gallery" in the app to see every primitive in every
state with the live theme.

## 1. Principles

- **Structure by color blocks, not lines.** Chrome sits on `bg.surface`, the editor canvas on
  `bg.base`; regions are told apart by those two fills. The main layout has no border lines.
  Borders (rounded, `border.default`) are reserved for floating overlays.
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
| Activity bar | the active icon is bold (all themes also show an edge marker) |
| Region edges | the sidebar and auxiliary panel resize handles stay drawn as a thin `border.subtle` line |
| Text fields | a `▏ ▕` keyline in the padding cells (`border.default`, `border.focus` when focused) |
| Buttons | focus is bold and underlined in every theme |
| Pending key sequence | the hint text is bold |

### Surfaces

| Region | Fill | Text |
| --- | --- | --- |
| Command bar, sidebar, tab strip, auxiliary panel, bottom panel, status bar | `bg.surface` | muted; key facts default |
| Activity bar (a column of its own, apart from the sidebar) | `bg.inset` | subtle; active default |
| Editor canvas, active tab, breadcrumb, Welcome | `bg.base` | default; breadcrumb subtle |
| Search pill, ghost buttons, toasts | `bg.raised` | subtle / muted / default |
| Text inputs | `bg.inset` | default, placeholder subtle |
| Quick pick, dialogs, menus | `bg.overlay` with a rounded `border.default` keyline | default |
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
`activityBarWidth` 4, `treeIndent` 2, `toastWidth` 46, `maxToasts` 3, `dialogWidth` 58,
`quickPickWidth` 84, `quickPickMaxRows` 12, `menuMinWidth` 26.

Density (`ui.density`, `useDensity()`) changes padding and gaps, never structure:

| `DensityMetrics` | comfortable | compact |
| --- | --- | --- |
| `rowPaddingX` (rows and headers in panels) | 1 | 1 |
| `sectionGap` (blank rows between sections; activity bar badge row) | 1 | 0 |
| `overlayPaddingX` / `overlayPaddingY` | 2 / 1 | 1 / 0 |
| `tabPaddingX` | 2 | 1 |
| `statusGap` | 2 | 1 |
| `emptyStateTop` | 2 | 1 |

Alignment: panel headers, rows and empty states share the same left edge (`rowPaddingX`
from the panel edge); the last column of a panel is padding, which is where scrollbars and
resize handles sit.

## 4. Components

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
 orbit  demo            ⌕ Search files and commands     Ctrl+P             ◧ ⬓ ◨   command bar (surface)
▎⧉  EXPLORER          │ README.md  main.ts ×                    │ CLAUDE CODE   ×    tab strip (surface), active tab (base)
                      │ src › main.ts                           │                    breadcrumb (base)
 ⌕  rows ...          │ editor view (base)                      │ auxiliary view
 ⑂                    │                                         │
 11                   │ TERMINAL  OUTPUT                 ⛶ ×    │                    bottom panel header (draggable)
                      │ bottom view                             │
 ❖                    │                                         │
 ⎇ main ⇡1 ◉ 11        hint area                    TypeScript   Catppuccin Mocha     status bar (surface)
```

(The `│` above only marks region edges for this sketch; the real layout has no lines.)

- **Command bar** (1 row): workspace name (default text; `demo` tag in demo mode), a centered
  `bg.raised` pill that opens Quick Open and shows its keybinding, layout toggles on the right
  (sidebar, bottom panel, AI panel; default color when on).
- **Activity bar** (4 columns): one icon per sidebar view; the active view has an accent `▎`
  on the outer edge and a default-colored icon, others are subtle. The bar sits on `bg.inset`,
  so it reads as its own column. In comfortable density each item takes two rows and the
  badge (a `badge.bg` pill) hangs under the icon, starting in the icon's column; compact puts
  it beside the icon. A gear at the bottom opens the preferences menu.
- **Sidebar**: `PanelHeader`, then the active view; every view stays mounted. A resize handle
  sits on its inner edge.
- **Editor area**: tab strip, breadcrumb (subtle path, last segment muted), then the active
  tab's editor view; the Welcome view (`lucy`, workspace name, path, four to six actions with
  their real keybindings) when nothing is open.
- **Auxiliary panel** (right; left when the sidebar is on the right): header with the view
  title and a close button; stays mounted while hidden.
- **Bottom panel** (under the editor column): panel tabs, maximize/restore and close; the
  header row is the drag handle; stays mounted while hidden.
- **Status bar**: left items, the hint area (pending key sequence, the armed leader, short
  messages, hover hints), right items.

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

## 6. Icons

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

## 7. Motion

Only the spinner moves: it appears after 300 ms (so fast work never flashes) and turns static
with `ui.animations = false`. No transitions, no blinking.

## 8. Do and don't

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

## 9. Screenshots

`bun run screenshots` renders every scenario against the demo workspace (real, isolated Git
state) with the Nerd Font tier and writes
`docs/screenshots/<theme>/<scenario>-<cols>x<rows>.{png,svg,txt}`. Defaults: Catppuccin
Mocha and High Contrast at 120x35, 90x28 and 70x24; scenarios can choose their own themes and
sizes. Flags: `--only a,b`, `--theme <id>`, `--no-png` (no browser needed), `--out <dir>`. PNGs
need a Chromium-family browser (`LUCY_SCREENSHOT_BROWSER` overrides discovery).

Built-in scenarios: `shell`, `shell-compact`, `shell-unicode-icons`, `workbench`,
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
