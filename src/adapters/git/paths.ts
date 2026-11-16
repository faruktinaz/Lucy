/**
 * Repository path rules and workspace/repository path mapping.
 *
 * Adapter methods take and return repo-relative POSIX paths (what Git prints). The workspace may
 * be opened at a subdirectory of the repository, so the explorer and other features convert with
 * these helpers instead of string concatenation.
 */
import { join, resolve, sep } from "node:path";
import { isWithin, toRelativePosix } from "@/core/paths";
import { gitPrecondition } from "./errors";
import type { GitRepositoryInfo } from "./types";

/**
 * Validates a repo-relative path and returns it in the form Git expects. Rejects empty, absolute,
 * NUL-containing and non-normalized paths (`a//b`, `./a`, `a/../b`): a path from status is always
 * normalized, so anything else is a caller bug or an injection attempt. A single trailing `/` is
 * allowed because Git reports untracked nested repositories that way (`vendor/lib/`).
 */
export function normalizeRepoPath(path: string, precomposeUnicode = false): string {
  if (typeof path !== "string" || path.length === 0) {
    throw gitPrecondition("invalid-argument", "A repository path must be a non-empty string.");
  }
  if (path.includes("\0")) {
    throw gitPrecondition("invalid-argument", "A repository path cannot contain NUL bytes.");
  }
  if (path.startsWith("/")) {
    throw gitPrecondition("invalid-argument", `Expected a repository-relative path, got "${path}".`);
  }
  const body = path.endsWith("/") ? path.slice(0, -1) : path;
  for (const segment of body.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw gitPrecondition("invalid-argument", `Not a normalized repository path: "${path}".`);
    }
  }
  // Git precomposes argv on macOS but not stdin pathspecs; an NFD name from readdir would then
  // silently match nothing. Normalizing here keeps both channels consistent.
  return precomposeUnicode ? path.normalize("NFC") : path;
}

export function normalizeRepoPaths(paths: readonly string[], precomposeUnicode = false): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeRepoPath(path, precomposeUnicode);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * A pathspec that matches exactly this path: `*`, `?`, `[`, a leading `:` or `:(magic)` in a file
 * name are not interpreted. Per-pathspec magic (rather than `--literal-pathspecs`) so the setting
 * never leaks into hooks or Git's internal subcommands.
 */
export function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}

export function literalPathspecs(paths: readonly string[]): string[] {
  return paths.map(literalPathspec);
}

/**
 * NUL-separated literal pathspecs for `--pathspec-from-file=- --pathspec-file-nul`: immune to
 * ARG_MAX and to newlines in names.
 */
export function pathspecStdin(paths: readonly string[]): string {
  return paths.map((path) => `${literalPathspec(path)}\0`).join("");
}

/** Splits paths into argv-sized chunks for commands without `--pathspec-from-file` (e.g. `clean`). */
export function chunkPaths(paths: readonly string[], maxBytes = 64 * 1024): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const path of paths) {
    const bytes = Buffer.byteLength(path) + 1;
    if (current.length > 0 && size + bytes > maxBytes) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(path);
    size += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** Repo-relative path for a workspace-relative path (`""` is the workspace root). */
export function toRepoPath(repo: GitRepositoryInfo, workspacePath: string): string {
  const clean = toPosix(workspacePath)
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  if (clean === "" || clean === ".") return repo.workspacePrefix;
  return repo.workspacePrefix ? `${repo.workspacePrefix}/${clean}` : clean;
}

/** Workspace-relative path for a repo-relative path, or `null` when it lies outside the workspace. */
export function toWorkspacePath(repo: GitRepositoryInfo, repoPath: string): string | null {
  const prefix = repo.workspacePrefix;
  if (!prefix) return repoPath;
  if (repoPath === prefix) return "";
  return repoPath.startsWith(`${prefix}/`) ? repoPath.slice(prefix.length + 1) : null;
}

export function isInWorkspace(repo: GitRepositoryInfo, repoPath: string): boolean {
  return toWorkspacePath(repo, repoPath) !== null;
}

/** Absolute filesystem path of a repo-relative path. */
export function toAbsolutePath(repo: GitRepositoryInfo, repoPath: string): string {
  return repoPath ? join(repo.root, ...repoPath.split("/")) : repo.root;
}

/**
 * Repo-relative path for an absolute path, or `null` when outside the repository. Accepts paths
 * under either the resolved root or the workspace root as given (they differ when the workspace
 * was opened through a symlink, e.g. `/var` vs `/private/var` on macOS).
 */
export function fromAbsolutePath(repo: GitRepositoryInfo, absolutePath: string): string | null {
  const target = resolve(absolutePath);
  if (isWithin(repo.root, target)) return toRelativePosix(repo.root, target);
  if (isWithin(repo.workspaceRoot, target)) {
    return toRepoPath(repo, toRelativePosix(repo.workspaceRoot, target));
  }
  return null;
}
