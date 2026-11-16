/**
 * Finds and kills every process that belongs to a PTY session.
 *
 * Verified behaviour (spikes/pty/02-process-tree.ts, 05-parent-death.ts on macOS):
 * - The PTY child is a session leader and the PTY is its controlling terminal.
 * - An interactive shell puts every job in its own process group, so signalling the shell's group
 *   misses them. After the leader dies, the kernel revokes the tty and background jobs are
 *   reparented to PID 1: they can no longer be found by tty or parent. The tree must therefore be
 *   snapshotted *before* signalling, and remembered across escalation steps.
 * - Interactive zsh ignores SIGTERM but handles SIGHUP by forwarding it to its jobs, which is what a
 *   real terminal does on close. Hence the order SIGHUP, SIGTERM, SIGKILL.
 *
 * Members of a session tree: processes whose controlling tty is the PTY, processes in the leader's
 * session (Linux only; macOS `ps` has no session-id column), and all descendants of those.
 * Lucy's own process and process group are never signalled.
 */
import { resolveCommand, run } from "@/core/process";

export interface ProcessEntry {
  pid: number;
  ppid: number;
  pgid: number;
  /** Session id (Linux only). */
  sid: number | null;
  /** `ps` state letters; a leading `Z` marks a zombie that is dead but not yet reaped. */
  state: string;
  /** Controlling terminal name as `ps` prints it (`ttys006`, `pts/3`), or `null` for none. */
  tty: string | null;
}

export interface ProcessTree {
  /** Member pids, root first when it is still present. */
  pids: number[];
  pgids: number[];
  tty: string | null;
}

export type KillSignal = "SIGHUP" | "SIGINT" | "SIGTERM" | "SIGKILL" | "SIGCONT";

export interface KillTreeOptions {
  rootPid: number;
  /** Controlling tty of the session, if already known (survives the root's death on Linux). */
  tty?: string | null;
  /** Grace period between escalation steps. Default 500 ms (async) or 150 ms (sync). */
  graceMs?: number;
  /** More precise liveness for the root than `kill(pid, 0)` (which also sees zombies). */
  isRootAlive?: () => boolean;
  /** Escalation ladder. Default SIGHUP, SIGTERM, SIGKILL. */
  signals?: readonly KillSignal[];
}

export interface KillTreeReport {
  /** Signals actually sent, in order. */
  sent: KillSignal[];
  /** Pids still alive when the ladder ended (normally empty). */
  survivors: number[];
}

const DEFAULT_LADDER: readonly KillSignal[] = ["SIGHUP", "SIGTERM", "SIGKILL"];
const POLL_MS = 20;
const PS_TIMEOUT_MS = 3000;

function psArgv(): string[] {
  const columns =
    process.platform === "linux" ? "pid=,ppid=,pgid=,sid=,stat=,tty=" : "pid=,ppid=,pgid=,stat=,tty=";
  return ["ps", "-A", "-o", columns];
}

function normalizeTty(raw: string | undefined): string | null {
  if (!raw || raw === "?" || raw === "??" || raw === "-") return null;
  return raw.startsWith("/dev/") ? raw.slice(5) : raw;
}

/** Parses `ps -o pid=,ppid=,pgid=[,sid=],stat=,tty=` output. Malformed lines are skipped. */
export function parsePsTable(text: string, hasSid = process.platform === "linux"): ProcessEntry[] {
  const out: ProcessEntry[] = [];
  const offset = hasSid ? 1 : 0;
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 + offset) continue;
    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    const pgid = Number(fields[2]);
    const sid = hasSid ? Number(fields[3]) : null;
    const state = fields[3 + offset] ?? "";
    const tty = normalizeTty(fields[4 + offset]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid)) continue;
    out.push({ pid, ppid, pgid, sid: sid !== null && Number.isInteger(sid) ? sid : null, state, tty });
  }
  return out;
}

/** Snapshot of all processes, or `null` when `ps` is unavailable. */
export async function listProcesses(): Promise<ProcessEntry[] | null> {
  try {
    const result = await run(psArgv(), { timeoutMs: PS_TIMEOUT_MS });
    return result.code === 0 ? parsePsTable(result.stdout) : null;
  } catch {
    return null;
  }
}

/**
 * Synchronous snapshot for exit and signal handlers, where the event loop no longer runs and
 * the async `run()` helper cannot be awaited. Still an argv array, never a shell string.
 */
export function listProcessesSync(): ProcessEntry[] | null {
  const [name, ...args] = psArgv();
  // Same absolute-PATH-only lookup as `run()`: Bun.spawnSync would honor a relative PATH entry.
  const program = resolveCommand(name as string);
  if (program === null) return null;
  try {
    const result = Bun.spawnSync([program, ...args], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: PS_TIMEOUT_MS,
    });
    return result.exitCode === 0 ? parsePsTable(result.stdout.toString()) : null;
  } catch {
    return null;
  }
}

/** Selects the members of the PTY session rooted at `rootPid` from a process table. */
export function selectSessionTree(
  table: readonly ProcessEntry[],
  rootPid: number,
  knownTty: string | null = null,
  selfPid: number = process.pid,
): ProcessTree {
  const root = table.find((entry) => entry.pid === rootPid);
  const tty = root?.tty ?? knownTty;
  const members = new Set<number>();
  if (root) members.add(root.pid);
  for (const entry of table) {
    if ((tty !== null && entry.tty === tty) || entry.sid === rootPid) members.add(entry.pid);
  }
  const children = new Map<number, number[]>();
  for (const entry of table) {
    const list = children.get(entry.ppid);
    if (list) list.push(entry.pid);
    else children.set(entry.ppid, [entry.pid]);
  }
  const queue = [rootPid, ...members];
  while (queue.length > 0) {
    const pid = queue.pop() as number;
    for (const child of children.get(pid) ?? []) {
      if (!members.has(child)) {
        members.add(child);
        queue.push(child);
      }
    }
  }
  const self = table.find((entry) => entry.pid === selfPid);
  members.delete(selfPid);
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const pgids = new Set<number>();
  for (const pid of members) {
    const pgid = byPid.get(pid)?.pgid;
    if (pgid !== undefined && pgid > 1 && pgid !== self?.pgid) pgids.add(pgid);
  }
  const pids = [...members]
    .filter((pid) => pid > 1)
    .sort((a, b) => (a === rootPid ? -1 : b === rootPid ? 1 : a - b));
  return { pids, pgids: [...pgids], tty };
}

/** True when a process with this pid exists and is signalable by us (zombies count as alive). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: gone. EPERM: the pid was reused by someone else's process; not ours to wait for.
    return false;
  }
}

function sendSignal(target: number, signal: KillSignal): void {
  try {
    process.kill(target, signal);
  } catch {
    // Already gone (ESRCH) or not ours (EPERM): nothing to do.
  }
}

interface Tracking {
  pids: Set<number>;
  pgids: Set<number>;
  tty: string | null;
}

function absorb(tracking: Tracking, tree: ProcessTree, selfPgid: number | undefined): void {
  for (const pid of tree.pids) tracking.pids.add(pid);
  for (const pgid of tree.pgids) if (pgid !== selfPgid) tracking.pgids.add(pgid);
  tracking.tty = tree.tty ?? tracking.tty;
}

function signalTracked(tracking: Tracking, signal: KillSignal): void {
  // Groups first so that every job of an interactive shell is reached, then stragglers by pid
  // (processes that left their group, or whose group we deliberately do not signal).
  for (const pgid of tracking.pgids) sendSignal(-pgid, signal);
  for (const pid of tracking.pids) sendSignal(pid, signal);
}

function aliveOf(tracking: Tracking, rootPid: number, isRootAlive?: () => boolean): number[] {
  return [...tracking.pids].filter((pid) =>
    pid === rootPid && isRootAlive ? isRootAlive() : isProcessAlive(pid),
  );
}

function initialTracking(options: { rootPid: number; tty?: string | null }): Tracking {
  return { pids: new Set([options.rootPid]), pgids: new Set([options.rootPid]), tty: options.tty ?? null };
}

function selfPgidOf(table: readonly ProcessEntry[] | null): number | undefined {
  return table?.find((entry) => entry.pid === process.pid)?.pgid;
}

/**
 * Kills the whole PTY session tree with escalation. Each step re-snapshots the tree (shells may
 * fork during shutdown) and keeps every member seen earlier, because orphaned jobs disappear from
 * the tty and parent links once the leader dies. Resolves when everything is gone or the ladder
 * is exhausted.
 */
export async function killProcessTree(options: KillTreeOptions): Promise<KillTreeReport> {
  const graceMs = options.graceMs ?? 500;
  const ladder = options.signals ?? DEFAULT_LADDER;
  const tracking = initialTracking(options);
  const sent: KillSignal[] = [];
  for (const [index, signal] of ladder.entries()) {
    const table = await listProcesses();
    if (table) absorb(tracking, selectSessionTree(table, options.rootPid, tracking.tty), selfPgidOf(table));
    if (aliveOf(tracking, options.rootPid, options.isRootAlive).length === 0) break;
    signalTracked(tracking, signal);
    // A stopped job (Ctrl+Z) cannot act on SIGHUP/SIGTERM until it is continued.
    if (signal !== "SIGKILL" && signal !== "SIGCONT") signalTracked(tracking, "SIGCONT");
    sent.push(signal);
    if (index === ladder.length - 1) break;
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && aliveOf(tracking, options.rootPid, options.isRootAlive).length > 0) {
      await Bun.sleep(POLL_MS);
    }
  }
  if (sent.at(-1) === "SIGKILL") await Bun.sleep(POLL_MS);
  return { sent, survivors: aliveOf(tracking, options.rootPid, options.isRootAlive) };
}

export interface KillTreeTarget {
  rootPid: number;
  tty?: string | null;
}

/** Pids from `tracking` that are present in `table` and not zombies. */
function aliveInTable(tracking: Tracking, table: readonly ProcessEntry[] | null): number[] {
  if (!table) return [...tracking.pids].filter(isProcessAlive);
  const live = new Set(table.filter((entry) => !entry.state.startsWith("Z")).map((entry) => entry.pid));
  return [...tracking.pids].filter((pid) => live.has(pid));
}

/**
 * Blocking variant for `process.on("exit")` and signal handlers, for several trees at once so
 * that shutdown pays the grace periods only once. The event loop does not run here, so Bun cannot
 * reap the roots: liveness comes from `ps` (zombies excluded) instead of `kill(pid, 0)`.
 * Bounded by roughly `graceMs * (ladder length - 1)` plus one `ps` call per poll.
 */
export function killProcessTreesSync(
  targets: readonly KillTreeTarget[],
  options: { graceMs?: number; signals?: readonly KillSignal[] } = {},
): KillTreeReport {
  const graceMs = options.graceMs ?? 150;
  const ladder = options.signals ?? DEFAULT_LADDER;
  const trackings = targets.map((target) => initialTracking(target));
  const sent: KillSignal[] = [];
  let table = listProcessesSync();
  for (const [index, signal] of ladder.entries()) {
    if (index > 0) table = listProcessesSync();
    const selfPgid = selfPgidOf(table);
    trackings.forEach((tracking, i) => {
      const target = targets[i];
      if (table && target) absorb(tracking, selectSessionTree(table, target.rootPid, tracking.tty), selfPgid);
    });
    const alive = trackings.filter((tracking) => aliveInTable(tracking, table).length > 0);
    if (alive.length === 0) break;
    for (const tracking of alive) {
      signalTracked(tracking, signal);
      if (signal !== "SIGKILL" && signal !== "SIGCONT") signalTracked(tracking, "SIGCONT");
    }
    sent.push(signal);
    if (index === ladder.length - 1) break;
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      Bun.sleepSync(POLL_MS * 2);
      table = listProcessesSync();
      if (trackings.every((tracking) => aliveInTable(tracking, table).length === 0)) break;
    }
  }
  const finalTable = listProcessesSync();
  return { sent, survivors: trackings.flatMap((tracking) => aliveInTable(tracking, finalTable)) };
}
