# OpenTUI 0.9.1 notes (verified)

A practical reference for building Lucy Workspace on `@opentui/core` 0.9.1, `@opentui/react` 0.9.1 and React 19, running on
Bun 1.3.14 (macOS arm64).

**How these notes were checked.** Each claim was read in the installed package (`.d.ts` files and the bundled JS in
`node_modules/@opentui/*`) and then exercised by a spike in `spikes/opentui/`. Those spikes run headless with `testRender`
or `createTestRenderer`, or, for startup and shutdown sequences, inside Bun's built-in PTY. Anything not checked this way
is marked **UNVERIFIED**. Where opentui.com (also 0.9.1) was consulted, these notes say so. Spike names appear in
brackets, for example [04-keys-parse].

**Contents:** §1 Bootstrapping · §2 React binding · §3 Layout · §4 Input and focus · §5 Mouse · §6 Text and styling ·
§7 ScrollBox · §8 Code and syntax highlighting · §9 Diff · §10 EmbeddedTerminal · §11 Widgets · §12 Testing ·
§13 Debugging and errors · §14 Packaging · §15 Recommendations · §16 UNVERIFIED items · §17 Spike index

---

## 1. Bootstrapping

[01-pty-driver drives 01-bootstrap-child inside a Bun PTY. The defaults below were read in the constructor source and
confirmed in the PTY.]

| Option | Default | Notes for an IDE |
|---|---|---|
| `screenMode` | `"alternate-screen"` | Also `"main-screen"` and `"split-footer"` (uses `footerHeight` and `externalOutputMode`). Env `OTUI_USE_ALTERNATE_SCREEN` overrides it |
| `useMouse` | `true` | Enables `?1000h ?1002h ?1006h` (SGR mouse, button and drag tracking) |
| `enableMouseMovement` | **`true`** | Adds `?1003h`, so every pointer move is reported (hover). With `false`, drag still works |
| `useKittyKeyboard` | **`{}`, i.e. flags 5** (disambiguate 1 + alternateKeys 4) | **The kitty protocol is on by default.** `{events:true}` gives 7 (adds release and repeat); all options give 31 |
| `exitOnCtrlC` | `true` | Ctrl+C calls `destroy()`. **An IDE should set `false`** and bind Ctrl+C itself |
| `exitSignals` | INT, TERM, QUIT, ABRT, HUP, PIPE, BREAK, BUS | The handler only calls `destroy()` and never `process.exit` |
| `targetFps` / `maxFps` | 30 / 60 | The loop is on-demand: nothing is written while idle |
| `debounceDelay` | 100 ms | Resize debounce |
| `autoFocus` | `true` | A left mouse-down focuses the nearest focusable ancestor (§5) |
| `consoleMode` / `consoleOptions` | `"console-overlay"` | Captures `console.*` (§13) |
| `openConsoleOnError` | `true` | The overlay pops up on uncaught errors |
| `clearOnShutdown`, `backgroundColor`, `prependInputHandlers`, `clock`, `onDestroy` | | |

**Kitty gotchas.**
- **`useKittyKeyboard: null` does not disable the protocol**: the source does `?? {}`, and the spike still saw `ESC[>5u`.
- To disable it, pass `{disambiguate:false, alternateKeys:false}`. modifyOtherKeys `ESC[>4;1m` stays on.
- The push (`ESC[>5u`) is sent only after the terminal answers the `ESC[?u` query. On terminals without kitty support,
  shortcuts fall back to the legacy table in §4.
- opentui.com's 0.9.0 notes say kitty is confirmed by kitty, Ghostty, foot and Alacritty, but not by WezTerm (default
  config) or tmux.

**Lifecycle (verified):**
```tsx
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 60, backgroundColor: "#101010" });
const root = createRoot(renderer); root.render(<App />);
renderer.on(CliRenderEvents.DESTROY, () => process.exit(0));   // the app owns process exit (see Signals below)

// Hand the terminal to an external editor and come back:
await renderer.suspend();                                      // leaves raw mode, restores all modes, pauses stdin
Bun.spawnSync([editor, file], { stdio: ["inherit", "inherit", "inherit"] });
await renderer.resume();                                       // re-enables modes, re-queries the palette, full repaint

// Shutdown:
renderer.destroy(); await renderer.closed;                     // wait for `closed` before process.exit or closing stdout
```
- `suspend()` sets `controlState` to `"explicit_suspended"` and removes the exit-signal listeners. `resume()` restores
  them.
- A suspend → external command → resume round trip took about 20 ms, and the command's output appeared on the main screen.

**Escape sequences observed in the PTY** (the driver answered queries like kitty with a dark background):

| Phase | Sequences |
|---|---|
| Startup queries | `?2031h` and `OSC 10/11 ;?` (fg/bg), `CSI >0q` (XTVERSION), `CSI 6n`, XTGETTCAP, DECRQM for `?1016 ?2027 ?2031 ?1004 ?2004 ?2026`, `CSI ?u` (kitty keyboard), `OSC 99`, `OSC 1337;Capabilities`, `OSC 7501;?`, kitty graphics `APC G…a=q`, `OSC 66` width probes, then `CSI c` (DA1, used as a sentinel) and `CSI 14t` (pixel size) |
| Startup modes | `?1049h` (alt screen), `?25l`, `>4;1m` (reset to `>4;0m` once kitty is confirmed), `>5u`, `?2027h` (grapheme clusters), `?2004h` (bracketed paste), `?1000h ?1002h ?1003h ?1006h`. Every frame is wrapped in `?2026h … ?2026l` (synchronized output) |
| `suspend()` and `destroy()` (the same sequence) | `?25h`, `OSC 22;` (pointer shape), `<u` (kitty pop), `?1003l ?1002l ?1000l ?1006l ?2004l ?1049l ?2031l ?2027l`, `OSC 0;`, `OSC 12;default`, `OSC 112`, `CSI 0 q` |
| `resume()` | The startup modes again, 16 `OSC 4;n;?` palette queries, `OSC 10–19;?`, DA1, then a full frame |

**Signals.**
- The renderer adds `process` listeners for SIGINT, SIGTERM, SIGWINCH, `uncaughtException`, `unhandledRejection` and
  `exit`. **There is no SIGTSTP or SIGCONT handling.**
- **SIGTERM, SIGINT and Ctrl+C only call `destroy()`.** The process exits only if nothing else keeps the event loop alive.
  A child that had a timer was still alive 3 s after SIGTERM, so always `process.exit` from `DESTROY`.
- In raw mode **Ctrl+Z arrives as a key** (`ctrl`, `z`). This job-control pattern worked:
  `await renderer.suspend(); process.once("SIGCONT", () => renderer.resume()); process.kill(process.pid, "SIGSTOP")`.

**Capabilities** (`renderer.capabilities`, the `TerminalCapabilities` type in `@opentui/core/types.d.ts`):
- Fields include `kitty_keyboard`, `kitty_graphics`, `rgb`, `ansi256`, `unicode` (the width method), `sync`,
  `bracketed_paste`, `hyperlinks`, `osc52`/`osc52_support`, `focus_tracking`, `notifications`, `multiplexer`,
  `image_protocol` and `terminal{name, version, from_xtversion}`.
- They are available right after `await createCliRenderer()`, which took about 110 ms whether or not the terminal answered.
- Without replies they are guessed from env vars (`TERM_PROGRAM=ghostty` gave name ghostty and `rgb:true`).
- The `CAPABILITIES` event fires only for changes after setup.

**Theme mode.**
- `renderer.themeMode` (`"dark" | "light" | null`) comes from the **OSC 11 background reply**. Answering only the DSR 997
  color-scheme report left it `null`.
- `waitForThemeMode(ms)` returns `null` on timeout.
- A live terminal theme switch (`ESC[?997;2n`) makes the renderer query OSC 11 again and then emit `THEME_MODE` (verified
  `"light"`).
- `getPalette()` is UNVERIFIED.

**Dimensions and resize.**
- `renderer.width` and `renderer.height` give the size.
- `RESIZE (w,h)` fires about 100 ms after SIGWINCH (the debounce), and in React through `useTerminalDimensions` and
  `useOnResize`.
- `renderer.resize(w,h)` resizes programmatically.

---

## 2. React binding

**Root API.** `createRoot(renderer).render(node)` and `root.unmount()`. The old `render()` function is gone.
- `renderer.destroy()` also unmounts the root, through a `DESTROY` listener.
- The container is a React `ConcurrentRoot`.
- Every root is wrapped in a built-in `ErrorBoundary`. It replaces the whole tree with the error stack in red [02-react-extend].
- Other exports: `extend`, `getComponentCatalogue`, `baseComponents`, `createPortal`, `flushSync`, `useAppContext`,
  plugin slots (`createReactSlotRegistry`, `createSlot`, `Slot`), `TimeToFirstDraw`.

**Intrinsic elements** (the full catalogue in `src/components/index.ts`):

| Element | Renderable | Notable props |
|---|---|---|
| `box` | BoxRenderable | Layout props (§3); `border`, `borderStyle`, `title`, `focusable`, `focused`, `gap` |
| `text` | TextRenderable | `content`, `fg`, `bg`, `attributes`, `wrapMode`, `truncate`, `textAlign`, `selectable` |
| `span` `b` `strong` `i` `em` `u` `br` `a` | TextNode subclasses | Only valid inside `<text>` (otherwise they throw). `a` takes `href` (OSC 8 link) |
| `scrollbox` | ScrollBoxRenderable | §7 |
| `input` `textarea` `select` `tab-select` | §11 | `focused`, plus the `on*` events in §11 |
| `code` `line-number` `diff` `markdown` | §8, §9 | |
| `ascii-font` | ASCIIFontRenderable | `text`, `font: tiny/block/shade/slick` |
| `image` `video` | Image / Video renderables | `source`, `fit`, `protocol` (§11) |

**Not** intrinsic, so they need `extend()`: `EmbeddedTerminalRenderable` (§10), `TextTableRenderable` (§8),
`SliderRenderable`, `FrameBufferRenderable`.

The JSX types are in `@opentui/react/jsx-namespace.d.ts`. The repo's `tsconfig` already sets `jsxImportSource: "@opentui/react"`.

**How props reach renderables** (`setRenderableProp` in core): `focused` calls `.focus()`/`.blur()`; `style={{…}}` is
spread like direct props; Input `onInput`/`onChange`/`onSubmit` map to the `input`/`change`/`enter` events; Select and
TabSelect `onChange`/`onSelect` map to `selectionChanged`/`itemSelected`; every other prop is assigned directly
(`renderable[name] = value`); a removed prop is set to `undefined`.

**Hooks** (the complete list):

| Hook | What it really is |
|---|---|
| `useRenderer()` | The `CliRenderer` |
| `useKeyboard(fn, {release?})` | `renderer.keyInput.on("keypress")` (plus `keyrelease`). See §4 for ordering |
| `usePaste(fn)` | `keyInput.on("paste")`; the handler gets a `PasteEvent` with `.bytes` (decode with `decodePasteBytes`) |
| `useFocus(fn)` / `useBlur(fn)` | **Terminal window** focus and blur, not element focus |
| `useOnResize(fn)` | `renderer.on("resize", (w,h))`. There is no `useResize` |
| `useTerminalDimensions()` | `{width, height}` state, updated on resize |
| `useSelectionHandler(fn)` | `renderer.on("selection")`. There is no `useSelection` |
| `useTimeline(opts)` | A `Timeline` registered with the animation engine |
| `useAnimationTick(fps, cb)` | Shared animation clock; state updates are flushed synchronously |

There is no hook for element focus. Use `renderer.on("focused_renderable", (cur, prev) => …)`; it emitted `a -> b, b -> null`
[04-keys-dispatch].

**Refs** point at the renderable itself, for example `useRef<ScrollBoxRenderable>(null)`. Use them for imperative APIs
such as `scrollTo`, `setLineColor` and `plainText`.

**`extend()` with a custom renderable** [02-react-extend]:
```tsx
class FastListRenderable extends Renderable {
  protected static override readonly defaultFocusable = true;     // gets handleKeyPress when focused
  set items(v: string[]) { this._items = v; this.requestRender(); } // every prop needs a setter that calls requestRender
  protected override renderSelf(buf: OptimizedBuffer) {            // screen coordinates: this.x, this.y
    buf.fillRect(this.x, this.y, this.width, this.height, BG);
    buf.drawText(text, this.x, this.y + row, FG, BG);
  }
  override handleKeyPress(k: KeyEvent) { /* … */ return true; }
  protected override onMouseEvent(e: MouseEvent) { /* down / scroll / … */ }
}
declare module "@opentui/react" { interface OpenTUIComponents { "fast-list": typeof FastListRenderable } }
extend({ "fast-list": FastListRenderable });
```
- React constructs the instance with `{id, ...props}` and then assigns every prop again.
- **Setters run before layout, when `this.height` is still 0.** Do size-dependent work, such as clamping the scroll offset,
  in `renderSelf`.
- Measured with a 100k-item list: a key-driven selection move, including the React state round trip, took 0.17 ms; a wheel
  scroll took 0.22 ms.

**Portals.** `createPortal(node, renderer.root, null)` rendered an absolutely positioned toast outside its parent
[02-react-extend].

**Performance** [02-perf-virtual-list], 80x30, 10,000 rows. Each time is an act() state update plus one `renderOnce()`.

| Setup | Operation | Median |
|---|---|---|
| All 10k rows mounted in `<scrollbox viewportCulling>`, rows wrapped in `memo` | Mount and first frame | 284 ms |
| | Dispose | 82 ms |
| | Move selection by 1 | 11.7 ms (the parent maps 10k elements) |
| | `scrollBy(1)` / `scrollTo(random)` | 0.55 / 0.34 ms (native scrolling, no React work) |
| Same tree without `memo` | Move selection by 1 | 29 ms (p90 46 ms) |
| Virtualized window (30 slot rows keyed by slot index) | Mount | 2.5 ms |
| | Move selection | 0.14 ms |
| | Scroll by 1 row | 0.22 ms |
| | Jump to a random offset | 0.19 ms |

**Recommendation:** for any list that can exceed a few hundred rows (explorer, search results, git log), render only the
visible window. Key rows by **slot index**, not item id, so scrolling only updates text props; handle the wheel with
`onMouseScroll` on the container. A custom renderable (above) is the next step if React becomes the bottleneck.

**Pitfalls**
- Text must be inside `<text>`. A bare string or `<span>` elsewhere throws ("Text must be created inside of a text node").
- Mouse handlers bubble (§5), but key handlers do not: `onKeyDown` fires only on the focused renderable.
- `resized` and `layout-changed` listeners throw on any renderable except the root. Use `onSizeChange` instead.

---

## 3. Layout (Yoga flexbox)

**Props** (`LayoutOptions` and `RenderableOptions`):
- **Size and position:** `width`/`height` (number, `"auto"` or `"N%"`), `min*`/`max*`, `position: "relative" |
  "absolute"` with `top`/`right`/`bottom`/`left`.
- **Flex:** `flexGrow`, `flexShrink`, `flexBasis`, `flexDirection`, `flexWrap`, `alignItems`, `alignSelf`,
  `alignContent`, `justifyContent`, `aspectRatio`.
- **Spacing:** `margin*` (with `marginX` and `marginY`), `padding*` (with `paddingX` and `paddingY`), and on boxes `gap`,
  `rowGap`, `columnGap`.
- **Clipping and visibility:** `overflow: "visible" | "hidden" | "scroll"`, `zIndex`, `opacity` (0..1), `visible`.
  `visible={false}` takes the node out of layout like `display: none` while keeping it mounted (verified:
    the next sibling moved to x=5).
- **Lists:** `layoutMode: "list"` stacks children without a flex pass. **UNVERIFIED** performance.

**Borders** (on box): `border` (`true` or sides such as `["right"]`), `borderStyle` (`single`, `double`, `rounded`,
`heavy`), `borderColor`, `focusedBorderColor`, `customBorderChars` (all 11: `topLeft … cross`), `title`/`bottomTitle`
with `titleAlignment`/`bottomTitleAlignment` (`left`, `center`, `right`).

Gotchas:
- **A title is drawn only on a top border**, and a bottom title only on a bottom border. `border={["right"]} title="X"`
  shows no title.
- The border takes up cells inside `width`.

**IDE shell** [03-layout-shell]. The spike's code, abridged:
```tsx
<box width="100%" height="100%" flexDirection="column">
  <box height={1} flexShrink={0} flexDirection="row" paddingX={1}>…<box flexGrow={1} />…</box>   {/* command bar */}
  <box flexGrow={1} flexDirection="row" minHeight={0}>
    <box width={4} flexShrink={0} />                                               {/* activity bar */}
    <box width={sidebarWidth} flexShrink={0} minWidth={10} border={["right"]} overflow="hidden" />
    <box flexGrow={1} flexShrink={1} minWidth={20} flexDirection="column">
      <box flexGrow={1} minHeight={3} border borderStyle="rounded" title=" main.ts " titleAlignment="center" overflow="hidden" />
      {showBottom && <box height="30%" minHeight={4} flexShrink={0} border={["top"]} title="TERMINAL" />}
    </box>
    {showRight && <box width={24} flexShrink={0} border={["left"]} />}
  </box>
  <box height={1} flexShrink={0} flexDirection="row" paddingX={1} gap={2}>…</box>                {/* status bar */}
  {modal && <box position="absolute" left={0} top={0} width="100%" height="100%" zIndex={100}
      backgroundColor={RGBA.fromValues(0,0,0,0.6)} justifyContent="center" alignItems="center">…</box>}
  {toast && <box position="absolute" right={1} bottom={2} width={28} height={3} zIndex={200} border />}
</box>
```
Computed layout at 120x35 (sidebar 26, right and bottom panels shown):

| Node | x | y | w | h |
|---|---|---|---|---|
| cmdbar | 0 | 0 | 120 | 1 |
| activity | 0 | 1 | 4 | 33 |
| sidebar | 4 | 1 | 26 | 33 |
| editor | 30 | 1 | 66 | 23 |
| bottom | 30 | 24 | 66 | 10 |
| right | 96 | 1 | 24 | 33 |
| status | 0 | 34 | 120 | 1 |

At 90x28 (sidebar 22, no right panel), editor is `26,1,64,18` and bottom is `26,19,64,8`.

120x35 frame. Rows 5 to 21 repeat the row above them and are cut here.
```
 lucy · ~/project                                                                                                    ⌘P
  E src/                     │╭─────────────────────────── main.ts ────────────────────────────╮┊ fn main()
  S  main.ts                 ││const x = 1                                                     │┊
  G                          ││const x = 1                                                     │┊
                             ││const x = 1                                                     │┊
                             │╰────────────────────────────────────────────────────Ln 1, Col 1─╯┊
                             │━━TERMINAL━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┊
                             │$ bun test                                                        ┊
                             │                                                                  ┊   (7 more empty rows)
 main*  0 ⚠ 0 ✖                                                                                     UTF-8 LF TypeScript
```
90x28 frame, abridged the same way:
```
 lucy · ~/project                                                                      ⌘P
  E src/                 │╭────────────────────────── main.ts ───────────────────────────╮
  S  main.ts             ││const x = 1                                                   │
                         │╰──────────────────────────────────────────────────Ln 1, Col 1─╯
                         │━━TERMINAL━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                         │$ bun test
 main*  0 ⚠ 0 ✖                                                       UTF-8 LF TypeScript
```
The full frames, plus an 80x20 frame with the modal and toast and a frame after `resize(60,16)`, are printed by
`bun run spikes/opentui/03-layout-shell.tsx`.

**Overlays**
- `position="absolute"` combined with `zIndex` is out of flow and paints above its siblings. At equal zIndex, the later
  sibling wins both painting and hit-testing.
- A backdrop with `backgroundColor` alpha below 1 **alpha-blends** over what is underneath. With `RGBA(0,0,0,0.6)`, a
  `#888888` glyph behind it became fg 54,54,54, and a background of 37 became 15.
- The `opacity` prop blends the whole subtree. A red box at `opacity={0.4}` gave bg 102,0,0.
- Put overlays at the root, or use `createPortal(…, renderer.root)` (verified), so no ancestor's `overflow="hidden"` can
  clip them (clipping of absolute children by such an ancestor: UNVERIFIED).

**Resizable sidebar.** Store the width in state and change it from a 1-column divider's drag events (§5).

---

## 4. Input and focus

### Dispatch order (verified [04-keys-dispatch]; matches opentui.com/docs/core-concepts/keyboard)
1. **Global listeners** run in registration order: every `useKeyboard` and every `renderer.keyInput.on("keypress")`.
   - `e.stopPropagation()` stops later global listeners **and** the focused renderable.
   - `e.preventDefault()` lets later global listeners run but skips the focused renderable.
2. **The focused renderable** handles the key next. Exactly one renderable can be focused, and nothing bubbles to parents.
   - Its `onKeyDown` prop runs first.
   - If `onKeyDown` does not call `preventDefault()`, the built-in `handleKeyPress` runs (text insert, select navigation
     and so on).
   - The return value of `handleKeyPress` changes nothing.

Consequences:
- **Global handlers see every key, including letters typed into a focused `<input>`.** Typing `a` logged
  `child useKeyboard(a) → root useKeyboard(a) → late keyInput listener(a) → input onKeyDown(a) → input onInput("a")`.
- **A child's `useKeyboard` runs before its parent's.** React runs child effects first, so a "root" router built with
  `useKeyboard` is *not* first.
- Global bindings like `j` therefore need a focus check:
  - `renderer.currentFocusedEditor` is non-null while an input or textarea is focused.
  - `renderer.currentFocusedRenderable` is the focused renderable.

**Central key router (verified):** register one listener ahead of everything with
`renderer.keyInput.prependListener("keypress", router)`.
- That listener ran before every `useKeyboard`.
- Calling `stopPropagation()` in it suppressed all of them.

```ts
renderer.keyInput.prependListener("keypress", (k) => {
  for (const layer of layerStack) {              // top first: modal, then palette, then global
    if (layer.handle(k) || layer.captureAll) {   // a modal sets captureAll: it eats everything
      k.preventDefault(); k.stopPropagation();   // the focused widget and other listeners never see it
      return;
    }
  }
  // fall through: the focused <input>/<textarea>/<select> handles it
});
```
In the spike, `ctrl+p` opened the modal while the input was focused, the modal captured `b`, and `escape` closed it.

### KeyEvent fields
`name, ctrl, meta, shift, option, sequence, number, raw, eventType: "press"|"release", source: "raw"|"kitty", code?,
super?, hyper?, capsLock?, numLock?, baseCode?, repeated?`, plus `preventDefault()`, `stopPropagation()`,
`defaultPrevented` and `propagationStopped`.
- Release events go only to `keyrelease`; `useKeyboard(fn, {release:true})` subscribes to it.
- A kitty repeat arrives as `eventType: "press"` with `repeated: true`.

### Parsed events (verified [04-keys-parse])

| Key | Legacy bytes → event | Kitty bytes → event |
|---|---|---|
| ctrl+p | `\x10` → `p` ctrl | `CSI 112;5u` → `p` ctrl |
| ctrl+shift+p | `\x10` → `p` ctrl (**shift lost**) | `CSI 112:80;6u` → `p` ctrl+shift, `sequence:"P"` |
| ctrl+1 | usually just `1` → `1` (number, **ctrl lost**). xterm modifyOtherKeys `CSI 27;5;49~` → `1` ctrl | `CSI 49;5u` → `1` ctrl |
| numpad 1 | `1`, or `ESC O q` → `1` (number, `code:"Oq"`) | `CSI 57400u` → `kp1` |
| numpad enter | — | `CSI 57414u` → `kpenter` (textarea treats it as `return`) |
| alt+x | `ESC x` → `x` meta | `CSI 120;3u` → `x` **meta+option** |
| option+x (macOS, Option not set to Meta) | `≈` → name `≈`, no modifiers | same |
| ş ğ ı ö ü ç İ | UTF-8 → `name` is the letter itself (`"ş"`, `"İ"`), no modifiers | Same as plain text; ctrl+ş = `CSI 351;5u` → `ş` ctrl |
| shift+i, kitty with alternate keys | — | `CSI 105:73;2u` → `i` shift, `sequence:"I"` |
| F1, F5, F12, shift+F5 | `ESC O P`, `CSI 15~`, `CSI 24~`, `CSI 15;2~` → `f1`, `f5`, `f12`, `f5` shift | `CSI P` → `f1` |
| enter / shift+enter | `\r` → `return` for both (**shift lost**). `ESC \r` → `return` meta | `CSI 13;2u` → `return` shift |
| escape | `ESC` → `escape`, held about **21 ms** (`ESC` followed by `x` within 5 ms parses as meta+x) | `CSI 27u` → `escape`, immediate |
| super+s (cmd+s) | not sent | `CSI 115;9u` → `s` super |
| backspace / shift+tab / ctrl+up | `\x7f` → `backspace`; `CSI Z` → `tab` shift; `CSI 1;5A` → `up` ctrl | |

- CSI-u sequences are parsed even when kitty mode was not requested.
- `mockInput.pressKey(key, mods)` encodes legacy bytes by default, so `{ctrl,shift}` loses shift, `{super}` is dropped and
  `ctrl+1` loses ctrl.
- With `createTestRenderer({kittyKeyboard:true})` it encodes CSI-u and every modifier survives. In that mode `F5` encodes
  as `CSI 57368u`.
- **Practical rules:**
  - Do not depend on ctrl+shift+letter, ctrl+digit or shift+enter without the kitty protocol; offer fallbacks.
  - Match Turkish letters on `name` or `sequence`.
  - On macOS Option without Meta produces characters (`≈`), not alt bindings.

### Paste [04-paste]
- Bracketed paste (`ESC[200~ … ESC[201~`, even when split across chunks) becomes a single `PasteEvent{bytes, metadata?}`.
- Global `usePaste` runs first; calling `preventDefault()` there stops the focused textarea from inserting.
- Textarea and input strip ANSI sequences from pasted text (`\x1b[31m` was removed).

---

## 5. Mouse [05-mouse]

**Handler props**: `onMouse`, `onMouseDown`, `onMouseUp`, `onMouseMove`, `onMouseDrag`, `onMouseDragEnd`,
`onMouseDrop`, `onMouseOver`, `onMouseOut`, `onMouseScroll`.

**MouseEvent fields:** `type` (`down | up | move | drag | drag-end | drop | over | out | scroll`), `button` (0 left,
1 middle, 2 right; the wheel came as type `scroll` with button 1), `x`/`y` (screen cells), `modifiers{shift,alt,ctrl}`,
`scroll?{direction, delta}`, `target`, `currentTarget`, `source?` (the dragged renderable on `over`/`drop`),
`isDragging?`, `stopPropagation()`, `preventDefault()`.

**Bubbling.** Mouse events bubble to parents. A click on the editor reached the root's `onMouseDown`, and
`stopPropagation()` on the divider stopped it.

**Drag capture (for panel dividers).**
- After a left `down` on X, the following `drag` events go to X **even when the pointer leaves it**.
- The release sends `drag-end` and `up` to X, then `drop` (with `source=X`) and `up` to whatever is under the pointer.
- Dragging the 1-column divider from x=12 to x=25 produced: `down` → `drag ×5` (all on the divider) → `drag-end` → `up` →
  editor `drop`. The sidebar resized to 25.
- **Gotcha:** the element under the pointer also receives an `up` after a drag, so do not treat that `up` as a click.

**Click and double-click.** There is no `click` or `dblclick` event; synthesize them from down/up with a timestamp.
Repeated clicks are tracked internally only to switch text selection between cell, word and line (3 clicks within the
repeat interval).

**Hover.** `over`/`out` fire on `move` and are rechecked after each frame, so a layout change under a still pointer also
fires them. Plain motion is reported only with `enableMouseMovement` (default on, mode 1003; §1). With 1003 the terminal
reports every cell the pointer crosses; the CPU cost of that was not measured (UNVERIFIED).

**autoFocus.** By default, a left `down` that was not `preventDefault()`ed focuses the nearest focusable ancestor
(`dispatchMouseEvent`). Set `autoFocus: false` if the key router must own focus.

**Wheel.** The wheel goes to the hit-tested renderable, or, if nothing is hit, to the focused one.

**Selection and clipboard.**
- `<text selectable>` (the default for text) supports drag selection. Dragging over "alpha beta" gave
  `renderer.getSelection().getSelectedText() === "alpha"`, and `useSelectionHandler` fired.
- Ctrl+press extends an existing selection.
- `renderer.copyToClipboardOSC52(text, target?)` returns a boolean; `isOsc52Supported()` and `capabilities.osc52_support`
  report support.
  - **In the test renderer it throws `NativeError: ot_session_clipboard failed: InvalidPhase`.** Wrap it in try/catch.
    Real-terminal behavior is UNVERIFIED.
- There is also a host clipboard service: `createHostClipboard()` and `createClipboard({host, terminal:
  createRendererClipboardAdapter(renderer)})` with destinations such as `"best-available"`. **UNVERIFIED** (not run, to
  avoid touching the user's clipboard).

---

## 6. Text and styling [06-text]

**Colors.** `ColorInput` is `string | RGBA`.
- `parseColor` accepts `#rgb`, `#rrggbb`, `#rrggbbaa`, CSS-like names (`red`, `brightBlue`) and `transparent`.
- **Invalid strings, including `rgb(…)` and `"default"`, do not throw.** They log "Invalid hex color" and become magenta.
- `RGBA` stores floats from 0 to 1 (`RGBA.fromHex`, `fromInts`, `fromValues`). `RGBA.fromIndex(n)` makes an ANSI-indexed
  color (`intent: "indexed"`); `RGBA.defaultForeground()`/`defaultBackground()` follow the terminal defaults
  (`intent: "default"`). Use these when a theme should follow the terminal palette.

**Attributes.** `TextAttributes`: `BOLD 1, DIM 2, ITALIC 4, UNDERLINE 8, BLINK 16, INVERSE 32, HIDDEN 64, STRIKETHROUGH 128`.
OR them together in the `attributes` prop on `text` or `span`.
```tsx
<text><b>bold</b> <span attributes={A.DIM}>dim</span> <span fg="#000" bg="#fc0" attributes={A.BOLD|A.UNDERLINE}>combo</span></text>
<text content={t`${bold("B")} ${fg("#00ff00")("G")} plain`} />   // core StyledText template + helper functions
```
- Helpers: `bold`, `italic`, `underline`, `strikethrough`, `dim`, `reverse`, `blink`, `fg(c)`, `bg(c)`, `link(url)`, plus
  named colors such as `red(...)`.

**Cell widths.** The test renderer uses `widthMethod` `unicode-wide`.

2 cells: 漢, 👍, 🇹🇷, 👨‍👩‍👧 (ZWJ), tab (`tabIndicator`/`tabIndicatorColor` make it visible). 1 cell: é (combining),
Nerd Font private-use glyphs (U+F115, U+E0B0), ❯, →, Ş.

- The real terminal's width method comes from capability detection (`capabilities.unicode`); see §1.

**Wrapping and truncation** (`TextBufferOptions`), in a 10-column box:

| Setting | Result |
|---|---|
| `wrapMode="none"` | Clipped |
| `wrapMode="char"` | `char: the ` / `quick brow` / `n fox` |
| `wrapMode="word"` | `word: the ` / `quick` / `brown fox` |
| `truncate` | **Middle ellipsis**: `tru... fox` |

- `textAlign` takes `left`, `center` or `right`.

**Dimmed backdrops.** Use an alpha background or `opacity` (§3). Both blend natively.

---

## 7. ScrollBox [07-scrollbox]

**Props:** `scrollY` (default true), `scrollX`, `stickyScroll`, `stickyStart: "bottom"|"top"|…`, `viewportCulling`,
`scrollAcceleration` (`LinearScrollAccel`, `MacOSScrollAccel`), `scrollbarOptions` / `verticalScrollbarOptions` /
`horizontalScrollbarOptions` (`{showArrows, arrowOptions, trackOptions:{foregroundColor, backgroundColor…}}`),
`rootOptions`/`wrapperOptions`/`viewportOptions`/`contentOptions`, and every box prop. Children are the scrolled content.

**API:** `scrollTop`/`scrollLeft` (read and write), `scrollHeight`, `scrollWidth`, `viewport.height`,
`scrollTo(n | {x,y})`, `scrollBy(delta, unit?)` (`"absolute" | "viewport" | "content" | "step"`),
`scrollChildIntoView(idOrNode, {align: "nearest"|"start"|"end", inset})`, `anchor(node)` (keeps a node in place while
content above it changes), `afterLayout(cb)`.

Verified, with 50 one-row children in an 8-row box with a border:
- `scrollTo(10)` → 10, then `scrollBy(3)` → 13, then `scrollBy(1,"viewport")` → 19.
- After selecting row 40, `scrollChildIntoView("row-40", {align:"nearest"})` → `scrollTop=35`, so the row sits on the
  last visible line. This is the "keep the selected row visible" call.
- `align:"start", inset:1` for row 2 → `scrollTop=1`.

**Keys and wheel when focused:** down +1, pagedown +3, end → 44 (max), home → 0, one wheel event +1.

**Sticky bottom (log view):** new lines keep the view at the bottom; after the user scrolls (`scrollTo(0)`) it stays put;
`scrollTo(Infinity)` turns following back on.

**Many children.** Scrolling 10k mounted rows natively costs about 0.5 ms (§2). Mounting them costs 284 ms, so virtualize
long lists rather than mounting them.

---

## 8. Code and syntax highlighting

[08-code-highlight, 08-code-perf, 08-code-mainthread-lag, 08-code-extras, 08-grammar-register, 08-line-number,
08-markdown-table]

**Architecture.** `<code>` is `CodeRenderable`, a native text view. Highlighting runs in a Bun `Worker`
(`parser.worker.js`, web-tree-sitter 0.25.10), which returns ranges `[start, end, group]` styled through a `SyntaxStyle`.

**SyntaxStyle.** Build it once per renderer, not during a React render. It is a native resource, so call `destroy()` after
everything that uses it is gone.
```tsx
const style = SyntaxStyle.fromStyles({
  default: { fg: "#c0c0c0" }, keyword: { fg: "#ff79c6", bold: true }, string: { fg: "#f1fa8c" },
  comment: { fg: "#6272a4", italic: true }, number: { fg: "#bd93f9" }, type: { fg: "#8be9fd" }, function: { fg: "#50fa7b" },
  "search.match": { bg: "#806000", fg: "#ffffff" },              // custom groups are allowed
}, renderer.nativeScene);
<code content={src} filetype="typescript" syntaxStyle={style} fg="#c0c0c0" wrapMode="none" width="100%" height="100%" />
```
- Other constructors: `SyntaxStyle.fromTheme(ThemeTokenStyle[], owner)` (VS Code-like `{scope:[…],
  style:{foreground…}}`), and `SyntaxStyle.create(owner)` followed by `registerStyle(name, def)`.
- **Fallback for dotted group names goes only to the first segment.** `keyword.return` falls back to `keyword`, and
  `function.method.call` falls back to `function`, never to `function.method`.
- When ranges overlap, the more specific group (more dots) wins.
- Capture names follow nvim-treesitter conventions (`keyword.*`, `function.*`, `markup.*`, …).
- `OTUI_TS_STYLE_WARN=1` logs groups that have no style.

**Async: plain text first, colors later (verified).**
- The first frame paints plain text using **`<code fg>`, not `syntaxStyle.default`**. Set `fg` to the theme foreground to
  avoid a white flash.
- Colors appear after `await code.highlightingDone`. `isHighlighting` reports whether highlighting is in progress.
- `drawUnstyledText={false}` paints nothing until the colors are ready.

**Measured: a 5,006-line, 181 KB TypeScript file at 120x40.**

| Case | First paint | Highlighted |
|---|---|---|
| Cold (worker start + wasm load) | 5.1 ms | 249 ms |
| Warm | 1.9 ms | 126 ms |
| After a 1-character edit | 2.6 ms | 109 ms |

- **Every content change re-highlights the whole file.** `<code>` calls `highlightOnce(wholeContent)`; the client's
  incremental `createBuffer`/`updateBuffer` is not used.
- **The main thread stays mostly free:**

| File size | Highlight time | Max main-thread stall |
|---|---|---|
| 5k lines | 136 ms | 2 ms |
| 20k lines | 457 ms | 9 ms |
| 50k lines | 1017 ms | 26 ms |

- **Scrolling** with `code.scrollY += 40` costs 0.12 ms per frame. Only visible rows are painted, but the whole file sits
  in one native buffer.

**Grammars bundled and usable offline** (`node_modules/@opentui/core/assets/*` and `defaultParserDescriptors`), the full
list: `javascript` (alias `javascriptreact`), `typescript`, `typescriptreact` (tsx), `markdown` (with injections),
`markdown_inline`, `zig`.
- **Not bundled:** JSON, Python, Rust, Go, CSS, HTML, YAML, Bash, TOML and everything else.
- `pathToFiletype()` still maps about 90 extensions (`a.py → python`, `a.unknown → undefined`).
- Markdown code fences resolve only js, jsx, ts, tsx and md.

**Unknown filetypes.** They render as plain text with no error, and `highlightingDone` resolves in under 2 ms. Calling
`client.highlightOnce("x = 1","python")` returns `{warning: "No parser available for filetype python"}`.

**Registering more grammars (verified offline):**
```ts
const client = new TreeSitterClient({ dataPath: "/abs/lucy-ts" });   // a private client with its own cache dir
await client.initialize();
client.addFiletypeParser({ filetype: "mylang", aliases: ["ml2"],
  wasm: "/abs/tree-sitter-x.wasm", queries: { highlights: ["/abs/highlights.scm"] } });   // injections?: [...] optional
await client.preloadParser("mylang");                                 // → true
<code treeSitterClient={client} filetype="ml2" … />
// To add grammars to the global client, call addDefaultParsers([...]) BEFORE it initializes.
```
- Queries may use nvim's `#lua-match?`; it is translated.
- `@opentui/core/tree-sitter/update-assets` is a build-time CLI that downloads grammars and generates a parsers module.
  Read, not run (UNVERIFIED).

**Network, local-first.** Every fetch path found by grepping the bundled JS:
1. **The parser worker** (`DownloadUtils.downloadOrLoad`) calls `fetch()` **only when a wasm or query path starts with
   `http(s)://`**.
   - Results are cached in `<dataPath>/tree-sitter/languages/*.wasm` and `<dataPath>/tree-sitter/queries/<ft>-<hash>.scm`.
   - Verified with an unreachable URL: the worker logged "Downloading from URL…" and then reported "No parser available".
2. **web-tree-sitter `Language.load`** uses `fs.readFile` for local paths under Bun.
3. **Audio-stream URL playback** (`index.bun.js`). Not used by us.
4. **`<image source="https://…">`** fetches (§11).
5. **React DevTools (`@opentui/react`).** Not a `fetch()`, so the grep above missed it: when `process.env.DEV === "true"`
   at the moment `@opentui/react` is first evaluated (top-level code in `chunk-xfw77prd.js`, right after the reconciler
   is created; `createRoot`/`render` check nothing), it imports `react-devtools-core` (installed as its dependency) and
   calls `connectToDevTools()`, which opens a WebSocket to `ws://localhost:8097`. Verified by a child process that
   replaces `WebSocket` with a recorder (`tests/security/react-devtools.test.ts`). Guard: the bootstrap loads the React
   layer through `importWithoutReactDevTools(() => import(…))` (`src/core/react-devtools.ts`), which hides `DEV` only
   during that first evaluation and restores it, so embedded terminals still inherit the user's `DEV`.

Runtime checks:
- With the bundled grammars and with unknown filetypes there was **no fetch**: a patched `globalThis.fetch` on the main
  thread was never called, and worker logs show local paths only.
- **Rule:** never register http(s) sources; vendor the wasm and query files and use absolute paths.

**Disk writes even when offline.**
- On start, the worker always runs `mkdir -p <dataPath>/tree-sitter/{languages,queries}`.
- The default `dataPath` is `$XDG_DATA_HOME/opentui`, or `~/.local/share/opentui`. Our spike runs created it, and it was
  removed afterwards.
- To redirect it: `getDataPaths().appName = "lucy"` (gives `~/.local/share/lucy`), `XDG_DATA_HOME`, or a private
  `TreeSitterClient({dataPath})` passed as the `treeSitterClient` prop.

**Other gotchas.**
- Worker `console.*` output goes to `client.on("worker:log", …)`, never to stdout.
- Destroying the last renderer destroys the global tree-sitter client. A highlight still pending at that moment logs
  "TreeSitter client destroyed", so await `highlightingDone` before disposing.
- `onHighlight(highlights, ctx)` lets you add your own ranges, for example search matches with group `search.match`;
  return a new array. `onChunks` post-processes the styled chunks.
- **Changing `onHighlight` or `syntaxStyle` re-highlights the whole file** (about 105 ms per search-query change on 5k
  lines).

**`<line-number>`** wraps one `<code>` child and follows its `scrollY`:
```tsx
<line-number ref={ln} fg="#606060" bg="#101010" minWidth={3} paddingRight={1} width="100%" height="100%"><code … /></line-number>
ln.setLineColor(1, { gutter: "#303060", content: "#202040" });   // 0-based; content bg fills the whole row (active line)
ln.setLineSign(2, { after: "+", afterColor: "#22c55e" });         // diff markers
ln.setLineSign(4, { before: "●", beforeColor: "#ef4444" });       // diagnostics
ln.lineNumberOffset = 100; ln.setHideLineNumbers(new Set([11]));
```
- Also: `highlightLines(start, end, color)`, `clear*`, `setLineNumbers(Map)`, `showLineNumbers`,
  `getGutterLayout()`/`setGutterLayout({minWidth, paddingLeft, paddingRight, minDigits, minAfterWidth})`.
- Captured frame:
```
   1  const v0 = 0 // needle needle
   2  const v1 = 1 // needle
   3+ const v2 = 2 // needle
●  5  const v4 = 4 // needle
```

**Horizontal scroll and click-to-line on `<code>` (verified).**
- With `wrapMode="none"`, setting `scrollX` (0..`maxScrollX`) scrolls the text while the gutter stays put. No horizontal
  scrollbar is drawn.
- The wheel scrolls one row per event.
- Click to line (a click at y=2 after `scrollY=10` gave line 12):
```tsx
onMouseDown={function (this: CodeRenderable, e) {
  const srcLine = this.lineInfo.lineSources[e.y - this.y + this.scrollY]; // 0-based, wrap-aware
}}
```

**`<markdown>`**
- **Renders:** headings (`#` concealed), bold, italic, inline code, links (`text (url)`), lists and task items (`☑`),
  quotes (`│`), grid tables with alignment, fenced code (async, through a child CodeRenderable).
- **Options:** `conceal`, `concealCode`, `streaming`, `tableOptions{style:"grid"|"columns", borders, cellPadding…}`,
  `renderBlock(block, ctx)`, `inlineHook`, `extensions:["math"]`. Styling comes from `markup.*` groups.

**TextTable.** `TextTableRenderable` is not an intrinsic element; register it with `extend({"text-table":
TextTableRenderable})`.
- `content` is `TextChunk[][][]` (rows × cells × chunks).
- Props: `columnAlignments`, `columnWidthMode: "content"|"full"`, `wrapMode`, `cellPadding*`, `columnGap`, `border`,
  `outerBorder`, `showBorders`, `borderStyle`, `borderColor`, `selectable`.

---

## 9. Diff

[09-diff]

**Input format.** A unified-diff string, parsed with the `diff` package's `parsePatch`.
- **Only the first file in a patch is shown.** Later files are dropped silently, so use one `<diff>` per file.
- **Hunk header counts must be exact.** A wrong count renders "Error parsing diff: Hunk at line 5 contained invalid
  line…" followed by the raw text. Real `git diff` output is fine.

**Props.**
- **Content and layout:** `diff`, `view: "unified"|"split"`, `filetype` (required; not inferred from the file header),
  `syntaxStyle`, `treeSitterClient`, `wrapMode: "word"|"char"|"none"`, `conceal`, `syncScroll` (split only),
  `selectionBg`/`selectionFg`.
- **Line numbers:** `showLineNumbers` (default true), `lineNumberFg`/`lineNumberBg`, `gutter{paddingLeft, paddingRight,
  minDigits}`.
- **Colors:** `fg`, `addedBg`/`removedBg`/`contextBg`, `addedContentBg`/`removedContentBg`/`contextContentBg`,
  `addedSignColor`/`removedSignColor`, `addedLineNumberBg`/`removedLineNumberBg`. Defaults: added `#1a4d1a`, removed
  `#4d1a1a`, signs `#22c55e` and `#ef4444`.
- **Methods:** `setLineColor`, `highlightLines`, `clear*`, and `getHunkRowOffsets()` (it returned `[0, 9]`; use it for
  jump-to-hunk).

**Syntax highlighting inside the diff works.** A comment on an added line got fg 98,114,164 over the added background
26,77,26.

**Unified view, width 100.** There is one number column: removed lines show old numbers, everything else shows new
numbers. **No `@@` header rows and no separator between hunks**: the numbers jump from 7 to 21.
```
  1   // math helpers
  2 - export function add(a, b) {
  3 -   return a + b
  2 + export function add(a: number, b: number): number {
  3 +   // typed now
  4 +   return a + b;
  5   }
  6
  7   export const PI = 3.14
 21   export function div(a: number, b: number) {
 21 -   return a / b
 22 +   return b === 0 ? NaN : a / b
 23   }
```
**Split view, width 100.** Filler rows keep the two sides aligned. With `wrapMode="none"` long lines are clipped; with
`"word"` they wrap and the other side gets a filler row.
```
  1   // math helpers                               1   // math helpers
  2 - export function add(a, b) {                   2 + export function add(a: number, b: number): n
  3 -   return a + b                                3 +   // typed now
                                                    4 +   return a + b;
  4   }                                             5   }
  5                                                 6
  6   export const PI = 3.14                        7   export const PI = 3.14
 20   export function div(a: number, b: number) {  21   export function div(a: number, b: number) {
 21 -   return a / b                               22 +   return b === 0 ? NaN : a / b
 22   }                                            23   }
```

**Scrolling.**
- **There is no public scroll API** on `<diff>`: no `scrollY` and no `scrollTo`.
- The wheel scrolls it one row per event.
- Inside a `<scrollbox>`, the diff grows to its full height (267 rows), and `scrollbox.scrollTo(n)` combined with
  `getHunkRowOffsets()` gives programmatic jumps.

**Large diffs (split view, 100x14):**

| Hunk lines | First paint | Highlighted |
|---|---|---|
| 5k | about 25 ms | 112–203 ms |
| 20k | about 55 ms | about 300 ms |

**Gotchas.**
- No intra-line (word-level) diff.
- Split view rebuilds in a microtask after highlighting, so wait an extra frame before capturing.
- Only hunk fragments are parsed. A construct that starts outside the hunk (for example inside a template string) may be
  colored wrong (UNVERIFIED).

---

## 10. EmbeddedTerminalRenderable

[10-embedded-terminal-mount] There is no intrinsic element for it, so register it with `extend()`:
```tsx
declare module "@opentui/react" { interface OpenTUIComponents { "embedded-terminal": typeof EmbeddedTerminalRenderable } }
extend({ "embedded-terminal": EmbeddedTerminalRenderable });
<embedded-terminal ref={ref} width="100%" height="100%" focused
  onData={(bytes, source /* "input" | "response" */) => pty.write(bytes)} onTerminalResize={(c, r) => pty.resize(c, r)} />
ref.current.write(ptyOutputBytes);                 // feed the child's output in
```
- When focused, keys are encoded and sent through `onData` (ctrl+a gave `"\u0001"`).
- **The default size is 80x24, even inside a flex parent**, and it overflowed its parent's border. Always set
  `width`/`height`; with `100%` it became 38x6 and `onTerminalResize(38,6)` fired.
- The deep dive belongs to another engineer.

---

## 11. Widgets [11-widgets]

**Input** (`InputRenderable` extends Textarea; single line, height 1):
- **Props:** `value`, `placeholder`, `maxLength`, `minLength` (needed to submit), colors (`backgroundColor`, `textColor`,
  `focusedBackgroundColor`, `focusedTextColor`, `placeholderColor`), `keyBindings`, `keyAliasMap`.
- **Events:**
  - `onInput(value)` fires on every edit.
  - `onChange(value)` fires on enter, and on blur after edits; on enter it came before `onSubmit`.
  - `onSubmit(value)` fires on enter.
  - `maxLength={8}` truncated "feature/abc" to `feature/`.
- **Bindings:** Input inherits the textarea's emacs-style bindings: ctrl+a/e/f/b/w/k/u/d, alt+f/b/d, ctrl+-/ctrl+. for undo
  and redo, super+z, super+a.

**Textarea** (the commit message box):
- **Props:** `initialValue`, `placeholder` (string or StyledText), the same color props, `wrapMode`, `keyBindings`
  (merged over the defaults), `keyAliasMap`.
- **Events:** `onSubmit()`, `onContentChange`, `onCursorChange`, `onKeyDown`.
- **Instance API:** `plainText`, `logicalCursor` (`{row,col,offset}`), `extmarks`, `submit()`.
- **Default keys:** `return` inserts a newline; **`meta+return` (alt+enter) submits**.
- Adding `keyBindings={[{name:"s", ctrl:true, action:"submit"}]}` made ctrl+s submit as well.
- In legacy mode, iTerm-style shift+enter (`ESC \r`) parses as meta+return, so it submits.
- Actions: `move-*`, `select-*`, `line-home`/`line-end`, `buffer-home`/`buffer-end`, `delete-*`, `newline`, `undo`,
  `redo`, `word-*`, `select-all`, `submit`.

**Select:**
- **Props:** `options: {name, description, value?}[]`, `selectedIndex`, `showDescription`, `showSelectionIndicator`,
  `showScrollIndicator`, `wrapSelection`, `itemSpacing`, `fastScrollStep`, colors, `keyBindings`.
- **Keys:** up/k, down/j, shift+up/down to move fast, enter to select.
- **Events:** `onChange(index, option)` on each move and `onSelect(index, option)` on enter. Pressing j, j, k, enter gave
  `change 1, change 2, change 1, select 1`.

**TabSelect:**
- **Props:** `options`, `tabWidth`, `showUnderline`, `showDescription`, `showScrollArrows`, `wrapSelection`.
- **Keys:** left/`[` and right/`]`, enter.
- **Events:** the same `onChange` and `onSelect`. Pressing right, `]`, enter gave `change 1, change 2, select 2`. The
  underline marks the selected tab.

**Image:**
- **Props:**
  - `source`: a path, URL, `Uint8Array`, `ArrayBuffer`, `Blob` or `Response`.
  - `fit: "fit"|"cover"|"fill"`, `crop`.
  - `protocol: "auto"|"kitty"|"sixel"|"blocks"`.
  - `onLoad(img)` and `onError`.
- A 2x2 PNG from bytes loaded (`onLoad 2x2`) and drew colored half-blocks (protocol `blocks` in the test renderer).
- **A malformed image** makes `NativeImage.load` reject with `ImageError: malformed image data`.
- **Local-first warning:** a `string`/`URL` source can be an http(s) URL, and `ImageLoadError` has a `network` code, so it
  fetches. Load from local bytes.

**Focus between widgets.** Use the `focused` prop or `renderable.focus()`. Only one renderable is focused at a time;
focusing one blurs the previous one.

---

## 12. Testing

**APIs**
- **Setup:**
  - `createTestRenderer(opts)` from `@opentui/core/testing`, or `testRender(node, opts)` from `@opentui/react/test-utils`.
    `testRender` sets `IS_REACT_ACT_ENVIRONMENT`, renders inside `act`, and unmounts on destroy.
  - **Options:** `width`, `height`, `kittyKeyboard`, `otherModifiersMode`, `clock`, and any `CliRendererConfig`. The test
    defaults are `screenMode:"main-screen"`, `consoleMode:"disabled"` and `externalOutputMode:"passthrough"`.
- **Rendering and waiting:** `renderOnce()` (one frame), `flush()` (until visually idle), `waitFor(pred)`,
  `waitForFrame(pred)`, `waitForVisualIdle()`, `resize(w,h)`, `dispose()` (also `Symbol.asyncDispose`).
- **Inspection:** `captureCharFrame()` (rows joined with `\n`), `captureSpans()` (a `CapturedFrame`), `externalOutput`,
  `getNativeStats()`.
- **Input:**
  - `mockInput`: `pressKey(key, {shift,ctrl,meta,super,hyper})`, `pressKeys`, `typeText`, `pressEnter`, `pressEscape`,
    `pressTab`, `pressBackspace`, `pressArrow`, `pressCtrlC`, `pasteBracketedText`. `KeyCodes` has `RETURN`, `F1`–`F12`
    and so on.
  - `mockMouse`: `click`, `doubleClick`, `moveTo`, `pressDown`, `release`, `drag(x1,y1,x2,y2)`, `scroll(x,y,dir)`,
    `emitMouseEvent`.
  - Raw bytes: `renderer.stdin.emit("data", Buffer.from(seq))`.
- **Also exported:** `ManualClock` (pass it as `clock`), `createMockTreeSitterClient`, `setRendererCapabilities`,
  `TestRecorder`.

**CapturedFrame shape** (verified):
```ts
interface CapturedFrame { cols: number; rows: number; cursor: [number, number]; lines: { spans: CapturedSpan[] }[] }
interface CapturedSpan  { text: string; fg: RGBA; bg: RGBA; attributes: number; width: number }
```
- RGBA channels are **floats 0..1** (`fg.r`; `fg.toInts()` gives 0..255).
- An empty background is `0,0,0,0` (transparent).
- Adjacent cells with identical style merge into one span, even across elements.
- A wide glyph counts 2 in `width`.
- Check `fg.intent` (`rgb`, `indexed` or `default`) when exporting: an `indexed` or `default` color needs a palette lookup
  for SVG or HTML.
- `frameToHtml()` in [12-testing.test.tsx] converts a frame to `<pre><span style=…>`.

**Recommended Bun pattern** [12-testing.test.tsx; 3 tests pass and 2 snapshots were written]:
```tsx
let current: TestRendererSetup | null = null;
afterEach(async () => { if (current) await act(async () => current!.dispose()); current = null; });
test("…", async () => {
  current = await testRender(<Counter />, { width: 30, height: 4 });
  await current.renderOnce();
  await act(async () => { current!.mockInput.pressKey("+"); });     // input inside act()
  await current.waitFor(() => current!.captureCharFrame().includes("n=1"));
  expect(current.captureCharFrame()).toMatchSnapshot();
});
```

**Gotchas (all observed):**
1. **Calling `dispose()` outside `act()`** prints React's "not wrapped in act(...)" warning. Wrap it in `act`.
2. **State updates inside one `act()` are committed when `act` returns.** If a test changes focus through state and sends
   keys in the same `act`, the keys go to the *old* focused widget. Change focus in its own `act` first.
3. **`waitFor` and `waitForFrame` only advance frames; they do not wait for wall-clock timers.** An effect with
   `setTimeout(30)` made `waitForFrame` throw "Timed out waiting for frame predicate after 20 passes" within 0.6 ms
   [12-waitfor-probe]. Sleep inside `act` first, or inject time through `ManualClock` and the renderer clock.
4. **Lone `ESC` is held for about 20 ms** in legacy mode, so wait before asserting.
5. **`copyToClipboardOSC52` throws** in the test renderer.
6. **Code and diff highlighting is async.** Await `codeRenderable.highlightingDone` before capturing or disposing (§8).
7. **Tree-sitter creates directories in the user data dir** (§8). Point `XDG_DATA_HOME` at a temp dir in tests
   (`spikes/opentui/fixtures/temp-data-home.ts`).

---

## 13. Debugging and errors

[13-errors-console]

**Logging without corrupting the TUI.**
- With `consoleMode:"console-overlay"` (the default for real renderers), the renderer **replaces `global.console`**. log,
  info, warn, error and debug are captured; nothing goes to stdout.
- **Overlay API:** `renderer.console.show() / hide() / toggle() / clear() / focus() / blur()` and `.visible`.
- **Overlay options** (`consoleOptions`): `position`, `sizePercent` (default 30%), `zIndex`, colors, `title`,
  `maxStoredLogs`, `keyBindings`, `onCopySelection`.
- **When focused, the overlay has its own key bindings:** up/down, **ctrl+p and ctrl+o** (move the panel), `+`/`-`, ctrl+s,
  ctrl+shift+c. Keep it unfocused, or rebind, so it does not shadow app shortcuts.
- Destroying the renderer restores the original console.
- For persistent logs, write to a file. Do not use stdout.

**Env switches:** `OTUI_USE_CONSOLE=false` (no capture), `OTUI_DUMP_CAPTURES` (dump captured output on exit),
`OTUI_STDIN_LOG=<file>` (record raw input), `OTUI_SHOW_STATS`/`OTUI_DEBUG` or `renderer.toggleDebugOverlay()` (debug
overlay).

**Errors.**
- **Exception during a React render:**
  - The built-in root `ErrorBoundary` replaces the *whole app* with the stack in red, and the error is also logged.
  - Fixing state does not recover; only the next `root.render()` call does.
  - **Put our own error boundaries around each panel.**
- **Uncaught exceptions and unhandled rejections** are **swallowed** by the renderer's process handlers. They are logged,
  and the console overlay opens when `openConsoleOnError` is set. The process keeps running.
- **A throwing key handler** is caught and logged (`[KeyHandler] Error in global keypress handler`); later listeners still
  run.
- **A throwing mouse handler** emits `HANDLER_ERROR {error, event}` if something listens, otherwise it is logged.
- **A throwing `renderSelf`** emits `RENDER_ERROR {error, renderable}`.

---

## 14. Packaging

[14-compile builds 14-compile-app into a temp dir.] **`bun build --compile` works on darwin-arm64.**
- The build bundled 39 modules in about 0.2 s; the binary is **79 MB**.
- Run from an unrelated directory, `<code filetype="typescript">` highlighted in about 95 ms. The worker and the wasm
  grammars are embedded (`/$bunfs/root/…`).
- In a PTY, the real renderer drew a frame, left the alt screen and exited with 0.

**Gotchas.**
- **The native library is unpacked to `$TMPDIR/.<hash>-00000000.dylib` on every launch** (6.9 MB) and never cleaned up.
  `OPENTUI_LIB_PATH` and `OTUI_ASSET_ROOT` override the paths (from source, UNVERIFIED).
- **Cross-compiling** with `--target=bun-linux-x64` failed with `Could not resolve "@opentui/core-linux-x64"`. Each
  target's optional native package must be installed first.

---

## 15. Recommendations

### (a) `@opentui/react` vs imperative `@opentui/core` vs `@opentui/solid`

**Recommendation: keep the plan.** Use React for the shell, panels, dialogs and forms, and custom core renderables
registered with `extend()` for the hot views (file tree or list, editor and diff surfaces).

Evidence:
- **React works on 0.9.1** and covers every widget used here: layout, focus, inputs, scrollbox, code, diff, portals,
  refs, extend.
- **No blocking issue was found.**
- **Reconciliation cost is the real limit:** re-rendering a parent of 10k children costs 12 ms (memoized rows) to 29 ms
  (not memoized) per change; a 30-row virtual window costs 0.14–0.22 ms; a custom renderable over 100k items costs
  0.17 ms per keypress, React round trip included.
- **Native scrolling is nearly free** (0.3–0.5 ms).

Things to design around:
1. **`useKeyboard` order is child-first.** Build the key router on `renderer.keyInput.prependListener` (§4), not on a
   root `useKeyboard`.
2. **The root `ErrorBoundary` takes down the whole UI.** Add per-panel boundaries.
3. **Tests need `act()` discipline** (§12).

Not evaluated:
- `@opentui/solid` is not installed, so it was not tested (UNVERIFIED). Nothing found here suggests it is needed.
- Pure imperative core would avoid the reconciler but gives up composition; `extend()` already gives us that escape
  hatch inside React.

### (b) Code viewer and diff viewer: built-ins or custom?

**Code viewer: start with the built-in `<line-number>` + `<code>`.**

| Need | Built-in support |
|---|---|
| Active-line highlight | `setLineColor(i, {gutter, content})` colors the whole row. There is no caret, so draw one in `renderAfter` if needed |
| Search-match highlight | `onHighlight` plus a `search.match` style group works, but **each query change re-highlights the whole file** (about 105 ms on 5k lines). For as-you-type search, paint matches for the visible rows in `renderAfter` (approach UNVERIFIED) |
| Horizontal scroll | `scrollX` with `wrapMode="none"` works; no horizontal scrollbar |
| Click-to-line | `onMouseDown` + `scrollY` + `lineInfo.lineSources`, wrap-aware (verified) |
| Scroll position | `scrollY`/`scrollX` read and write, `maxScrollY`. Keeping a target line visible is up to us |
| Very large files | Painting is virtualized (0.12 ms per scroll frame), but the **whole file lives in one buffer and every edit re-highlights everything**: 1 s and a 26 ms main-thread stall at 50k lines. Above a threshold (about 20k lines or 1 MB), fall back to plain text or a custom windowed renderable |
| Languages | Only JS, TS, TSX, Markdown and Zig work offline. Vendor more grammars (§8) |

**Diff viewer: use the built-in `<diff>` only for a simple read-only preview. Build the Source Control diff view as a
custom component**: our own hunk model rendered with `<line-number>` + `<code>`, using `setLineColor`/`setLineSign` for
the add/remove styling.

Built-in `<diff>` limits: one file per instance; strict hunk counts; no `@@` headers or separators between hunks; one
line-number column in unified view; no word-level diff; no public scroll API (needs a wrapping scrollbox); no hooks for
per-hunk stage or revert.

---

## 16. UNVERIFIED items

- Real-terminal OSC 52 copy; the host clipboard service (`createHostClipboard`, `createClipboard`).
- Terminal-generated signals (^C, ^Z, SIGWINCH from a real resize): Bun's PTY does not make the child the foreground
  process group, so signals were sent by hand.
- Replies from WezTerm, tmux, iTerm2 and Terminal.app (only kitty-style replies were simulated).
- `getPalette()` / `PALETTE`; `split-footer` mode; `layoutMode: "list"` performance; `@opentui/solid` (not installed).
- The `update-assets` CLI (needs the network); `OTUI_ASSET_ROOT` / `OPENTUI_LIB_PATH`; diff `syncScroll`; injections
  other than markdown fences.
- Linux, and cross-target `bun build --compile` with the target's native package installed.
- Whether the renderer's swallowing `uncaughtException` handler can hide failures under `bun test`.
- Painting search matches in `renderAfter` on top of `<code>` (suggested approach, not tried).

---

## 17. Spike index

Run from the repo root with `bun run spikes/opentui/<name>` (gitignored scratch code). Spikes that render `<code>`,
`<markdown>` or `<diff>` import `fixtures/temp-data-home.ts` first, which points tree-sitter's data dir at a temp dir.

| Spike | § | What it shows |
|---|---|---|
| `01-pty-driver.ts <mode> [flags]` | 1 | Runs `01-bootstrap-child.tsx` (a real renderer; do not run it directly) in a Bun PTY and prints decoded escape sequences and events. Modes `full wait jobctl idle-return nomove nokitty kittyoff`; flags `--answer --light --resize --sigterm --sigint --ctrlc --ctrlz --cont --flip-theme`. Example: `bun run spikes/opentui/01-pty-driver.ts full --answer` |
| `00-hello.tsx` | 2, 12 | Smoke test of `testRender`, `captureCharFrame`, `captureSpans` |
| `02-perf-virtual-list.tsx` | 2 | 10k rows: naive, memoized, virtualized timings |
| `02-react-extend.tsx` | 2 | `extend()` custom list over 100k items, refs, `createPortal`, built-in ErrorBoundary |
| `03-layout-shell.tsx` | 3 | IDE shell at 120x35 and 90x28, modal with alpha backdrop, toast, `resize`, `visible={false}` |
| `04-keys-parse.ts` | 4 | Legacy vs kitty parse table, `mockInput` encoding, full `KeyEvent` objects |
| `04-keys-dispatch.tsx` | 4 | Dispatch order, router with modal capture, `prependListener`, ESC timing, `focused_renderable` |
| `04-paste.tsx` | 4 | Bracketed paste, `usePaste` + `preventDefault`, split chunks |
| `05-mouse.tsx` | 5 | Event shape, bubbling, hover, wheel, divider drag capture, double-click, selection, OSC 52 in tests |
| `06-text.tsx` | 6 | `parseColor`, attributes, StyledText, glyph widths, wrap/truncate, opacity |
| `07-scrollbox.tsx` | 7 | `scrollTo`/`scrollBy`/`scrollChildIntoView`, keys, wheel, sticky bottom |
| `08-code-highlight.tsx` | 8 | SyntaxStyle, async highlighting, unknown filetypes, worker logs, data-dir writes, fetch monitor |
| `08-code-perf.tsx` | 8 | 5k-line first paint and highlight timings (cold, warm, edit, scroll) |
| `08-code-mainthread-lag.tsx [lines]` | 8 | Main-thread stall during highlighting |
| `08-code-extras.tsx` | 8 | `drawUnstyledText=false`, search-query re-highlight cost, wheel |
| `08-grammar-register.tsx` | 8 | Private `TreeSitterClient`, `addFiletypeParser`, http source behavior, `addDefaultParsers` |
| `08-line-number.tsx` | 8 | Line colors and signs, offsets, search highlight, `scrollX`, click-to-line |
| `08-markdown-table.tsx` | 8 | `<markdown>` features, TextTable through `extend` |
| `09-diff.tsx` | 9 | Unified and split at width 100, wrapping, theming, multi-file input, scrolling, hunk offsets, 5k/20k timings |
| `10-embedded-terminal-mount.tsx` | 10 | `extend()` mount, `write`, `onData`, resize |
| `11-widgets.tsx` | 11 | Input, Textarea submit bindings, Select, TabSelect, Image |
| `12-testing.test.tsx` | 12 | Bun snapshot pattern and `frameToHtml`; run with `bun test spikes/opentui/12-testing.test.tsx` |
| `12-waitfor-probe.tsx` | 12 | `waitForFrame` does not wait for wall-clock timers |
| `13-errors-console.tsx` | 13 | Console capture, key/mouse/render error paths, root boundary reset, uncaught errors |
| `14-compile.ts` | 14 | Compiles `14-compile-app.tsx` into a temp dir and runs it headless and in a PTY (the app also runs uncompiled) |
