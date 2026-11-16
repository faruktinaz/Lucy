# Roadmap

The project was planned in four phases. Each item below is marked from what the code contains
today (version 0.1.0), not from the plan: **done**, **partial** (some of it is built; what is
missing is stated) or **not started**.

## Phase 1: core workspace

| Item | Status | Notes |
|---|---|---|
| Scaffold and CLI | Done | `bin/lucy`, `src/main.ts`, `src/app/cli.ts`: `[path]`, `--demo`, `--conflict`, `--no-restore`, `--debug`, `--help`, `--version`. |
| Shell layout | Done | Sidebar, editor area, Claude Code panel, bottom panel, status bar, command palette (`src/app/workbench`, `src/ui/shell`). |
| Explorer | Done | Lazy tree, Git decorations, filter, create / rename / delete with undo through Lucy's trash. |
| Viewer | Done | Read-only code viewer with Tree-sitter highlighting, find, go to line, wrap, Markdown preview. |
| Source Control: stage, unstage, commit, diffs | Done | Per-file stage / unstage / discard, commit and amend, unified and split diffs with word-level highlights. |
| Fuzzy file search and content search | Done | Quick Open over a file index (`git ls-files`, ripgrep or a walk); content search with ripgrep, `git grep` or a built-in engine. |
| Claude Code adapter and in-app panel | Done | Runs the user's `claude` in a PTY (`src/adapters/agents`, `src/features/ai`). Tested only with a fake program, not with the real CLI. |
| Settings and themes | Done | Settings editor over `config.toml`, four built-in themes, accents, icon tiers, color modes. |
| Demo mode and tests | Done | `lucy --demo` (throwaway repository, isolated settings); unit, UI and security tests under `tests/`. |

## Phase 2: hardening and daily use

| Item | Status | Notes |
|---|---|---|
| PTY and Claude Code integration hardening | Partial | Process-tree cleanup on exit, sanitized environment, argument warnings for permission-bypass flags. Activity status is still a heuristic over terminal output; status through Claude Code hooks is planned (`docs/dev/PTY_NOTES.md` section 9). |
| External editor adapter (Micro and others) | Done | Micro, Helix, Neovim, Vim, nano, vi, or `$VISUAL` / `$EDITOR`, opened at the cursor line where the editor supports it (`src/adapters/editor`). |
| Session resume | Done | New, continue, resume, restart, rename and close; past sessions read from Claude Code's transcript files. |
| File watcher | Done | `src/adapters/filesystem/watcher.ts`, debounced batches, `workspace.watch` setting. |
| Multi-tab | Done | Preview and pinned tabs, next / previous / close, restored per folder. |
| Responsive layouts | Done | Wide, medium and narrow layout modes by terminal width (`src/app/workbench/layout-compute.ts`), zen mode, maximized panel. |
| Keyboard remap UI | Done | Keyboard Shortcuts editor with chord capture; overrides in `config.toml`. |
| Git history / branch / stash | Done | Commit history (last 200 commits in a picker), switch and create branch, stash and stash pop, fetch / pull / push. |
| Command feedback | Done | Notifications with history, status bar items, hints. |

## Phase 3: IDE features and distribution

| Item | Status | Notes |
|---|---|---|
| LSP | Not started | No language-server code. |
| Native editable buffer | Not started | Editing goes to the external editor. |
| Hunk staging | Not started | The diff parser models hunks, but staging and discarding are per file. |
| Inline diagnostics | Not started | No diagnostics source; the "Fix diagnostics" prompt template is shown disabled. |
| AI review workflows | Partial | Prompt templates (explain, review diff, write tests) are pasted into Claude Code for you to send. No review workflow beyond that. |
| Task runner | Not started | |
| Theme and plugin SDK | Not started | Themes are built in (`src/themes`); there is no way to load a user theme or a plugin. |
| Linux compatibility | Partial | Linux code paths exist (process tree, watcher, XDG paths); never run on Linux. |
| Release packaging | Not started | Runs from a checkout with `bun link`; no binaries, packages or release process. |

## Phase 4

| Item | Status | Notes |
|---|---|---|
| Optional desktop companion | Not started | |

## Known gaps worth doing next

- **Workspace-trust prompt.** Git integration starts right after the first frame in any folder,
  and Git filter drivers configured by an untrusted repository can run during that background
  `git status` ([SECURITY.md](SECURITY.md) sections 2 and 3). A trust prompt is planned, not built.
- **Precise Claude Code status.** "Working" and "needs attention" are guessed from terminal output;
  a permission dialog can show as idle. Claude Code hooks would make it exact.
- **Per-hunk and per-line staging** in the diff view.
- **View state not persisted across restarts.** Restored per folder: layout, open tabs with scroll
  position and cursor, expanded folders, search query and options, commit draft. Not restored, for
  example: a diff tab's unified / split choice and the maximized panel.
- **Settings that need a restart.** `ai.executable` and `ai.args` are read once
  ([ARCHITECTURE.md](ARCHITECTURE.md) section 8), as are `git.enabled`, `workspace.watch` and
  `ui.colorMode`.
- **Never tested for real.** The Claude Code panel is tested with a fake program in a PTY, never
  with the real `claude` CLI; key handling is tested with simulated input, not in a real terminal
  emulator. Mouse mode 1003 CPU cost on slow links is not measured.
- **Paste warning.** A multi-line paste into a program without bracketed paste can run each line;
  the adapter reports it, the UI warning is not built.
- **Regex on the UI thread.** The `git grep` engine computes highlight ranges with a JavaScript
  regex on the UI thread; a backtracking pattern can freeze it.
- **Linux** is untested.

## Remote and SSH

Today Lucy has no SSH, SFTP or remote-execution code. SSH happens only inside your own terminal
session in Lucy, and through Git when you fetch, pull or push.

A remote file explorer over SFTP/SSH is an idea, not a plan in the code. If it is built, it must
(from [SECURITY.md](SECURITY.md) section 6): use your own `ssh` configuration, agent and known
hosts, never its own host-key policy; store no credentials; be read-only by default; ask for an
explicit confirmation naming the host before every write; never be enabled by default, connect on
startup or reconnect to a host you did not open in that session; and treat remote names and
contents as untrusted, like local ones.

## Integrations deliberately not built

These were considered and left out on purpose. Lucy detects some of these tools on `PATH` and
lists them in its tool overview, but does not drive them.

- **lazygit** as an advanced Git mode. Lucy's own Source Control covers the common path; lazygit
  can be run in the embedded terminal.
- **tmux** for process persistence. Terminals and Claude Code sessions end when Lucy exits.
- **cmux**, only through its official interfaces, if ever. Today Lucy just runs whatever `claude`
  resolves to on `PATH`, which can be cmux's wrapper.
- **Atuin, zoxide, fzf** adapters. They work as usual inside the embedded shell (`Ctrl+R` reaches
  the shell), with no Lucy-specific integration.
