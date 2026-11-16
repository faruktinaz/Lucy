/**
 * Edits a file in the user's terminal editor: Lucy suspends its screen, the editor runs in the
 * foreground on the real terminal, and Lucy resumes when it exits.
 *
 * This spawns without the kernel's `run()`: `run()` pipes stdout and stderr (and ignores
 * stdin) to capture output, but an interactive editor needs the terminal itself, so the child
 * inherits all three descriptors. It still follows the kernel's rules: an argv array straight to
 * the OS, never a shell, and an absolute program path resolved beforehand (`findProgram` uses
 * `which()`, which searches absolute PATH entries only), so a relative PATH entry such as "."
 * can never make an editor binary planted in the workspace run.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { errorMessage, LucyError } from "@/core/errors";
import { realpathWithin } from "@/core/paths";
import { buildOpenCommand } from "./build-open-command";
import type { EditorEnv, ResolvedEditor, TerminalController } from "./types";

export interface OpenInExternalEditorOptions {
  readonly editor: ResolvedEditor;
  /** Absolute, or relative to `workspaceRoot`. */
  readonly file: string;
  /** 1-based. */
  readonly line?: number;
  /** 1-based, in characters. */
  readonly column?: number;
  /** Working directory of the editor (the workspace root, normally). */
  readonly cwd: string;
  /** Root the file must lie in (after resolving symlinks). Defaults to `cwd`. */
  readonly workspaceRoot?: string;
  /** Opens files outside the workspace too. Only after the user explicitly asked for it. */
  readonly allowOutsideWorkspace?: boolean;
  readonly terminal: TerminalController;
  /** Merged over `process.env` for the editor. A value of `undefined` removes the variable. */
  readonly env?: EditorEnv;
}

export interface ExternalEditorResult {
  /** Exit code, or `null` when the editor was killed by a signal. */
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** The file differs from before (content, size, mtime or inode), or was created or deleted. */
  readonly changed: boolean;
  /** The file no longer exists. */
  readonly deleted: boolean;
  /** Absolute real path that was opened. */
  readonly file: string;
  readonly argv: readonly string[];
}

/** Content hashing tells a real edit from a mere touch; above this size stat facts must do. */
const HASH_LIMIT_BYTES = 16 * 1024 * 1024;

interface Fingerprint {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
  readonly hash: string | null;
}

async function fingerprint(path: string): Promise<Fingerprint | null> {
  try {
    const info = await stat(path);
    let hash: string | null = null;
    if (info.isFile() && info.size <= HASH_LIMIT_BYTES) {
      hash = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    }
    return { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, hash };
  } catch {
    return null;
  }
}

function differs(before: Fingerprint | null, after: Fingerprint | null): boolean {
  if (before === null || after === null) return before !== after;
  if (before.hash !== null && after.hash !== null)
    return before.hash !== after.hash || before.size !== after.size;
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino;
}

function mergeEnv(extra: EditorEnv | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

async function resolveTarget(options: OpenInExternalEditorOptions): Promise<string> {
  const root = options.workspaceRoot ?? options.cwd;
  const absolute = resolve(root, options.file);
  const inside = await realpathWithin(root, absolute);
  if (inside !== null) return inside;
  if (!options.allowOutsideWorkspace) {
    throw new LucyError("OUTSIDE_WORKSPACE", "The file is outside the workspace", {
      details: { path: options.file },
    });
  }
  return realpath(absolute).catch(() => absolute);
}

const ignoreSignal = (): void => {};

/**
 * Suspends the terminal, runs the editor in the foreground and always resumes. A non-zero
 * exit is a normal result (Vim's `:cq`); errors are thrown before suspending when possible
 * (outside the workspace, editor missing), so the screen does not flash for nothing.
 */
export async function openInExternalEditor(
  options: OpenInExternalEditorOptions,
): Promise<ExternalEditorResult> {
  const file = await resolveTarget(options);
  if (!isAbsolute(options.editor.program)) {
    // Bun.spawn would look a bare or relative name up itself, honoring relative PATH entries.
    throw new LucyError("SPAWN_FAILED", `${options.editor.displayName} must be started by absolute path`, {
      details: { command: options.editor.program },
    });
  }
  try {
    await access(options.editor.program, constants.X_OK);
  } catch (cause) {
    throw new LucyError(
      "SPAWN_FAILED",
      `${options.editor.displayName} was not found at ${options.editor.program}`,
      {
        cause,
        details: { command: options.editor.program },
      },
    );
  }
  const argv = buildOpenCommand(options.editor, { file, line: options.line, column: options.column });
  const before = await fingerprint(file);
  const env = mergeEnv(options.env);

  // Ctrl+C in an editor that does not use raw mode is delivered to the whole foreground
  // process group, Lucy included. A listener stops Bun's default "exit on SIGINT" meanwhile.
  process.on("SIGINT", ignoreSignal);
  let exitCode: number | null = null;
  let signal: string | null = null;
  let failure: unknown = null;
  try {
    await options.terminal.suspend();
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn(argv, {
        cwd: options.cwd,
        env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
    } catch (cause) {
      throw new LucyError(
        "SPAWN_FAILED",
        `Could not start ${options.editor.displayName}: ${errorMessage(cause)}`,
        {
          cause,
          details: { command: options.editor.program },
        },
      );
    }
    const code = await child.exited;
    signal = child.signalCode ? String(child.signalCode) : null;
    exitCode = signal ? null : code;
  } catch (error) {
    failure = error;
  } finally {
    process.off("SIGINT", ignoreSignal);
    try {
      await options.terminal.resume();
    } catch (error) {
      // The editor's failure explains more than the resume failure that followed it.
      failure ??= error;
    }
  }
  if (failure !== null) throw failure;

  const after = await fingerprint(file);
  return {
    exitCode,
    signal,
    changed: differs(before, after),
    deleted: before !== null && after === null,
    file,
    argv,
  };
}
