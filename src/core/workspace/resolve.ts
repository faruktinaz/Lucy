/**
 * Turns the `lucy <path>` argument into a workspace.
 *
 * Accepts `.`, relative, absolute and `~` paths. The target must exist; a file opens its
 * parent folder and remembers the file so the UI can open it. The workspace id is a stable
 * hash of the real (symlink-resolved) path, so the same folder reached through different
 * links shares its restore state.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fromFsError, LucyError } from "../errors";

export interface Workspace {
  /** Stable id: readable slug of the folder name plus a hash of the real path. */
  readonly id: string;
  /** Absolute, symlink-resolved root directory. */
  readonly root: string;
  /** Display name (the folder name). */
  readonly name: string;
}

export interface WorkspaceNotice {
  level: "info" | "warning";
  code: "home-directory" | "filesystem-root";
  message: string;
}

export interface ResolvedWorkspace {
  workspace: Workspace;
  /** Workspace-relative POSIX path of the file given on the command line, if any. */
  openFile?: string;
  notices: WorkspaceNotice[];
}

export interface ResolveWorkspaceOptions {
  /** Home directory for `~` expansion and the home notice. Defaults to the OS home. */
  home?: string;
}

/** Letters that do not decompose to ASCII under NFKD. */
const TRANSLITERATE: Readonly<Record<string, string>> = {
  ı: "i",
  ß: "ss",
  ø: "o",
  æ: "ae",
  œ: "oe",
  đ: "d",
  ł: "l",
};

function slug(name: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[ıßøæœđł]/g, (char) => TRANSLITERATE[char] ?? char)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return ascii || "workspace";
}

/** Stable id for a real path: same folder, same id, across runs and versions. */
export function workspaceId(realRoot: string): string {
  const hash = createHash("sha256").update(realRoot).digest("hex").slice(0, 16);
  return `${slug(basename(realRoot) || "root")}-${hash}`;
}

function expandHome(input: string, home: string): string {
  if (input === "~") return home;
  if (input.startsWith(`~${sep}`) || input.startsWith("~/")) return join(home, input.slice(2));
  if (input.startsWith("~")) {
    throw new LucyError("INVALID_ARGUMENT", `"${input}": ~user paths are not supported; use the full path`, {
      details: { path: input, reason: "unsupported-tilde" },
    });
  }
  return input;
}

async function realOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * Resolves the command-line path. Throws `LucyError` with code `NOT_FOUND`,
 * `PERMISSION_DENIED`, or `INVALID_ARGUMENT` (details.reason `not-a-directory` for sockets,
 * devices and the like, `unsupported-tilde` for `~user`).
 */
export async function resolveWorkspace(
  pathArg: string | undefined,
  cwd: string,
  options: ResolveWorkspaceOptions = {},
): Promise<ResolvedWorkspace> {
  const home = options.home ?? homedir();
  const input = pathArg === undefined || pathArg.trim() === "" ? "." : pathArg;
  if (input.includes("\0")) {
    throw new LucyError("INVALID_ARGUMENT", "Path contains a NUL character", { details: { reason: "nul" } });
  }
  const absolute = resolve(cwd, expandHome(input, home));

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(absolute);
  } catch (error) {
    throw fromFsError(error, absolute);
  }

  let directory: string;
  let file: string | undefined;
  if (info.isDirectory()) {
    directory = absolute;
  } else if (info.isFile()) {
    directory = dirname(absolute);
    file = basename(absolute);
  } else {
    throw new LucyError("INVALID_ARGUMENT", `Not a directory or file: ${absolute}`, {
      details: { path: absolute, reason: "not-a-directory" },
    });
  }

  let root: string;
  try {
    root = await realpath(directory);
    await access(root, constants.R_OK | constants.X_OK);
  } catch (error) {
    throw fromFsError(error, directory);
  }

  const notices: WorkspaceNotice[] = [];
  if (root === (await realOrSelf(home))) {
    notices.push({
      level: "info",
      code: "home-directory",
      message:
        "You opened your home folder. Search and file watching are limited here; open a project folder for the best experience.",
    });
  } else if (root === "/" || (isAbsolute(root) && dirname(root) === root)) {
    notices.push({
      level: "info",
      code: "filesystem-root",
      message:
        "You opened the filesystem root. Search and file watching are limited here; open a project folder instead.",
    });
  }

  return {
    workspace: { id: workspaceId(root), root, name: basename(root) || root },
    openFile: file,
    notices,
  };
}
