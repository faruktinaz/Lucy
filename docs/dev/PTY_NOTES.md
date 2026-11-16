# PTY, terminal sessions and the Claude Code adapter

Status: phase 1 (no React UI). Everything below was measured on macOS (Darwin 27.3, Apple
Silicon) with Bun 1.3.14, OpenTUI 0.9.1, Claude Code 2.1.325, zsh 5.9, micro 2.0.15, unless
marked otherwise. Spikes live in `spikes/pty/` (gitignored) and can be re-run with `bun <file>`.

Code: `src/adapters/pty/` (PTY, sessions, renderable glue) and `src/adapters/agents/`
(providers, session discovery, session manager, prompt templates).

---

## 1. What the UI engineers must know (short version)

1. **Create the renderer with `exitOnCtrlC: false`.** OpenTUI's default installs a *global*
   key listener that exits the app on Ctrl+C even while a terminal has focus.
2. **Keep one `EmbeddedTerminalRenderable` per session alive for the session's lifetime.** Hide it
   with `visible={false}`; never unmount it while the session runs (React destroys unmounted
   renderables, see section 5.1). A hidden renderable keeps parsing output and answering terminal
   queries; replay is only the fallback.
3. **Wire it with `connectEmbeddedTerminal(session, renderable, { screenPrelude })`** from
   `@/adapters/pty`. Do not also pass `onData`/`onTerminalResize` props from React.
4. **Pass `maxScrollback` explicitly, in bytes.** The default keeps only about 390 rows at 160
   columns. 16 MB gives about 10 000 rows at 160 columns.
5. **Escape hatches**: a global `useKeyboard` handler that calls `key.preventDefault()` for a tiny
   set of chords (section 6). Everything else, including Ctrl+R, goes to the PTY.
6. **Dispose PTYs on quit**: create one `PtyRegistry`, spawn through `registry.spawn`, call
   `installPtyShutdownHooks(registry)` at bootstrap, and call `registry.disposeAll()` when the
   renderer is destroyed (OpenTUI's signal handler destroys the renderer but does not exit).
7. Claude Code's first screen in a new folder is its **workspace trust dialog**; Lucy must show it
   and let the user answer. Lucy never answers it, never submits prompts, never adds permission
   flags.

---

## 2. Bun's built-in PTY (verified)

API: `Bun.spawn(argv, { cwd, env, terminal: { cols, rows, name, data(term, bytes), exit(term, status), drain(term) } })`.
`proc.terminal` has `write(string | BufferSource)`, `resize(cols, rows)`, `close()`, `closed`,
`setRawMode`, termios flag accessors, `ref/unref`. `proc.stdin/stdout/stderr` are `null`.

| Fact | Evidence |
| --- | --- |
| Child is a session leader, PTY is its controlling tty (`getsid == getpid == tcgetpgrp`) | spike 01 (python `os.getsid`) |
| `exited` resolves 128+n on signal death; `exitCode` null, `signalCode` = name (`"SIGTERM"`) | spike 01 |
| `Subprocess.killed` is `true` even after a normal exit: unusable | spike 01 |
| `terminal.exit` (PTY EOF) fires **before** `exited` when the tree ends; all data precedes it | spike 01, test "delivers every byte before the exit event" |
| On macOS the leader's exit revokes the tty: EOF arrives even if a SIGHUP-ignoring grandchild survives (it ends up with no tty, PPID 1) | spike 03 |
| The terminal stays open after exit and leaks 2 fds until GC unless `close()`d | spike 02 |
| Spawn errors (ENOENT, EACCES, missing cwd) throw synchronously, leak nothing | spike 16, tests |
| `cols/rows` 0 at spawn silently become 80x24; `resize(0,0)` and `resize(70000,..)` throw | spike 16 |
| `write()`/`resize()` throw "Terminal is closed" after `close()`; `kill()` after exit is harmless | spike 16 |
| Every PTY read is its own event-loop task, ~90 bytes on macOS (50 MiB from `yes` = ~600k callbacks) | spikes 03, 04 |
| Retained `data` chunks are fresh buffers (not reused) | spike 04 |
| Backpressure works: a slow consumer does not grow RSS; the child blocks on write | spike 03 (10 MiB, +0.1 MiB RSS) |

### Design consequences (`spawnPty`)

- Exit is emitted only after **both** the process exit and PTY EOF, or after a 250 ms drain
  timeout (Linux keeps the slave open while a grandchild holds it). Output is flushed first, then
  the master is closed (no fd leak), then `onExit` fires once.
- Output is coalesced per timer tick (`setTimeout(0)`): microtasks and `setImmediate` do not batch
  across Bun's per-read tasks. 20 MiB went from ~190 000 callbacks to ~470 flushes for ~15% wall
  time. A batch is flushed synchronously at 256 KiB, so memory stays bounded. `coalesce: false`
  restores raw delivery.
- Bytes are passed through untouched. The PTY layer never decodes UTF-8 (a chunk can end inside
  "ğ" = C4 9F; test "Turkish output split across chunks").
- Sizes are clamped to 1..65535 (`clampTerminalSize`).
- Payloads are never logged; only pid, command name, size, exit code.

---

## 3. Process groups, tree kill, abrupt death

Interactive zsh puts every job in its **own process group** (job control). Measured (spike 02):

| Action on `zsh -f -i` running `sleep &` and a foreground `sleep` | Result |
| --- | --- |
| SIGHUP to the shell | shell forwards HUP to its jobs: everything dies |
| SIGTERM to the shell | **ignored** by interactive zsh: nothing dies |
| SIGKILL to the shell, or to its group | foreground job dies (kernel hangup), **background job survives**, reparented to PID 1, tty lost |

So `kill -9 -$pgid` is not a tree kill. `killProcessTree` (async) / `killProcessTreesSync`:

1. Snapshot with `ps -A -o pid,ppid,pgid[,sid],stat,tty`. Members = processes on the PTY's tty, in
   the leader's session (Linux only; macOS `ps` has no sid column), plus all their descendants.
   Lucy's own pid and process group are never signalled.
2. Signal every member **group** and pid: SIGHUP (+SIGCONT for stopped jobs), wait the grace period
   (500 ms async, 150 ms sync), SIGTERM (+SIGCONT), wait, SIGKILL.
3. Re-snapshot at every step and **remember earlier members**: once the leader dies, orphaned jobs
   vanish from tty and parent links.
4. The sync variant (exit and signal handlers, where Bun cannot reap) judges liveness from `ps`
   (zombies excluded) and handles all trees in one pass, so shutdown pays the grace once.

Tests verify with `ps`: zsh background + foreground jobs die; a grandchild that ignores SIGHUP and
SIGTERM dies only after the ladder escalates; `process.exit()` and SIGTERM in a child process
running the registry leave nothing behind (`tests/pty/pty-registry.test.ts`).

**Abrupt death of Lucy (SIGKILL, crash), spike 05:** the kernel closes the PTY masters; session
leaders get SIGHUP; zsh forwards it to its jobs; a non-interactive `sh` session's foreground group
gets SIGHUP. Everything died except a process that **ignores SIGHUP** (it survived, keeping its
tty). Nothing in user space can catch SIGKILL; this matches every terminal emulator.

---

## 4. Child environment (`buildPtyEnv`)

- The child inherits the user's environment **unchanged** (PATH, tokens, SSH agent, CLI auth,
  shims). This preserves their CLIs' credentials and permissions.
- Set: `TERM=xterm-256color`, `COLORTERM=truecolor` (what libghostty-vt implements; DA1 answers
  `CSI ? 62;22 c`), `TERM_PROGRAM=lucy` (+ `TERM_PROGRAM_VERSION` when the app passes it). Lucy
  identifies itself honestly, as tmux does; it never claims to be the outer terminal.
- Removed: identity of the **outer** emulator or multiplexer, which is false inside Lucy:
  `TERM_PROGRAM(_VERSION)`, `TERM_SESSION_ID`, `LC_TERMINAL(_VERSION)`, `VTE_VERSION`,
  `WT_SESSION`, `WT_PROFILE_ID`, `TERMINAL_EMULATOR`, `TERMINATOR_UUID`, `TILIX_ID`,
  `GNOME_TERMINAL_*`, `WARP_IS_LOCAL_SHELL_SESSION`, `TMUX`, `TMUX_PANE`, `STY`, `ZELLIJ*`,
  prefixes `GHOSTTY_ ITERM_ KITTY_ WEZTERM_ ALACRITTY_ KONSOLE_`, and stale `COLUMNS`/`LINES`.
  A program that sees `TMUX` wraps sequences for tmux passthrough; one that sees
  `TERM_PROGRAM=ghostty` may assume Ghostty-only features.
- Kept on purpose: `CMUX_*` (host integration that the user's `claude` shim relies on; not about
  the tty) and `TERMINFO` (verified harmless: with Ghostty's `TERMINFO`, `xterm-256color` still
  resolves from the system database).
- Explicit overrides (`env` option) win over everything. Locale is not touched.

---

## 5. `EmbeddedTerminalRenderable` deep dive

libghostty-vt in a native renderable. It does not manage a process; `connectEmbeddedTerminal`
glues it to a `TerminalSession`. All results below are from headless runs with
`createTestRenderer` and real PTYs (spikes 06-10, 14, 15 and `tests/pty/embedded-terminal.test.ts`).

### 5.1 Mounting from React

```tsx
import { EmbeddedTerminalRenderable } from "@opentui/core";
import { extend } from "@opentui/react";
import { connectEmbeddedTerminal, type TerminalSession } from "@/adapters/pty";

declare module "@opentui/react" {
  interface OpenTUIComponents { "embedded-terminal": typeof EmbeddedTerminalRenderable }
}
// Call once during UI bootstrap (not at import time).
export function registerTerminalComponent(): void {
  extend({ "embedded-terminal": EmbeddedTerminalRenderable });
}

function TerminalPane({ session, visible, focused }: { session: TerminalSession; visible: boolean; focused: boolean }) {
  const ref = useRef<EmbeddedTerminalRenderable>(null);
  useEffect(() => {
    const term = ref.current;
    if (!term) return;
    const link = connectEmbeddedTerminal(session, term, { screenPrelude: themeColorsOsc });
    return () => link.dispose();
  }, [session]);
  useEffect(() => { focused ? ref.current?.focus() : ref.current?.blur(); }, [focused]);
  return <embedded-terminal ref={ref} width="100%" height="100%" maxScrollback={16_000_000} visible={visible} />;
}
```

- The React reconciler calls `destroyRecursively()` on unmount (`detachDeletedInstance`), which
  destroys the native emulator. Render the pane for every live session and toggle `visible`.
- `visible=false`: still consumes output, still answers queries (DSR answered while hidden), and
  the screen is current when shown (spike 08). It reports no size while hidden and the new size
  when shown (spike 15). Removing (not destroying) a renderable from the tree behaves the same.
- `screenPrelude`: libghostty's default colours are white on black and are what OSC 10/11 queries
  return (programs use them for light/dark detection). Writing `OSC 10/11 ; rgb:..` **into the
  emulator** sets them; queries then report Lucy's theme (spike 08). An app's `OSC 111` resets
  them to the built-in black.

### 5.2 Focus and key flow

```
outer terminal bytes -> renderer stdin parser -> KeyEvent
  1. global listeners (renderer.keyInput.on("keypress"), React useKeyboard), in order;
     includes OpenTUI's exitOnCtrlC listener unless disabled
     -> key.preventDefault() or stopPropagation() stops delivery to the renderable
  2. focused renderable: its onKeyDown prop, then (if not prevented) handleKeyPress
     -> EmbeddedTerminal.encodeKey(key) -> onData(bytes, "input") -> connectEmbeddedTerminal
     -> session.sendInput -> PTY
```

- Yes: the focused renderable turns key presses, key releases (when reported), pastes
  (`handlePaste` -> `encodePaste`), mouse and focus changes into `onData(..., "input")` itself.
- Left click focuses it. When it gains/loses focus and the app enabled focus reporting
  (`?1004`, Claude Code does), it sends `CSI I` / `CSI O`.
- Interception points the host still has: global `keypress`/`paste` listeners (first), the
  renderable's `onKeyDown` (second). Verified in spike 14. Mouse events outside the terminal
  never reach it.

### 5.3 Key encoding (`encodeKey`) and the kitty question

`encodeKey` follows the mode the **inner** application requested; the emulator answers the
`CSI ? u` query with the current flags (`CSI ? 0 u` initially, `CSI ? 1 u` after the app pushed
`CSI > 1 u`). Measured through the full input path (spike 07):

| Key | outer legacy, inner legacy | outer legacy, inner kitty flags 1 | outer kitty, inner legacy |
| --- | --- | --- | --- |
| Enter | `\r` | `\r` | `\r` |
| Shift+Enter | `\r` (indistinguishable) | `\r` | `CSI 27;2;13~` (inner flags 1: `CSI 13;2u`) |
| Ctrl+C | `\x03` | `CSI 99;5u` | `\x03` |
| Ctrl+R | `\x12` | `CSI 114;5u` | `\x12` |
| Alt+b | `ESC b` | `CSI 98;3u` | `ESC b` |
| Arrows | `CSI A..D` | `CSI A..D` | `CSI A..D` |
| F1 / F5 / F12 | `ESC O P` / `CSI 15~` / `CSI 24~` | `CSI P` / `CSI 15~` / `CSI 24~` | same as legacy |
| Escape | `ESC` | `CSI 27u` | `ESC` |
| ç ğ ı İ Ş | UTF-8 text | UTF-8 text | UTF-8 text |
| Ctrl+I vs Tab | (legacy cannot distinguish) | | `CSI 105;5u` |
| Super+K (Cmd) | nothing | `CSI 107;9u` (outer kitty only) | nothing |

With inner flags 31 (report all) Enter becomes `CSI 13u`. Shift+Enter can only work if the
**outer** terminal reports it; OpenTUI asks the outer terminal for kitty flags 5 by default
(Ghostty, kitty, WezTerm, foot, recent iTerm2 support it). Turkish letters are plain UTF-8 text in
every mode. Mouse wheel without mouse tracking scrolls the viewport and sends nothing.

### 5.4 Paste

- `encodePaste` without bracketed paste: LF becomes CR, and CRLF becomes CR CR (two Enters).
  With `?2004h`: wrapped in `CSI 200~ .. CSI 201~`, newlines kept. In both cases libghostty
  replaces ESC and most C0 controls with spaces, so `ESC[201~` injection cannot end the paste
  early (spike 08).
- `TerminalSession.paste(text)` (programmatic paste, e.g. prompt templates) mirrors this using the
  sniffer's view of mode 2004: normalizes CRLF, strips control characters, brackets when enabled.
  It **never appends Enter**; without bracketed paste it also drops a trailing newline (which would
  submit), and returns `{ sent, bracketed, multiline }` so the UI can warn about multi-line
  pastes into programs without bracketed paste. zsh enables bracketed paste; a pasted command line
  appears but does not run (test).

### 5.5 Resize

Layout change -> `onResize` -> native resize -> `onTerminalResize(cols, rows)` ->
`session.resize` -> `pty.resize` -> SIGWINCH. Verified with `stty size` (test: 80x24 -> 100x30).

### 5.6 Terminal query responses

The emulator answers via `onData(bytes, "response")`; they must be written to the PTY
(`session.sendResponse`, which is not counted as user input):

| Query | Answer |
| --- | --- |
| DA1 `CSI c` | `CSI ? 62;22 c` |
| DA2 `CSI > c` | `CSI > 1;0;0 c` |
| DSR `CSI 6n` / `CSI 5n` | `CSI row;col R` / `CSI 0 n` |
| OSC 10 / 11 / 4;n `?` | `rgb:ffff/ffff/ffff` / `rgb:0000/0000/0000` / palette (terminator echoed) |
| XTVERSION `CSI > 0 q` | `DCS > \| libghostty ST` |
| kitty `CSI ? u` | `CSI ? <flags> u` |
| DECRQM `?2004` / `?2026` | `CSI ? 2004;2 $y` / `CSI ? 2026;2 $y` |
| DECRQSS SGR | `DCS 1 $ r 0m ST` |
| XTWINOPS 14t / 18t / 16t | no answer |

End to end: a program in the PTY sending DSR receives `CSI r;c R` (test). During replay into a new
screen, responses are discarded (they would answer questions asked long ago).

### 5.7 Alternate screen, scrollback, selection, mouse

- `less`, `vim -u NONE`, `micro` (isolated HOME): correct content including Turkish, `?1049h`
  used, primary screen restored on exit (spike 09). micro also enables mouse `?1000/1002/1006`.
- `getScroll()` -> `{ offset, total, visible }`. Wheel up scrolls 3 rows; new output does **not**
  snap the viewport back; `CSI 3J` clears scrollback. There is **no public programmatic scroll
  API** (the private `lib.contextEmbeddedTerminalScroll` works but is not API): synthesize wheel
  events or ask OpenTUI for one.
- `maxScrollback` is in **bytes** of page memory (page granular): default ~ 388 rows at 160 cols;
  1e7 -> 6 625 rows at 160 cols (~1.5 KB/row).
- Selection: mouse drag selects (cell-accurate); `term.getSelectedText()` or
  `renderer.getSelection()?.getSelectedText()`; copy with `renderer.copyToClipboardOSC52(text)`.
- Mouse forwarding when the app enabled tracking: SGR `CSI < 0;4;3 M/m`, wheel `CSI < 65;..M`.

### 5.8 Throughput (spike 10, ~20 MiB of 24-bit coloured log lines, 160x48)

| Path | Time | Rate | RSS delta |
| --- | --- | --- | --- |
| Direct `write()` 64 KiB chunks, default scrollback | 97 ms | ~200 MiB/s | +8.6 MiB |
| Direct, `maxScrollback` 1e6 | 92 ms | ~217 MiB/s | +2.1 MiB |
| Real PTY (`cat`) + coalescing, default | 252 ms | ~80 MiB/s | +5.4 MiB |
| Real PTY + coalescing, `maxScrollback` 1e7 | 254 ms | ~79 MiB/s | +9.0 MiB |
| **Production path**: `spawnPty` + `TerminalSession` (sniffer, 2 MiB ring) + `connectEmbeddedTerminal`, `maxScrollback` 16e6 (10 881 rows kept) | 449 ms | ~45 MiB/s | +35 MiB |

The PTY, not the emulator, is the bottleneck. The sniffer alone runs at ~243 MiB/s and the ring
buffer plus evicted-byte sniffer at ~273 MiB/s (spike 17); a memchr-style fast path for text runs
is an easy later optimization. 50 MiB through `spawnPty` stays under +200 MiB RSS
(test bound; measured +7 MiB in spike 03).

### 5.9 Attach/detach: keep-alive vs replay (decision)

Keep-alive is the primary design, replay the fallback (`TerminalSession` implements both):

- Programs query the terminal at any time (Claude Code sends XTVERSION, kitty `CSI ? u`, DA1,
  DECRQM at startup). Only a live emulator can answer in time; a replay buffer cannot.
- The emulator holds the exact screen, scrollback and modes. A byte ring buffer replayed into a
  fresh emulator loses everything before its window: an inline TUI like Claude Code (no alternate
  screen) redraws incrementally with relative cursor moves, so a truncated replay can be garbled
  until the next full redraw.
- Replay is still needed for screens created after the session started, or recreated after being
  destroyed. Mitigations implemented: a second sniffer is fed the **evicted** bytes, so replay
  first re-establishes the modes active at the cut (alt screen, bracketed paste, cursor keys,
  mouse, focus, kitty flags, modifyOtherKeys), then starts at a sequence and UTF-8 boundary;
  responses generated during replay are dropped. Default buffer 2 MiB.

### 5.10 Things the renderable does not expose

No title, bell, notification, progress or cwd events, and no mode getters. `TerminalStreamSniffer`
covers them from the byte stream: BEL; OSC 0/2 title; OSC 9 (iTerm2), OSC 777;notify
(urxvt/Ghostty), OSC 99 (kitty, chunked, base64) notifications; OSC 9;4 progress; OSC 7 cwd;
DEC modes; kitty push/pop/set; modifyOtherKeys; RIS. It handles sequences split at any byte,
treats 0x80-0x9F as UTF-8 continuation bytes (never C1), ignores BEL inside DCS/APC/OSC, bounds
payloads at 8 KiB, and sanitizes titles with `sanitizeForDisplay`.

---

## 6. Escape-hatch keybindings (recommendation)

Constraints: Cmd never reaches a TUI on macOS (the outer terminal owns it); legacy terminals cannot
distinguish Ctrl+Shift+letter from Ctrl+letter; shells, readline, Atuin (Ctrl+R), micro and Claude
Code use nearly every Ctrl+letter (Claude Code: Ctrl+C/D/L/O/R/T/B/G/V/Z/_, Shift+Tab, Esc Esc,
Alt+P/T, ...). So: one leader chord plus mouse, and nothing else intercepted.

1. **Leader: Ctrl+\\** (precedent: Neovim's `<C-\><C-n>` terminal escape). Ctrl+\\ only sends
   SIGQUIT, which nobody presses on purpose in an interactive TUI. Implement as a global
   `useKeyboard` handler that calls `preventDefault()` (verified to stop the PTY from seeing it):
   - leader, then `h/j/k/l` or arrows: move focus to the neighbouring panel;
   - leader, then `1..9`: switch to terminal/agent tab n; `n`: new agent session;
   - leader, then `p`: command palette; `e`/`g`/`f`: explorer / source control / search;
   - leader, then `[`: enter scrollback/copy mode for the terminal;
   - leader, then `q`: quit confirmation;
   - leader, then **Ctrl+\\ or `\\` again: send a literal `0x1c` to the PTY**, so SIGQUIT stays reachable;
   - leader, then any other key or a 1.5 s timeout: cancel silently (swallow), with a status-bar
     hint "Ctrl+\\ ...". Show the armed state in the status bar.
2. **Mouse**: clicking any other panel moves focus (clicks outside the terminal never reach it).
3. **Optional, outer-kitty only**: direct accelerators that legacy terminals cannot even send
   (e.g. Ctrl+Shift+P for the palette) may be intercepted when the outer terminal reports kitty
   flags; never rely on them as the only path.
4. Never intercept: Ctrl+R, Ctrl+C, Ctrl+D, Ctrl+Z, Esc, Tab/Shift+Tab, Alt+letters, arrows,
   function keys, Enter/Shift+Enter, or text. Make the leader configurable (Ctrl+] / Ctrl+Space
   are the fallbacks), and document it in the in-app help.

---

## 7. Claude Code inside a PTY

### 7.1 CLI facts (from `claude --version` / `claude --help`, 2.1.325)

| Flag | Meaning | Lucy use |
| --- | --- | --- |
| *(none)* | interactive session | mode `new` |
| `-c, --continue` | continue the most recent conversation in the current directory | mode `continue` |
| `-r, --resume [value]` | resume by session id or name, or open the picker (optional search term) | modes `resume-picker`, `resume <id>` |
| `--session-id <uuid>` | use a specific session id | future: let Lucy know the id up front (cmux's wrapper already injects one) |
| `--fork-session` | new id when resuming | not used |
| `-n, --name <name>` | display name (prompt box, picker, terminal title) | future option |
| `--settings <file-or-json>` | additional settings (hooks) | future status hooks (section 9) |
| `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--permission-mode bypassPermissions` | permission bypass | **never added**; warned when in user args |
| `-p, --print` | non-interactive; **skips the trust dialog** | warned when in user args |

### 7.2 First screen (80x24, throwaway temp dir, no input sent)

Spike 11 ran the real binary (`~/.local/bin/claude`, deliberately bypassing the cmux shim and with
`CMUX_*` blanked so the throwaway run could not touch the live cmux surface), sent **nothing**
except the emulator's automatic query answers, and killed the tree after ~4 s:

```
 Accessing workspace:
 /private/var/folders/.../lucy-spike-claude-XXXX
 Quick safety check: Is this a project you created or one you trust? (...)
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel
```

It needs interaction (the user's choice); the default selection is "No, exit". Startup traffic:
queries XTVERSION, kitty `CSI ? u`, DA1 (twice, as a sentinel), DECRQM 2026 and 1016, an unknown
`OSC 7501;?` (no answer), `CSI 16t` (no answer); enables bracketed paste `?2004`, focus reports
`?1004`, colour-scheme reports `?2031`; emits kitty keyboard `CSI < u` and `CSI > 5 u` (push
flags 5) and modifyOtherKeys `CSI > 4;2 m`; hides/shows the cursor; renders inline (**no alternate
screen**, so its history lives in the emulator's scrollback). The workspace path shown is the real
path (`/private/var/...`).

What the UI therefore needs: a live emulator attached from the first byte (startup queries need
answers), focus wiring (Claude tracks focus), kitty-capable outer terminal for Shift+Enter,
and a visible, focusable pane so the user can answer the trust dialog.

Side effects observed: `~/.claude.json` unchanged and no project transcript directory created;
Claude Code itself refreshed its own `~/.claude/remote-settings*` and `~/.claude/sessions`
bookkeeping on start (its normal startup behaviour, including its own network sync). Lucy never
writes there.

---

## 8. Agent layer

- `AgentProvider`: `id`, `displayName`, `capabilities`, `detect()`, `buildLaunch(mode, { cwd, extraArgs })`,
  optional `listSessions()`. Launch modes: `new`, `continue`, `resume-picker`, `resume <id>`.
- Claude provider: executable = config override (absolute path or command name) or
  `which("claude")`, **kept as resolved** (a PATH shim such as cmux's wrapper is launched as is).
  `claude --version` with a 5 s timeout. Extra args (config, then per launch) are appended
  verbatim; `inspectClaudeArgs` returns `PERMISSION_BYPASS`, `PROMPT_ARGUMENT`,
  `NON_INTERACTIVE` and `MODE_OVERRIDE` warnings using the `--help` option table (option values
  are not mistaken for prompts). Nothing is ever stripped or added.
- Session discovery (`listClaudeSessions`) is **best effort over an undocumented format**:
  `$CLAUDE_CONFIG_DIR|~/.claude` `/projects/<cwd with [^A-Za-z0-9] -> "-">/<uuid>.jsonl`. The
  encoding is lossy, so the `cwd` inside the file is checked (tried with the given and the real
  path). Title priority: `custom-title.customTitle` > `ai-title.aiTitle` > `summary.summary` >
  first human prompt (slash commands shown as `/cmd args`; meta and tool results skipped) >
  `last-prompt.lastPrompt`. `updatedAt` = newest record `timestamp` (else file mtime).
  `messageCount` = user+assistant records (not turns), only when the whole file was read. Only the
  first 64 KiB and last 128 KiB of a file are read. Missing directories and unparseable files give
  an empty/partial list plus a `problem` text. Tests use synthetic fixtures only; the real
  directory was inspected read-only for structure (keys and types, never contents).
- `AgentSessionManager`: create / list / get / rename / close / pastePrompt, state in a `Store`,
  `activity` = `working | idle | attention | exited`, derived by `deriveAgentActivity`. **"Waiting
  for approval" is heuristic in this phase**: a permission dialog is quiet output, so it shows as
  `idle` unless Claude rings the bell or sends a notification (then `attention`). Output within
  300 ms of the user's input is treated as echo, not work.
- Prompt templates (`Explain file/selection`, `Review diff`, `Write tests`, `Fix diagnostics`):
  pure builders, `@path` mentions (quoted when the path has spaces, `#Lstart-end` for selections:
  the format Claude Code's IDE integrations use, to be confirmed in the UI phase), no trailing
  newline. They are only pasted (`pastePrompt` -> bracketed paste), never submitted.

---

## 9. Later phase (notes only): precise status through Claude Code hooks

Feasible. `--settings <file-or-json>` accepts an inline JSON settings document per launch, so Lucy
could add, without touching any user file:

```json
{ "hooks": {
  "Notification": [{ "hooks": [{ "type": "command", "command": "<lucy-hook> notification" }] }],
  "Stop":         [{ "hooks": [{ "type": "command", "command": "<lucy-hook> stop" }] }],
  "PostToolUse":  [{ "matcher": "*", "hooks": [{ "type": "command", "command": "<lucy-hook> tool" }] }]
} }
```

`<lucy-hook>` is a tiny Lucy-owned executable that reads the hook JSON from stdin (session id,
event, message such as "Claude needs your permission to use Bash") and writes one line to a
Lucy-owned Unix socket whose path and a per-session token come from the PTY environment
(`LUCY_HOOK_SOCKET`, `LUCY_AGENT_SESSION`). That gives exact "needs approval", "turn finished" and
"tool ran" events.

Risks and requirements:
- **Collisions with other wrappers.** The user's cmux shim already injects `--settings` (and
  `--session-id`) for its own hooks. Two `--settings` flags may not merge (option parsing may keep
  only the last): verify, and prefer a mechanism that composes (e.g. a settings *file* that Lucy
  owns, or detection of an existing managed `--settings` and stepping aside).
- Hooks are commands run with the user's permissions on every event: the hook binary must be fast,
  never block (time out in milliseconds if the socket is gone), **always exit 0** (exit code 2
  blocks or feeds stderr back to Claude for some events) and print nothing on stdout (JSON on
  stdout can alter decisions).
- `--bare` and `--safe-mode` disable hooks per `--help` (whether `--settings` hooks survive
  `--bare` must be verified); managed policy can restrict hooks; users can see them in
  `/hooks`. Status must degrade to the byte-stream heuristic.
- The hook payload contains transcript paths and tool inputs: treat as sensitive, never log it.
- Keep the user's own hooks working (additional settings must add, not replace).

---

## 10. `@xterm/headless`

Not needed. The renderable covers emulation, `screen()`, scrollback, selection, key/paste/mouse
encoding and query answers; the sniffer covers title, bell, notifications and modes; tests run the
real renderable headless with `createTestRenderer`. Nothing in the repo imports it, and it is not a
dependency.

---

## 11. Known limitations

- Linux was not run; Linux-specific paths (session-id membership via `ps -o sid`, drain timeout
  for slaves held open after the leader exits) are implemented from documentation and unit-tested
  with synthetic `ps` output only.
- Processes that deliberately ignore SIGHUP survive an abrupt Lucy crash (kernel behaviour).
  Processes that outlive their session leader on macOS lose their tty and are not hunted later.
- `listProcesses` relies on `ps`; if `ps` is unavailable the tree kill degrades to the leader's
  own process group plus the leader.
- The sniffer keeps one kitty-keyboard stack (kitty keeps one per screen).
- `@"path with spaces"` and `@path#L1-2` mention forms were not exercised against Claude Code.
- No public programmatic scrollback API in OpenTUI 0.9.1.

## 12. Spike index (`spikes/pty/`, gitignored)

01 basics, 02 process tree + fds, 03 hangup + burst, 04 coalescing, 05 abrupt parent death,
06 renderable basics + queries, 07 key matrix, 08 paste / hidden / scrollback / selection / mouse /
colours, 09 alternate-screen apps, 10 throughput, 11 Claude first screen, 12 transcript structure
(prints key names and types only), 13 kernel `run()` timeout, 14 escape-hatch interception,
15 resize while hidden, 16 spawn and terminal edge cases, 17 sniffer throughput, 18 full pipeline
throughput. `harness.ts` glues a renderable to a PTY for spikes.
