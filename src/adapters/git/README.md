# Git adapter and service

UI-agnostic Git layer for the Source Control panel, the status bar and explorer decorations.
Import everything from `@/adapters/git`.

| Module                        | Role                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `types.ts`                    | Domain model (`GitChange`, `GitStatus`, ...) and the `GitAdapter` interface           |
| `cli-adapter.ts`              | `GitCliAdapter` / `openGitRepository()`: the real implementation over `git`           |
| `service.ts`                  | `GitService`: `Store<GitState>`, coalesced `refresh()`, auto-refreshing mutators      |
| `mock-adapter.ts`             | `MockGitAdapter`: in-memory, scriptable, records calls, injectable failures           |
| `decorations.ts`              | Path → status index for the explorer (files and "contains changes" folders)           |
| `discovery.ts`                | Finds the repository; distinguishes missing Git, no repo, bare, unsafe, too old       |
| `porcelain.ts`, `parsers.ts`  | Pure parsers (porcelain v2 `-z`, log, refs, stash, remotes, numstat)                  |
| `runner.ts`, `environment.ts` | Internal: fixed flags and environment; every adapter command runs through `GitRunner` |
| `paths.ts`                    | Path validation, `:(literal)` pathspecs, workspace ↔ repository path mapping          |

Git is executed in two places, both with the same hardening: `GitRunner` (`runner.ts`) for every
adapter command, and `readOnlyGitInvocation()` (`environment.ts`, exported from `@/adapters/git`)
for the read-only commands other adapters run themselves: the explorer's ignore detection
(`check-ignore`), the file index (`ls-files`) and the `git grep` search engine, all through
`src/adapters/filesystem/git-probe.ts`. Both use `GIT_BASE_ARGS`, `buildGitEnvironment(…, "read")`
for reads and a detached session. Do not start Git any other way.

## Conventions

- **Paths.** Every adapter method takes and returns repo-root-relative POSIX paths exactly as Git
  reports them. The workspace may be a subdirectory of the repository (`repository.workspacePrefix`);
  convert with `toRepoPath`, `toWorkspacePath`, `toAbsolutePath`, `fromAbsolutePath`. Status is
  always repository-wide, like VS Code. On macOS, input paths are NFC-normalized when
  `core.precomposeunicode` is on (Git precomposes argv but not stdin pathspecs, so an NFD name from
  `readdir` would otherwise silently match nothing); decoration lookups normalize too.
- **Errors.** Failures are `LucyError`s with `details.kind` (`GitFailureKind`): read it with
  `gitFailureKind(error)`. Git command failures use code `GIT_FAILED` with
  `details: { kind, stderr, stdout, exitCode, args, retryable }` (stderr/stdout trimmed, 8 KiB cap).
  Validation failures use `INVALID_ARGUMENT` (`invalid-ref-name`, `empty-message`, `discard-blocked`,
  ...), plus `NOT_A_REPOSITORY`, `UNSUPPORTED` (bare), `TIMEOUT`, `CANCELLED`. Notable kinds:
  `index-locked` (retryable; idempotent mutations already retry briefly), `nothing-to-commit`,
  `would-overwrite`, `conflicts`, `no-upstream`, `not-fast-forward`, `rejected`, `auth-required`
  (best effort, from stderr), `signing-failed`.
- **Concurrency.** Index/worktree mutations (stage, unstage, discard, commit, switch, branch,
  stash, pull) run one at a time through a queue. fetch/push use a separate queue so a slow network
  call never blocks staging. `status()` is coalesced: one run in flight plus at most one trailing
  run; every caller gets a result that reflects the state at or after its call.
- **Status.** Porcelain v2, `-z`, `--untracked-files=all` (individual files, VS Code style). A
  `statusEntries` cap (default 10 000) and an output cap set `truncated`; if the full untracked scan
  times out (default 10 s) it is retried once with collapsed untracked directories and
  `truncatedReason: "untracked-timeout"`. Reads never take `index.lock` (`GIT_OPTIONAL_LOCKS=0`).

## Diff representation

| Situation       | `mode`      | Patch                                                                              |
| --------------- | ----------- | ---------------------------------------------------------------------------------- |
| Unstaged change | `unstaged`  | working tree vs index                                                              |
| `staged: true`  | `staged`    | index vs HEAD (empty tree on an unborn branch); pass `origPath` for renames        |
| Untracked file  | `untracked` | synthesized all-added patch (`diff --no-index /dev/null file`), size-guarded       |
| Conflicted file | `conflict`  | working tree (with markers) vs "ours" (stage 2); all-added when there is no "ours" |

Binary and oversized patches return `patch: ""` with `isBinary` / `isTooLarge`. For a split view use
`fileAtRevision(path, "HEAD" | "INDEX" | "WORKTREE" | "BASE" | "OURS" | "THEIRS" | rev)`, which
returns content or `null` plus `isBinary` / `isTooLarge`, reads blobs with plumbing (`cat-file
blob`) and never follows worktree symlinks or leaves the repository.

## Destructive operations

- `discard(paths)` replaces unstaged changes with the index version and deletes the named untracked
  files (`git clean -f` of exactly those literal paths: never `-d`, never `-x`). Always show
  `previewDiscard(paths)` first: per file it says `restore` / `delete` / `none` / `blocked`, with lines
  lost and bytes. Conflicted files, submodules and directories are `blocked`, and `discard` refuses
  the whole call if any path is blocked. The plan is recomputed inside the write queue, so a stale
  confirmation cannot delete something that became tracked meanwhile.
- `stashDrop(index)` deletes a stash entry.
- `stageAll()` refuses while conflicts exist (staging marks them resolved) unless
  `includeConflicts: true`. `unstageAll()` resets only staged paths, so it never aborts a merge.
- No force variant exists anywhere: no `push --force`, `reset --hard`, `--no-verify`,
  `--discard-changes`. The runner rejects these flags even if a future code path tried to pass them.

## Threat model

A repository's `.git/config` is not trustworthy: a directory copied from an archive, a shared
drive or a colleague can carry config that names programs to run. Lucy runs Git in the background
(status on every file change, diffs on selection), so any command-executing config would run
without a user action. File names and branch names are untrusted input too.

**Neutralized on every command**

| Vector                                                                                    | Mitigation                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `core.fsmonitor` hook                                                                     | `-c core.fsmonitor=false`                                                                                                                                                                                                      |
| `core.pager`, `GIT_PAGER`, `PAGER`                                                        | `--no-pager`, `GIT_PAGER=cat`, `PAGER=cat`                                                                                                                                                                                     |
| `diff.external`, `GIT_EXTERNAL_DIFF`                                                      | `--no-ext-diff` on every diff, variable removed                                                                                                                                                                                |
| `diff.<driver>.textconv`                                                                  | `--no-textconv`; file contents via `cat-file blob` (plumbing)                                                                                                                                                                  |
| `core.editor`, `GIT_EDITOR`, sequence editor                                              | `GIT_EDITOR=false`, `GIT_SEQUENCE_EDITOR=false`, `GIT_MERGE_AUTOEDIT=no`: an unexpected editor fails closed                                                                                                                    |
| `log.showSignature` → `gpg.program` on `git log`                                          | `-c log.showSignature=false`                                                                                                                                                                                                   |
| `ext::` remote transport                                                                  | `-c protocol.ext.allow=never` on network commands                                                                                                                                                                              |
| Lazy fetch of missing objects in a partial clone (network traffic nobody asked for)       | `GIT_NO_LAZY_FETCH=1` on read-only commands, which run in the background (Git 2.44+; older Git ignores it): such a read fails instead of downloading. Explicit user actions (writes, fetch/pull/push) may fetch what they need |
| Terminal prompts (credentials, SSH passphrases, host keys)                                | `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `SSH_ASKPASS_REQUIRE=force` with a failing askpass unless the user configured one, `GPG_TTY` removed, timeouts                                                               |
| Inherited `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, pathspec-mode and trace variables | removed from the environment                                                                                                                                                                                                   |
| File names as options or pathspec magic (`-rf`, `*`, `:(glob)x`)                          | `--` before paths, `:(literal)` on every pathspec, path lists on stdin; `--no-index` paths are plain files                                                                                                                     |
| Branch names / revisions as options (`--orphan`, `@{-1}`, `a..b`)                         | local checks + `git check-ref-format --branch` (output must equal input), `--end-of-options`, explicit `refs/heads/x:refs/heads/x` refspecs                                                                                    |
| Commit message as arguments                                                               | message on stdin (`--file=-`), never argv                                                                                                                                                                                      |

Message parsing: only `LC_MESSAGES=C` is forced (a user `LC_ALL` is moved to the other categories).
Paths are bytes to Git, so UTF-8 names stay intact, and hooks keep the user's UTF-8 locale.
`--literal-pathspecs` is deliberately not used: it is exported as `GIT_LITERAL_PATHSPECS=1`, which
breaks Git's internal pathspecs (`stash -u` would leave untracked files behind) and leaks into hooks.

**Partial clones.** Because read-only commands run with `GIT_NO_LAZY_FETCH=1`, a background read
that needs an object the clone does not have fails with Git's error (`could not fetch … from
promisor remote`) instead of fetching: a diff against a missing blob, or `fileAtRevision` of an old
revision (reported as "no content"). Explicit user actions are not restricted: switching to a branch
whose files were never downloaded fetches them, exactly as it would in a terminal.

**Remaining by design** (they run only on explicit user actions, exactly as in a terminal):

- Hooks (`core.hooksPath`): `pre-commit`, `commit-msg`, `post-commit` on commit; `post-checkout` on
  switch; `post-merge` on pull; `pre-push` on push; `reference-transaction` on ref updates;
  `post-index-change` on staging. Never bypassed: there is no `--no-verify`.
- Commit signing (`commit.gpgSign`, `gpg.program`, `gpg.ssh.program`) on commit; failures surface
  their stderr as `signing-failed`.
- `core.sshCommand` / `GIT_SSH_COMMAND`, credential helpers, `core.askPass`, remote helpers and
  `core.alternateRefsCommand` on fetch/pull/push.

**Known residual risk.** Filter drivers (`filter.<name>.clean/smudge/process`, e.g. git-lfs) are
not disabled: turning them off would make every LFS file appear modified. Git can run a clean
filter during a background `status` for files whose stat data changed, so a hostile `.git/config`
plus `.gitattributes` can still execute a command when Lucy refreshes. Git's own `safe.directory`
ownership check (surfaced as `unsafe-repository`) covers repositories owned by other users; for
same-user repositories from untrusted sources, a workspace-trust prompt before enabling Git
integration is the recommended follow-up.

Every Git process is started detached (`run(..., { detached: true })`, a new session via
`setsid`), the runner's and `readOnlyGitInvocation()`'s alike, so Git and anything it starts
(hooks, ssh, credential helpers, filter drivers) has no controlling terminal and cannot prompt on or
draw over the TUI. A timeout or cancellation kills
the whole process group, not only Git itself. The askpass, prompt and `GPG_TTY` settings above
remain as a second layer so the known prompters fail fast with a clear error.
