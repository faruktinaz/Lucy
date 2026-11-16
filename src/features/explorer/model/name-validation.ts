/**
 * Live validation for the inline create / rename input. Mirrors the rules `FileOps` enforces
 * (so the user sees the problem while typing) plus an "already exists" check against what
 * the explorer has loaded. `FileOps` stays the authority at commit time.
 */
import { normalizeWorkspacePath } from "@/adapters/filesystem";
import { isLucyError } from "@/core/errors";
import { sanitizeForDisplay } from "@/core/text";
import type { ValidationMessage } from "./explorer-types";

export interface NameValidationInput {
  readonly root: string;
  /** Folder the name is relative to ("" for the workspace root). */
  readonly parentPath: string;
  readonly value: string;
  /** Kind of an existing entry at a workspace-relative path, as far as the explorer knows. */
  readonly kindOf: (path: string) => "file" | "directory" | null;
  /** Rename: the entry's current path, which may be "taken" by itself (case-only renames). */
  readonly currentPath?: string | null;
}

export function joinPath(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

/** Returns the message to show under the input; `severity: "error"` blocks the commit. */
export function validateEntryName(input: NameValidationInput): ValidationMessage | null {
  const { value } = input;
  if (value.trim() === "") {
    return { severity: "error", text: "Enter a name." };
  }
  if (value.startsWith("/")) {
    return { severity: "error", text: "A name cannot start with “/”." };
  }
  let normalized: string;
  try {
    normalized = normalizeWorkspacePath(input.root, joinPath(input.parentPath, value), "new");
  } catch (error) {
    if (!isLucyError(error)) throw error;
    if (error.code === "OUTSIDE_WORKSPACE") {
      return { severity: "error", text: "The name must stay inside the workspace." };
    }
    if (/control characters|NUL/.test(error.message)) {
      return { severity: "error", text: "Control characters cannot be used in a name." };
    }
    if (/too long/.test(error.message)) return { severity: "error", text: "The name is too long." };
    if (/"\."|"\.\."|empty segments/.test(error.message)) {
      return { severity: "error", text: "Remove the empty, “.” or “..” parts." };
    }
    return { severity: "error", text: error.message };
  }
  // A nested name ("a/b/c.ts") cannot go through an existing file.
  const segments = normalized.split("/");
  for (let i = 1; i < segments.length; i++) {
    const prefix = segments.slice(0, i).join("/");
    if (input.kindOf(prefix) === "file") {
      return {
        severity: "error",
        text: `“${sanitizeForDisplay(segments[i - 1] as string)}” is a file, not a folder.`,
      };
    }
  }
  if (normalized !== input.currentPath && input.kindOf(normalized) !== null) {
    const shown = sanitizeForDisplay(value.endsWith("/") ? value.slice(0, -1) : value);
    return {
      severity: "error",
      text: `“${shown}” already exists here.`,
    };
  }
  if (value !== value.trim()) {
    return { severity: "warning", text: "The name starts or ends with a space." };
  }
  return null;
}
