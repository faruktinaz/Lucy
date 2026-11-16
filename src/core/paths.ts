/**
 * Where Lucy keeps its own files, and the workspace-boundary checks.
 *
 * Lucy only ever writes inside its own config/state/cache directories and, on explicit user
 * action, inside the opened workspace. It never writes to other tools' configuration
 * (~/.zshrc, Ghostty, tmux, Atuin, ...).
 */
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface AppDirs {
  /** User-editable configuration (`config.toml`). */
  config: string;
  /** Machine-written state: workspace restore data, logs, undo trash. */
  state: string;
  /** Disposable data that can be rebuilt. */
  cache: string;
}

type Env = Record<string, string | undefined>;

function pick(env: Env, override: string, xdg: string, fallback: string): string {
  const explicit = env[override];
  if (explicit && isAbsolute(explicit)) return explicit;
  const base = env[xdg];
  // The XDG spec says relative paths are invalid and must be ignored.
  if (base && isAbsolute(base)) return join(base, "lucy");
  return join(env.HOME || homedir(), fallback, "lucy");
}

/**
 * Resolves Lucy's directories following the XDG Base Directory spec on every platform
 * (terminal users on macOS expect `~/.config`). `LUCY_CONFIG_DIR`, `LUCY_STATE_DIR` and
 * `LUCY_CACHE_DIR` override them; tests and demo mode use those to stay isolated.
 */
export function resolveAppDirs(env: Env = process.env): AppDirs {
  return {
    config: pick(env, "LUCY_CONFIG_DIR", "XDG_CONFIG_HOME", ".config"),
    state: pick(env, "LUCY_STATE_DIR", "XDG_STATE_HOME", join(".local", "state")),
    cache: pick(env, "LUCY_CACHE_DIR", "XDG_CACHE_HOME", ".cache"),
  };
}

/** Lexical containment check (no filesystem access). `root` itself counts as inside. */
export function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Resolves symlinks and returns the real path only if it stays inside `root`; otherwise
 * `null`. For a path that does not exist yet (create/rename target) the nearest existing
 * ancestor is resolved instead, so a symlinked parent cannot smuggle a write outside.
 */
export async function realpathWithin(root: string, target: string): Promise<string | null> {
  let realRoot: string;
  try {
    realRoot = await realpath(resolve(root));
  } catch {
    return null;
  }
  const absolute = resolve(root, target);
  let existing = absolute;
  const missing: string[] = [];
  while (true) {
    try {
      const real = await realpath(existing);
      const full = missing.length > 0 ? join(real, ...missing.reverse()) : real;
      return isWithin(realRoot, full) ? full : null;
    } catch {
      // A path that exists as a link but cannot be resolved is a dangling or looping
      // symlink. Its target may lie outside the root and would be created by a write, so
      // it can never be treated as "missing, inside the root".
      try {
        if ((await lstat(existing)).isSymbolicLink()) return null;
      } catch {
        // Truly missing: keep walking up.
      }
      const parent = dirname(existing);
      if (parent === existing) return null;
      missing.push(existing.slice(parent.length).replace(/^[/\\]+/, ""));
      existing = parent;
    }
  }
}

/** Workspace-relative path with forward slashes, for display and for Git. */
export function toRelativePosix(root: string, target: string): string {
  const rel = relative(root, target);
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/** Replaces the home directory prefix with `~` for display. */
export function tildify(path: string, home: string = homedir()): string {
  if (path === home) return "~";
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}
