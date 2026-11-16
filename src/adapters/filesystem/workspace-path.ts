/**
 * Validation and resolution of workspace-relative paths.
 *
 * Paths exchanged between services and the UI are workspace-relative, POSIX-style, never
 * normalized to NFC/NFD (on Linux both spellings can name different files), and "" means
 * the workspace root. Paths used for IO are only ever built from a resolved real parent
 * directory, so a symlinked parent cannot redirect a mutation outside the workspace.
 */
import { isAbsolute, join, posix } from "node:path";
import { LucyError } from "@/core/errors";
import { isWithin, realpathWithin } from "@/core/paths";

export type PathMode =
  /** A name about to be created: strict rules (no control characters, length limit). */
  | "new"
  /** An entry that already exists: anything the filesystem accepted, minus traversal. */
  | "existing";

const MAX_NAME_BYTES = 255;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Validates a workspace-relative path and returns it without a trailing slash.
 * Throws `INVALID_ARGUMENT` for malformed input and `OUTSIDE_WORKSPACE` for traversal.
 */
export function normalizeWorkspacePath(root: string, input: string, mode: PathMode): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new LucyError("INVALID_ARGUMENT", "The name must not be empty");
  }
  if (input.includes("\0")) {
    throw new LucyError("INVALID_ARGUMENT", "The name must not contain a NUL character");
  }
  if (isAbsolute(input)) {
    if (isWithin(root, input)) {
      throw new LucyError("INVALID_ARGUMENT", "Use a path relative to the workspace, not an absolute path", {
        details: { path: input },
      });
    }
    throw new LucyError("OUTSIDE_WORKSPACE", "The path is outside the workspace", {
      details: { path: input },
    });
  }
  const trimmed = input.endsWith("/") ? input.slice(0, -1) : input;
  const segments = trimmed.split("/");
  if (segments.includes("..")) {
    const escapes = posix.normalize(trimmed).split("/")[0] === "..";
    throw escapes
      ? new LucyError("OUTSIDE_WORKSPACE", "The path is outside the workspace", { details: { path: input } })
      : new LucyError("INVALID_ARGUMENT", 'The path must not contain ".." segments', {
          details: { path: input },
        });
  }
  for (const segment of segments) {
    if (segment === "") {
      throw new LucyError("INVALID_ARGUMENT", "The path must not contain empty segments", {
        details: { path: input },
      });
    }
    if (segment === ".") {
      throw new LucyError("INVALID_ARGUMENT", 'The path must not contain "." segments', {
        details: { path: input },
      });
    }
    if (mode === "new") {
      if (CONTROL.test(segment)) {
        throw new LucyError("INVALID_ARGUMENT", "The name must not contain control characters", {
          details: { path: input },
        });
      }
      if (Buffer.byteLength(segment, "utf8") > MAX_NAME_BYTES) {
        throw new LucyError("INVALID_ARGUMENT", "The name is too long", { details: { path: input } });
      }
    }
  }
  return trimmed;
}

/** Joins a workspace-relative POSIX path onto an absolute directory. */
export function joinRelative(base: string, rel: string): string {
  return rel === "" ? base : join(base, ...rel.split("/"));
}

/** Parent of a workspace-relative path ("" for top-level entries). */
export function parentOf(rel: string): string {
  const index = rel.lastIndexOf("/");
  return index === -1 ? "" : rel.slice(0, index);
}

/** Last segment of a workspace-relative path. */
export function nameOf(rel: string): string {
  const index = rel.lastIndexOf("/");
  return index === -1 ? rel : rel.slice(index + 1);
}

function outside(rel: string): LucyError {
  return new LucyError("OUTSIDE_WORKSPACE", "The path is outside the workspace", { details: { path: rel } });
}

/**
 * Absolute IO path for the entry itself (a symlink stays a symlink): the parent directory
 * is resolved through `realpathWithin`, the last segment is appended verbatim. Use for
 * delete, rename sources and existence checks.
 */
export async function resolveEntryPath(root: string, rel: string): Promise<string> {
  const parent = await realpathWithin(root, joinRelative(".", parentOf(rel)));
  if (parent === null) throw outside(rel);
  return rel === "" ? parent : join(parent, nameOf(rel));
}

/**
 * Absolute IO path with every symlink resolved; must stay inside the workspace. For a path
 * that does not exist yet, the nearest existing ancestor is resolved.
 */
export async function resolveTargetPath(root: string, rel: string): Promise<string> {
  const real = await realpathWithin(root, joinRelative(".", rel));
  if (real === null) throw outside(rel);
  return real;
}
