# Performance

Numbers measured with `bun run bench` (`scripts/bench.ts`) on 2026-11-17. They describe one
machine and one run; treat them as orders of magnitude, not guarantees.

## Machine and versions

- Apple M4 (10 cores), 16 GB RAM, macOS 27.3
- Bun 1.3.14, OpenTUI 0.9.1, Git 2.50.1 (Apple Git-155)
- ripgrep not on the `PATH` seen by Bun, so the file index without Git used the built-in walk

## Results

| Measurement | Result | How |
|---|---|---|
| Startup to first paint | 222 ms | `bin/lucy` on a 10-file folder in Bun's PTY (160x48); the `first-paint` mark printed by `LUCY_PROFILE=1`, measured from process start; median of 5 launches |
| Resident memory after first paint | 192 MB | RSS of the app process (`ps`) 2 s after its first output; median of 5 |
| File index, 20,000 files, Git repository | 58 ms | `FileIndex` with the `git` strategy (`git ls-files`), files added to the index; median of 5 |
| File index, 20,000 files, no Git | 10 ms | `FileIndex` with the `walk` strategy, 200 folders of 100 files; median of 5 |
| Fuzzy query over 100,000 paths | 14 ms | `fuzzyFilter("modcomp123", …, { limit: 200 })`, the Quick Open matcher; median of 10 |
| `git status` through the Git adapter | 13 ms | `GitCliAdapter.status()` on the demo workspace (11 entries), after one warm-up call; median of 10 |
| Parse a 20,000-line diff | 1.5 ms | `parseUnifiedDiff` on one file with 1,818 hunks; median of 10 |
| Highlight a 5,000-line TypeScript file, first call | 186 ms | `SyntaxService.highlight`, including starting the Tree-sitter worker; one run |
| Highlight a 5,000-line TypeScript file, warm | 53 ms | Same file again, worker running (50,000 ranges); median of 5 |

## What the numbers mean

Lucy paints its first frame in about a fifth of a second, and Git status, the file watcher and
highlighting start only after that frame, so they do not delay startup. The operations that run
while you type (a Quick Open query over 100,000 paths, parsing a large diff) fit within one 60 Hz
frame of about 16 ms. The slower work (indexing, Git, highlighting) is asynchronous: Git runs in
child processes and Tree-sitter in a worker, so a 50 ms highlight delays colors, not input. About
190 MB of resident memory for a small folder is the baseline cost of the runtime and UI; this
bench does not measure how it grows with project size.

## Reproduce

```sh
bun install
bun run bench
```

The script prints progress on stderr and the table on stdout. It works only in a temporary
directory, which it removes at the end: the generated workspaces and inputs, and the app's
`LUCY_CONFIG_DIR`, `LUCY_STATE_DIR`, `LUCY_CACHE_DIR` and `XDG_DATA_HOME`. The app is started with
`HOME` pointing into that directory and a `PATH` of system directories only, with the first-run
setup marked as done, and is quit with Ctrl+Q. It needs Git, makes no network connections and does
not start the Claude Code CLI. A run takes about 20 seconds. Across three runs on this machine, startup to first
paint ranged from 218 to 236 ms and the other results moved by up to 15 percent.
