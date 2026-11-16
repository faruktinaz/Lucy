/**
 * Branch-name rules from `git check-ref-format --branch`, checked synchronously so the create
 * branch prompt can explain a bad name while the user types. Git validates again when the
 * branch is created; this is only the fast, friendly first line.
 */

/** A human explanation of why `name` is not a valid branch name, or `undefined` when it is. */
export function branchNameProblem(name: string): string | undefined {
  if (name.length === 0) return "Enter a branch name.";
  if (name.length > 255) return "Branch names are limited to 255 characters.";
  if (name === "HEAD" || name === "@") return `"${name}" is reserved by Git.`;
  if (name.startsWith("-")) return "A branch name cannot start with a dash.";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
  if (/[\u0000- \u007f]/.test(name)) return "Spaces and control characters are not allowed.";
  if (/[~^:?*[\\]/.test(name)) return "These characters are not allowed: ~ ^ : ? * [ \\";
  if (name.includes("..")) return 'A branch name cannot contain "..".';
  if (name.includes("@{")) return 'A branch name cannot contain "@{".';
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) {
    return "Slashes must separate non-empty parts.";
  }
  if (name.endsWith(".")) return "A branch name cannot end with a dot.";
  for (const part of name.split("/")) {
    if (part.startsWith(".")) return "No part of a branch name may start with a dot.";
    if (part.endsWith(".lock")) return 'No part of a branch name may end with ".lock".';
  }
  return undefined;
}

/** The local branch name a remote-tracking branch is checked out as (`origin/feat/x` → `feat/x`). */
export function localNameForRemote(remoteBranch: string, remote: string | undefined): string {
  if (remote && remoteBranch.startsWith(`${remote}/`)) return remoteBranch.slice(remote.length + 1);
  const slash = remoteBranch.indexOf("/");
  return slash === -1 ? remoteBranch : remoteBranch.slice(slash + 1);
}
