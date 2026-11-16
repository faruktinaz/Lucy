/**
 * `bun run bench`: measures Lucy on this machine and prints a table.
 *
 * Everything happens in a temporary directory that is removed at the end: the workspaces, the
 * generated inputs, and Lucy's config, state, cache and data directories. The app is started
 * through `bin/lucy` inside Bun's built-in PTY with `LUCY_PROFILE=1`, which makes it print its
 * startup timings on exit (see `src/main.ts`), and is quit with Ctrl+Q. The child's PATH holds
 * only system directories, so no `claude` executable can be found or started.
 *
 * Measurements:
 * - startup to first paint (the `first-paint` mark) and resident memory after first paint
 * - file index for 20,000 files, inside a Git repository and as a plain folder
 * - a Quick Open fuzzy query over 100,000 paths
 * - `git status` through the Git adapter on the demo workspace
 * - parsing a 20,000-line unified diff
 * - Tree-sitter highlighting of a 5,000-line TypeScript file
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const tmpRoot = mkdtempSync(join(tmpdir(), "lucy-bench-"));
const dataHome = join(tmpRoot, "data");
mkdirSync(dataHome);
// The bench process imports OpenTUI too (highlighting); keep its data path in the temp dir.
process.env.XDG_DATA_HOME = dataHome;

interface Row {
  name: string;
  value: string;
  note: string;
}
const rows: Row[] = [];

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const ms = (value: number): string => `${value.toFixed(1)} ms`;

async function timeRuns(runs: number, fn: () => Promise<unknown> | unknown): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  return times;
}

function report(name: string, times: readonly number[], note: string): void {
  rows.push({ name, value: ms(median(times)), note: `median of ${times.length}; ${note}` });
  process.stderr.write(`  ${name}: ${ms(median(times))}\n`);
}

// --- Startup and memory --------------------------------------------------------------------

function residentKb(pid: number): number | null {
  const result = Bun.spawnSync(["/bin/ps", "-o", "rss=", "-p", String(pid)]);
  const value = Number.parseInt(result.stdout.toString().trim(), 10);
  return Number.isFinite(value) ? value : null;
}

async function startOnce(
  workspace: string,
  home: string,
): Promise<{ marks: Map<string, number>; rssKb: number }> {
  // A returning user: the first-run setup card would otherwise hold the keyboard.
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(
    join(home, "state", "onboarding.json"),
    `${JSON.stringify({ version: 1, outcome: "skipped", completedAt: new Date().toISOString() })}\n`,
  );
  let output = "";
  const decoder = new TextDecoder();
  const child = Bun.spawn([process.execPath, join(REPO, "bin/lucy"), workspace], {
    cwd: workspace,
    env: {
      HOME: home,
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      LUCY_PROFILE: "1",
      LUCY_CONFIG_DIR: join(home, "config"),
      LUCY_STATE_DIR: join(home, "state"),
      LUCY_CACHE_DIR: join(home, "cache"),
      XDG_DATA_HOME: join(home, "data"),
      CLAUDE_CONFIG_DIR: join(home, "claude"),
    },
    terminal: {
      cols: 160,
      rows: 48,
      data: (_terminal, bytes) => {
        output += decoder.decode(bytes, { stream: true });
      },
    },
  });
  const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    // Wait for the first output, then give the app time to paint and start Git status.
    while (output.length === 0 && child.exitCode === null) await Bun.sleep(10);
    await Bun.sleep(2000);
    const rssKb = residentKb(child.pid) ?? Number.NaN;
    child.terminal?.write("\x11"); // Ctrl+Q
    await child.exited;
    await Bun.sleep(100);
    const marks = new Map<string, number>();
    // The timings are plain lines written to stderr after the renderer restored the terminal.
    const block = output.slice(output.indexOf("lucy startup timings"));
    for (const match of block.matchAll(/^\s+([\w:-]+)\s+([\d.]+) ms/gm)) {
      marks.set(match[1]!, Number.parseFloat(match[2]!));
    }
    if (!marks.has("first-paint"))
      throw new Error(`no startup timings in the output (exit ${child.exitCode})`);
    return { marks, rssKb };
  } finally {
    clearTimeout(killer);
    if (child.exitCode === null) child.kill("SIGKILL");
    child.terminal?.close();
  }
}

async function benchStartup(): Promise<void> {
  const workspace = join(tmpRoot, "small");
  mkdirSync(join(workspace, "src"), { recursive: true });
  for (let i = 0; i < 10; i++) {
    writeFileSync(join(workspace, "src", `file${i}.ts`), `export const value${i} = ${i};\n`);
  }
  writeFileSync(join(workspace, "README.md"), "# Small\n");
  const firstPaint: number[] = [];
  const rss: number[] = [];
  const runs = 5;
  for (let i = 0; i < runs; i++) {
    const { marks, rssKb } = await startOnce(workspace, join(tmpRoot, `home${i}`));
    firstPaint.push(marks.get("first-paint")!);
    rss.push(rssKb / 1024);
  }
  report("Startup to first paint", firstPaint, "`first-paint` mark, since process start, 10-file folder");
  rows.push({
    name: "Resident memory after first paint",
    value: `${median(rss).toFixed(0)} MB`,
    note: `median of ${runs}; RSS 2 s after first output`,
  });
  process.stderr.write(`  Resident memory: ${median(rss).toFixed(0)} MB\n`);
}

// --- File index ------------------------------------------------------------------------------

function writeTree(root: string, files: number): void {
  const perDir = 100;
  for (let d = 0; d < files / perDir; d++) {
    const dir = join(root, `pkg${d % 20}`, `mod${d}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < perDir; f++) writeFileSync(join(dir, `file${f}.ts`), "");
  }
}

async function benchFileIndex(): Promise<void> {
  const { FileIndex } = await import("@/adapters/search");
  const { isolatedGitEnv } = await import("@/app/demo");
  const env = isolatedGitEnv(tmpRoot);

  const gitRoot = join(tmpRoot, "index-git");
  writeTree(gitRoot, 20_000);
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
  ]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: gitRoot, env: { ...process.env, ...env } });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  }
  let strategy = "";
  let count = 0;
  const withGit = await timeRuns(5, async () => {
    const result = await new FileIndex({ root: gitRoot, env, strategies: ["git"] }).list();
    strategy = result.strategy;
    count = result.files.length;
  });
  report("File index, 20,000 files, Git repository", withGit, `${count} files, strategy "${strategy}"`);

  const plainRoot = join(tmpRoot, "index-plain");
  writeTree(plainRoot, 20_000);
  const withoutGit = await timeRuns(5, async () => {
    const result = await new FileIndex({ root: plainRoot, env, strategies: ["walk"] }).list();
    strategy = result.strategy;
    count = result.files.length;
  });
  report("File index, 20,000 files, no Git", withoutGit, `${count} files, strategy "${strategy}"`);
}

// --- Fuzzy query -----------------------------------------------------------------------------

async function benchFuzzy(): Promise<void> {
  const { fuzzyFilter } = await import("@/adapters/search");
  const paths: string[] = [];
  for (let i = 0; i < 100_000; i++) {
    paths.push(`packages/pkg${i % 50}/src/module${i % 997}/component${i}.tsx`);
  }
  let matches = 0;
  const times = await timeRuns(10, async () => {
    matches = (await fuzzyFilter("modcomp123", paths, { limit: 200 })).length;
  });
  report("Fuzzy query over 100,000 paths", times, `query "modcomp123", best 200 kept (${matches} returned)`);
}

// --- Git status ------------------------------------------------------------------------------

async function benchGitStatus(): Promise<void> {
  const { buildDemoWorkspace, isolatedGitEnv } = await import("@/app/demo");
  const { openGitRepository } = await import("@/adapters/git");
  const demo = await buildDemoWorkspace({ targetDir: join(tmpRoot, "demo") });
  try {
    const git = await openGitRepository(demo.root, { env: isolatedGitEnv(demo.containerDir) });
    let entries = 0;
    await git.status(); // warm-up
    const times = await timeRuns(10, async () => {
      entries = (await git.status()).changes.length;
    });
    report(
      "`git status` via the Git adapter, demo workspace",
      times,
      `${entries} entries, after one warm-up`,
    );
  } finally {
    demo.dispose();
  }
}

// --- Diff parsing ----------------------------------------------------------------------------

async function benchDiff(): Promise<void> {
  const { parseUnifiedDiff } = await import("@/features/source-control/model/patch-parser");
  const lines = [
    "diff --git a/big.ts b/big.ts",
    "index 1111111..2222222 100644",
    "--- a/big.ts",
    "+++ b/big.ts",
  ];
  let oldLine = 1;
  let newLine = 1;
  // Each hunk: 1 header + 3 context + 2 removed + 2 added + 3 context = 11 lines.
  for (let h = 0; lines.length < 20_000; h++) {
    lines.push(`@@ -${oldLine},8 +${newLine},8 @@ function f${h}() {`);
    for (let i = 0; i < 3; i++) lines.push(` const a${h}_${i} = ${i};`);
    lines.push(
      `-  return old${h}(a);`,
      `-  // removed ${h}`,
      `+  return next${h}(a, b);`,
      `+  // added ${h}`,
    );
    for (let i = 0; i < 3; i++) lines.push(` const b${h}_${i} = ${i};`);
    oldLine += 20;
    newLine += 20;
  }
  const patch = `${lines.join("\n")}\n`;
  let hunks = 0;
  const times = await timeRuns(10, () => {
    hunks = parseUnifiedDiff(patch).hunks.length;
  });
  report("Parse a 20,000-line diff", times, `${lines.length} lines, ${hunks} hunks`);
}

// --- Highlighting ----------------------------------------------------------------------------

async function benchHighlight(): Promise<void> {
  const { SyntaxService, configureOpenTuiDataPath } = await import("@/adapters/syntax");
  configureOpenTuiDataPath(join(dataHome, "opentui"));
  const source: string[] = [];
  for (let i = 0; source.length < 5000; i++) {
    source.push(
      `export interface Item${i} { id: number; name: string }`,
      `export function make${i}(id: number): Item${i} {`,
      `  const name = \`item-\${id}\`; // comment ${i}`,
      `  return { id, name };`,
      "}",
    );
  }
  const content = `${source.join("\n")}\n`;
  const service = new SyntaxService({ dataPath: join(tmpRoot, "syntax-cache") });
  try {
    let ranges = 0;
    const cold = await timeRuns(1, async () => {
      ranges = (await service.highlight(content, "typescript")).length;
    });
    if (ranges === 0) throw new Error("highlighting returned no ranges");
    const warm = await timeRuns(5, () => service.highlight(content, "typescript"));
    report("Highlight 5,000-line TypeScript, first call", cold, "includes starting the Tree-sitter worker");
    report("Highlight 5,000-line TypeScript, warm", warm, `${ranges} ranges`);
  } finally {
    await service.disposeAsync();
  }
}

// --- Main ------------------------------------------------------------------------------------

try {
  process.stderr.write(`Lucy bench (temp dir ${tmpRoot})\n`);
  await benchStartup();
  await benchFileIndex();
  await benchFuzzy();
  await benchGitStatus();
  await benchDiff();
  await benchHighlight();

  const git = Bun.spawnSync(["git", "--version"]).stdout.toString().trim();
  const cpu = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string"]).stdout.toString().trim();
  process.stdout.write(
    `\nMachine: ${cpu || process.arch}, ${process.platform}; Bun ${Bun.version}; ${git}\n\n` +
      "| Measurement | Result | Notes |\n|---|---|---|\n" +
      rows.map((r) => `| ${r.name} | ${r.value} | ${r.note} |`).join("\n") +
      "\n",
  );
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
