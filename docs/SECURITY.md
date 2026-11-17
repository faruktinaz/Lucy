# Security

This document describes what Lucy Workspace does with your code and your machine, as the code
stands today (version 0.1.0). Where something is planned rather than implemented, it says so. Every other
statement was checked against the source file named next to it.

## 1. Principles

**Local only.** Lucy is a terminal program that reads the folder you open. It has no server, no
account and no cloud component.

**No telemetry.** None exists: no analytics, usage pings, crash reporting or update checks. The
application source (`src/`) contains no HTTP client, socket, WebSocket or `fetch()` call.

**No network access by Lucy itself.** Network traffic can happen while Lucy runs only in these
cases, which are the complete list found in the code and its libraries:

| Source | When | Controlled by Lucy? |
| --- | --- | --- |
| `git fetch`, `git pull`, `git push` | Only when you trigger them. No automatic or periodic fetch exists (nothing calls `GitService.fetch/pull/push` on its own). They use your Git config, SSH setup and credential helpers. The `ext::` transport is refused (`-c protocol.ext.allow=never`). | Started by you; Lucy sets the flags in `src/adapters/git/environment.ts` |
| Git lazy fetch in a partial clone | Prevented for background reads with Git 2.44 or newer: every read-only Git command (status, diffs, file contents, ignore checks, file listing, `git grep`) runs with `GIT_NO_LAZY_FETCH=1`, so a read that needs a missing object fails instead of downloading it (`src/adapters/git/environment.ts`; tested with a local `file://` partial clone in `tests/security/git-hardening.test.ts`). Older Git ignores the variable and still fetches on demand. Explicit user actions (switching branches, stash, fetch/pull/push) may fetch the objects they need, as they would in a terminal. | Yes, for reads (Git 2.44+) |
| Git filter drivers (for example git-lfs) | Run by Git according to repository config; see section 3. | No |
| Programs in the embedded terminal, including Claude Code | Whatever you, your shell or Claude Code do there (Claude Code talks to its API and syncs its own state). | No |
| Your external editor | Whatever the editor does once you open a file in it. | No |

Library code that can reach the network but is not used by Lucy:

- OpenTUI's Tree-sitter worker downloads a grammar or query whose path starts with `http(s)://`.
  Lucy's client rejects every non-absolute or URL source (`assertLocalSource` in
  `src/adapters/syntax/grammars.ts`); all grammars are local files.
- OpenTUI's `<image source="https://…">` and audio-stream URL playback. Lucy uses neither.
- `@opentui/react` imports `react-devtools-core` and connects to `ws://localhost:8097` when the
  environment variable `DEV` is exactly `true` at the moment the module is first evaluated
  (`node_modules/@opentui/react/chunk-xfw77prd.js`). This is a loopback connection to a React
  DevTools server, if one is running. `importWithoutReactDevTools` (`src/core/react-devtools.ts`)
  hides `DEV` only while that module graph is first imported and restores it, so the attempt never
  happens and your own `DEV` still reaches the embedded terminal (`tests/security/react-devtools.test.ts`).
  The launcher `bin/lucy` loads the whole application through it, and `src/main.ts` deliberately has
  no self-run block, so `bin/lucy` is the only way to start the app.

**Never modifies other tools' configuration.** No code writes shell startup files, Ghostty, tmux,
Atuin, Git config or Claude Code files (`~/.claude/`, `~/.claude.json`). Git settings Lucy needs are
passed per command with `-c`. The tool overview (`src/features/settings/model/integrations-model.ts`)
only looks tools up on `PATH` and runs `<tool> --version`; Lucy never installs anything.

**Background sessions through a private tmux server.** With `terminal.persistence` on `auto` (the
default, when tmux 3.3 or newer is installed) or `tmux`, every terminal and Claude Code session runs
in a tmux server of Lucy's own (`tmux -L <socket name>`, never your default server) started with a
configuration file Lucy writes and passes with `-f`, so `~/.tmux.conf` is neither read nor changed
(`src/adapters/pty/tmux.ts`). These sessions keep running after Lucy quits, by design: the programs
in them (a shell, Claude Code) go on working and using your account's permissions until you end
them. The terminal panel marks such sessions as persistent, "End Background Sessions" stops the
workspace's sessions, and `terminal.persistence = "off"` turns this off so sessions end with Lucy.

**Copying.** Copying text runs the platform clipboard tool with the text on stdin and no shell:
`pbcopy` on macOS, `clip.exe` under WSL, `wl-copy`, `xclip` or `xsel` on Linux
(`src/app/clipboard/clipboard-service.ts`). `wl-copy`, `xclip` and `xsel` leave a small process
running that serves the clipboard, as they do when run from a shell. In an SSH session, or when no
tool works, Lucy writes the text to your terminal as an OSC 52 escape sequence instead.

**Where Lucy writes.** Directories follow the XDG Base Directory layout on macOS and Linux and can
be overridden with `LUCY_CONFIG_DIR`, `LUCY_STATE_DIR`, `LUCY_CACHE_DIR` (`src/core/paths.ts`).

| Location (default) | What | When |
| --- | --- | --- |
| `~/.config/lucy/` | `config.toml`, `config.toml.bak`, `backups/config-<time>.toml` (newest 5 kept), `config.toml.broken-<time>` | Only when you change a setting. Loading never creates the file. |
| `~/.local/state/lucy/workspaces/<id>.json` | Per-folder restore state (section 5) | Debounced while you work, and on exit |
| `~/.local/state/lucy/trash/<workspace-id>/` | Files and folders you deleted in Lucy, for undo | On delete |
| `~/.local/state/lucy/onboarding.json` | "Onboarding done" marker | Once |
| `~/.local/state/lucy/tmux/lucy.conf` | Configuration of Lucy's private tmux server (see above) | When the first persistent session starts |
| `~/.local/state/lucy/logs/lucy.log` | Log file (planned; see section 5) | Not yet: no code calls `configureLogger` |
| `~/.cache/lucy/tree-sitter/` | Empty `languages/` and `queries/` folders that OpenTUI's parser worker always creates | When highlighting starts |
| The opened folder | Files you edit in Lucy's editor, saved by `Ctrl+S` or by auto save (`editor.autosave`, on by default: a short pause after typing, or when the editor loses focus), so an edit reaches the disk without a separate confirmation; create, rename or delete in the explorer; a Git operation (stage, commit, discard, switch, stash, pull, ...); a save in your external editor; anything you or Claude Code do in a terminal | On that action, or shortly after an edit |
| System temp directory | `lucy --demo` builds a throwaway repository there and deletes only directories carrying its own ownership token (`src/app/demo/ownership.ts`) | Demo mode only |

Background Git reads run with `GIT_OPTIONAL_LOCKS=0`, so they never take `index.lock` or rewrite the
index. OpenTUI's own default data folder (`~/.local/share/opentui`) is redirected by
`configureOpenTuiDataPath` (`src/adapters/syntax/opentui-data-path.ts`), which `src/main.ts` calls
with `<cache>/opentui` before the renderer is created. A binary built with `bun build --compile`
would unpack OpenTUI's native library into `$TMPDIR` on every launch (`docs/dev/OPENTUI_NOTES.md`
section 14); no such build is produced today.

## 2. What "untrusted" means here

Opening a folder means trusting it less than running code from it, but more than nothing. Lucy
treats as untrusted: file names, file contents, `.git/config`, `.gitattributes`, hooks, branch and
tag names, remote URLs, symlinks, and Lucy's own state files (which another program could edit).

**There is no workspace-trust gate.** The code contains no trust prompt. Git integration is on by
default (`git.enabled = true`), and the first `git status` runs right after the first frame is drawn
(`DomainServices.startBackground` in `src/app/domain/domain-services.ts`), then again on file
changes (`git.autoRefresh = true`). A trust prompt before enabling Git integration is recommended in
`src/adapters/git/README.md` and is **planned, not implemented**. Until it exists, for a folder you
do not trust: set `git.enabled = false` in `config.toml` (takes effect on restart), or read its
`.git/config` and `.gitattributes` before opening it.

## 3. Threat model: opening an untrusted repository

Status values: **mitigated** (the attack is blocked by code), **partially mitigated** (blocked in
some paths or bounded, with a stated gap), **not mitigated**, **by design** (the behavior is
intended and matches what a terminal does).

| Vector | Status | How |
| --- | --- | --- |
| Command injection through file names, branch names, search strings, commit messages | Mitigated | Every process is started from an argv array with no shell (`src/core/process.ts`; the PTY and external editor spawns follow the same rule; `tests/security/path-resolution.test.ts` covers program lookup). NUL bytes are rejected. Git: `--` before paths, `:(literal)` on every pathspec, path lists on stdin, `--end-of-options` and `check-ref-format --branch` for branch names, commit message on stdin (`--file=-`). Search: the pattern is passed with `-e`, `rg --no-config`. `$EDITOR`/`$VISUAL` are split without a shell and values that need one (`$`, `` ` ``, `|`, `;`, ...) are refused (`src/adapters/editor/split-command.ts`). |
| Git config that runs programs during background commands: `core.fsmonitor`, `core.pager`, `diff.external`, `textconv`, `core.editor`, `gpg.program` via `log.showSignature` | Mitigated | Fixed flags and environment on every command, including the explorer, file-index and `git grep` calls (`src/adapters/git/environment.ts`): `-c core.fsmonitor=false`, `--no-pager`, `GIT_PAGER=cat`, `--no-ext-diff --no-textconv` on every diff, file contents via `cat-file blob`, `GIT_EDITOR=false`, `-c log.showSignature=false`, inherited `GIT_DIR`/`GIT_EXTERNAL_DIFF`/trace variables removed. |
| Git filter drivers (`filter.<name>.clean/smudge/process`) | **Not mitigated** (known residual risk) | Not disabled, because that would make every git-lfs file appear modified. Git can run a clean filter during the background `status` (for files whose stat data changed) and when computing a working-tree diff. A hostile `.git/config` plus `.gitattributes` can therefore run a command as soon as Lucy refreshes, with no action from you. See section 2 for the workaround. |
| Hooks, commit signing programs, `core.sshCommand`, credential helpers, `core.askPass`, remote helpers | By design | Run only on explicit actions, exactly as in a terminal: commit (`pre-commit`, `commit-msg`, `post-commit`, signing), switch (`post-checkout`), pull (`post-merge`), push (`pre-push`), staging (`post-index-change`), ref updates (`reference-transaction`), fetch/pull/push (ssh and credential helpers). Never bypassed: no `--no-verify`; the runner refuses `--force`, `--no-verify`, `--hard`, `--mirror`, `--delete` and forced refspecs (`src/adapters/git/runner.ts`). |
| Git processes prompting on or drawing over the TUI | Mitigated | Every Git command (the adapter's and the secondary ones below) runs in its own session with no controlling terminal (`detached: true`); a timeout or cancel kills the whole process group. `GIT_TERMINAL_PROMPT=0`, a failing `SSH_ASKPASS` unless you configured one, `GPG_TTY` removed. Default timeouts: read 30 s, status 10 s, write 120 s, commit 600 s, network 60 s. |
| Secondary Git calls (explorer ignore check, file index, `git grep`) | Mitigated | These go through `src/adapters/filesystem/git-probe.ts`, which uses the adapter's own hardening for read commands (`readOnlyGitInvocation`: the same base flags, the same environment including `GIT_NO_LAZY_FETCH=1`, and a detached session). A repository configuring `core.fsmonitor`, a pager (`core.pager`, `pager.grep`), `diff.external` and a textconv driver gets none of them run by these calls (`tests/security/git-hardening.test.ts`, which first shows plain Git running them). |
| Repository owned by another user | Mitigated by Git | Git's `safe.directory` check refuses it; Lucy reports `unsafe-repository` and never adds the folder to `safe.directory`. |
| Path traversal in Lucy's own mutations (create, rename, delete, undo) | Mitigated | Paths are validated (`..`, absolute, empty and `.` segments rejected) and resolved through the real parent directory, which must lie inside the real workspace root (`realpathWithin`). A dangling or looping symlink counts as outside. New files are created with `O_EXCL` and never overwrite. A symlink is deleted as a link, never its target. Deletes move to Lucy's trash, which must be outside the workspace (`src/adapters/filesystem/file-ops.ts`). |
| Reads through symlinks that leave the workspace | By design (flagged) | The viewer follows a symlink to a file outside the workspace and reads it, but marks the result `outsideWorkspace` so the UI can show a notice (`read-file.ts`). Explorer: symlinked folders are never expanded automatically; expanding one explicitly is allowed, with a cycle check, and outside targets are marked. Search: ripgrep does not follow symlinks, the built-in engine skips them, the fallback walk never enters symlinked folders. Git file versions are read with `cat-file` and never follow working-tree symlinks. The external editor refuses files outside the workspace unless explicitly allowed. |
| FIFOs, sockets and devices planted in the repository | Mitigated | Only regular files are read; the file is opened with `O_NONBLOCK | O_NOCTTY` and re-checked with `fstat`, so a swapped-in FIFO cannot block. |
| Terminal escape sequences and bidi/control characters in file names and single-line labels | Mitigated | `sanitizeForDisplay` (`src/core/text.ts`) replaces C0 and C1 controls, DEL, the bidi controls (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069), invisible characters that make names look alike (U+00AD, U+180E, U+200B, U+2060–U+2064, U+206A–U+206F, U+FEFF, U+FFF9–U+FFFB) and the line/paragraph separators U+2028/U+2029. It is used for tree rows, tabs, breadcrumbs, Source Control rows, search previews and messages. Names created in Lucy may not contain control characters. By design, U+200C (zero-width non-joiner) and U+200D (zero-width joiner) are kept: emoji sequences and several scripts need them. |
| Control characters inside file contents (code viewer, diff) | Mitigated by OpenTUI (tested) | File text is passed to OpenTUI's renderers without Lucy-side stripping. OpenTUI draws into its own cell buffer: `<text>`, `<code>` and `<markdown>` drop ESC, BEL and C1 bytes, and `<input>` shows them in caret notation (`^[`). `tests/security/terminal-injection.test.ts` runs a real renderer in a PTY with title, color, clear-screen, clipboard (OSC 52), hyperlink, DCS, reset and C1 sequences in content and checks the raw output bytes, so an OpenTUI upgrade that changes this fails the test. The control characters are invisible, though: `sanitizeLineForDisplay` (`src/core/text.ts`) turns them into visible stand-ins one for one (UTF-16 offsets for highlighting stay valid); using it in the views is UI work in progress. |
| Output of programs in the embedded terminal | Mitigated | Output is interpreted by OpenTUI's terminal emulator (libghostty-vt) and redrawn, not passed through to your terminal. The status scanner bounds stored payloads. Programmatic pastes strip control characters, including ESC, so pasted text cannot end bracketed paste early. |
| Huge files, binary files, huge directories | Partially mitigated | Viewer: text up to 5 MiB (`editor.maxFileSizeMb`), binary detection, 64 KiB header for previews. Highlighting off above 1 MiB or 20,000 lines. Git: status capped at 10,000 entries and 16 MiB output, diffs at 4 MiB, file versions at 8 MiB. Explorer renders 1,000 children per folder at a time (the folder is still read in full). File index: 200,000 files, depth 64, 256 MiB of tool output. Captured process output: 32 MiB. Watcher: more than 2,000 paths in a batch becomes one full refresh. Built-in search skips files above 1 MiB. ripgrep and `git grep` skip files above 16 MiB (`--max-filesize`; for `git grep` checked when a file first appears in the output) and keep at most 1 MiB of any output line: streamed output (`runStreaming`) never holds more than that per line, a longer `git grep` line is cut (the match is kept), a cut ripgrep record is left out, and either is reported in the search summary (`limitsHit: "long-line"`). Both limits are options (`ContentSearchOptions.limits`). |
| Malicious input to Tree-sitter parsers | Partially mitigated | Parsing runs in web-tree-sitter (WebAssembly) inside a worker thread, so a parser memory bug is confined to the WebAssembly sandbox and a slow parse does not block the UI thread. Input above 1 MiB or 20,000 lines is not parsed. A failed worker means plain text and a fresh worker. Grammars and queries are fixed local files; the repository cannot supply one. **Not known:** there is no per-parse timeout, the grammars have not been fuzzed by this project, and whether a crafted file can keep the worker busy indefinitely is untested. |
| Regular-expression denial of service | Partially mitigated | Patterns come from you; the risk is a pattern meeting adversarial content. Find in file: regexes run in a worker with a hard 2 s budget, then the worker is terminated. Project search with ripgrep: Rust regex, linear time, no backtracking. `git grep -P` (PCRE2) runs in a separate process that is cancellable and stopped after 5 minutes. The built-in engine (used only when neither ripgrep nor a Git repository is available) runs regexes in the same worker as Find (`src/core/regex-worker/`), one file at a time, terminated when the file's budget (1 s) runs out or the search is cancelled; the result is marked truncated (`limitsHit: "time-budget"`). **Gap:** the `git grep` engine computes highlight ranges for the lines Git matched with the JavaScript regex on the UI thread, so a pattern that Git matches quickly but JavaScript backtracks on (for example `(a+)+b` on a line with a match followed by a long run of `a`) can still freeze the UI in that engine. |
| The embedded terminal | By design | It is a real shell with your privileges and your full environment (tokens, SSH agent). Anything run there can do anything you can. Opening it in an untrusted folder runs your shell's startup files with that folder as the working directory, so per-directory hooks you configured (direnv, mise, a prompt that runs `git status`) behave exactly as in any terminal, without Lucy's Git hardening. |
| Prompt injection through pasted prompts | By design (not filtered) | Templates reference files with `@path` and may include selected code and diagnostics. Repository content can contain instructions aimed at the agent. Lucy only pastes; you review and press Enter. Claude Code's own trust dialog and permission prompts are the control. Gap: if the receiving program has not enabled bracketed paste, newlines are sent as Enter and each line may run; `paste()` returns `multiline` so the UI can warn, and that warning is UI work in progress. |
| Tampered Lucy config or state files | Mitigated | TOML parsing drops unsafe keys (`__proto__`) and limits depth to 32; every setting is validated and falls back per key. Workspace state is validated leniently and every stored path must be workspace-relative, so an edited state file cannot point Lucy outside the folder. A corrupt state file is moved aside, never deleted. |
| Executables planted in the workspace and found through `PATH` | Mitigated | `git`, `rg`, `claude`, editors and `ps` are looked up on your `PATH`, but only in its absolute entries: relative and empty entries (`.`, `bin`, `node_modules/.bin`, a literal `~/bin`, `::`) are skipped by `which()` and by every spawn (`run()`, `runStreaming()`, PTY sessions, the synchronous `ps` used at exit), which resolve bare names themselves instead of letting Bun honor relative entries. The external editor must resolve to an absolute path. A program path you configure explicitly (containing a `/`) is used as given. Tested with a planted `git`/`ps` and `.` first on `PATH` (`tests/security/path-resolution.test.ts`). Programs inside the embedded terminal use your shell's own lookup. |

## 4. AI (Claude Code)

Source: `src/adapters/agents/`, `src/adapters/pty/`, `docs/dev/PTY_NOTES.md`.

- Lucy runs **your own** `claude` executable (the `ai.executable` setting, or `claude` found on
  `PATH`, kept as resolved, so wrappers keep working) in a PTY, with the folder as working directory.
- The environment is yours, unchanged, except for terminal variables (`src/adapters/pty/pty-env.ts`):
  it sets `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=lucy` (and
  `TERM_PROGRAM_VERSION` when given), and removes variables that describe the outer terminal or
  multiplexer (`TERM_PROGRAM*`, `TMUX`, `GHOSTTY_*`, `ITERM_*`, `KITTY_*`, stale `COLUMNS`/`LINES`,
  and the others listed in that file).
- Lucy **never adds** permission flags, never answers Claude Code's workspace trust dialog, and
  **never submits a prompt**. Prompt templates are pasted with bracketed paste and never end with a
  newline; you press Enter.
- Your configured extra arguments (`ai.args`) are passed through unchanged, but Lucy shows a warning
  when they contain `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`,
  `--permission-mode bypassPermissions`, inline `--settings` JSON containing `bypassPermissions`,
  `-p`/`--print` (non-interactive, skips the trust dialog), a positional prompt, or a flag that
  changes which conversation opens (`src/adapters/agents/claude-args.ts`). A `--settings` file path
  cannot be inspected.
- Session discovery reads Claude Code's local transcript files read-only and best effort
  (`src/adapters/agents/claude-sessions.ts`): `$CLAUDE_CONFIG_DIR/projects` or
  `~/.claude/projects`, an undocumented format that may change. Only the first 64 KiB and last
  128 KiB of each file are read, to derive a one-line title. Contents are never logged or stored.
- Activity status ("working", "needs attention") is derived from terminal output and is heuristic;
  a permission dialog can show as idle.

## 5. Secrets and stored data

**Log redaction** (`src/core/log.ts`). Before a line is written, values under keys matching
`token`, `secret`, `password`/`passwd`, `api-key`/`api_key`, `authorization`, `cookie`,
`credential`, `private-key`, `session-id` are replaced with `[redacted]`, and strings matching these
patterns are masked anywhere: `sk-…`, GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`,
`github_pat_`), Slack tokens (`xox…`), AWS access key ids (`AKIA…`) and JWTs. Remote URLs with
embedded credentials are masked for display (`redactRemoteUrl` in `src/adapters/git/parsers.ts`).
Redaction is pattern based: a secret in another format inside a free-text message is not caught.

**Never logged.** Terminal (PTY) input and output: only the process id, the program name, the
size and the exit code are logged, not the arguments. Claude Code transcript contents. Commit
messages travel on stdin, not in logged arguments. The logger is a no-op until `configureLogger` is
called; `src/main.ts` points it at `<state>/logs/lucy.log` at startup. When that file is larger
than 2 MiB at startup it is renamed to `lucy.log.1` (one previous file is kept).

OpenTUI honors its own debugging variables, which Lucy neither sets nor clears:
`OTUI_STDIN_LOG=<file>` records raw keyboard input (including anything typed into a terminal, such
as passwords) and `OTUI_DUMP_CAPTURES` dumps captured console output on exit.

**What Lucy stores.** None of it is encrypted.

| Data | Location | Contains | Permissions |
| --- | --- | --- | --- |
| Settings and backups | config dir | Your settings, which can include paths and command-line arguments (`ai.args`, `terminal.args`, `editor.external`) | `config.toml` `0600` when Lucy creates it (an existing file keeps the mode you gave it); every backup `0600`; directories Lucy creates `0700` |
| Workspace state | `<state>/workspaces/<id>.json` | Folder path, open and recent files, layout, expanded folders, last search query (up to 1,000 characters), **the unsent commit-message draft** (up to 20,000 characters) | `0600` |
| Undo trash | `<state>/trash/<workspace-id>/` | Full copies of every file and folder you deleted in Lucy (which may include `.env` files), plus the original path | Folders `0700`; payloads keep their original mode |
| Log file (planned) | `<state>/logs/lucy.log` | Redacted diagnostics | `0600`, in a `0700` directory |

Trashed items stay until pruned. The app prunes the trash once after the first paint
(`FileOps.pruneTrash` from `src/app/domain/domain-services.ts`: items older than 30 days, and the
oldest items beyond 512 MiB in total).

### Needs analysis: encrypted local storage

- **What would justify it:** stored credentials (API tokens, passwords, SSH keys) or data that is
  more sensitive than the source tree it was taken from.
- **What Lucy stores today:** no credentials. The commit draft, search query and file paths are as
  sensitive as the repository itself, which sits unencrypted in the same home folder. The undo
  trash holds copies of deleted files, with the same sensitivity as the originals.
- **What the OS already provides:** per-user file permissions (Lucy uses `0600` for its files and
  `0700` for the directories it creates; existing directories such as `~/.config` are not changed); full-disk encryption (FileVault on macOS, LUKS on Linux) for a lost or stolen
  machine; credential stores (macOS Keychain, libsecret/Secret Service on Linux) for secrets.
- **Recommendation:** no encryption layer is needed today. An application-level encryption key would
  have to be stored on the same disk, which adds complexity without protecting against anyone who
  can already read your home folder. If Lucy ever needs to keep a token, it should go into the OS
  keychain (Keychain or libsecret), never into a file or a home-grown encryption scheme. One
  smaller improvement is still worth making: wire automatic trash pruning. (Writing `config.toml`,
  its backups and the log file with `0600` is done; `tests/security/file-permissions.test.ts`.)

## 6. Remote and production machines

- Lucy does nothing on remote hosts. It has no SSH, SFTP or remote-execution code.
- SSH happens only inside your own terminal session, typed by you (or started by a program you run
  there), and through Git when you fetch, pull or push.
- Lucy never installs anything or runs commands on servers, automatically or otherwise.

A remote file explorer (SFTP/SSH) is an idea, **not a plan in the code**. If it is ever built, it
must meet at least these requirements:

1. Use your own `ssh` configuration and agent (`~/.ssh/config`, `ssh-agent`, known hosts); never
   implement its own host-key policy or accept unknown host keys silently.
2. Store no credentials: no passwords, passphrases or keys in Lucy's files.
3. Read-only by default.
4. Every write (save, rename, delete, upload) requires an explicit confirmation that names the host.
5. Never enabled by default, never connects on startup, never reconnects to a host you did not open
   in that session.
6. Apply the same untrusted-content rules to remote file names and contents as to local ones.

## 7. Reporting a vulnerability

> **Contact: TO BE DECIDED BY THE MAINTAINER.** No security contact has been chosen yet. Until one
> is published here, do not open a public issue for a vulnerability.

When a contact exists, please include the Lucy version, your OS and terminal, steps to reproduce,
and the impact you observed.
