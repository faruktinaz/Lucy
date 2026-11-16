/**
 * Proof of ownership for directories the demo builder creates.
 *
 * Deleting a directory tree is the most destructive thing the builder does, so it only
 * ever deletes a directory that (a) lies inside the real temporary directory and (b)
 * contains a marker file carrying a token that only this builder instance knows.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { LucyError } from "../../core/errors";
import { isWithin } from "../../core/paths";

export const OWNER_MARKER_NAME = ".lucy-demo-owner";

interface MarkerContent {
  createdBy: "lucy-demo";
  token: string;
}

/** The temporary directory with symlinks resolved (on macOS `/var` is a link to `/private/var`). */
export function realTempDir(): string {
  return realpathSync(tmpdir());
}

export function writeOwnerMarker(dir: string, token: string): void {
  const content: MarkerContent = { createdBy: "lucy-demo", token };
  writeFileSync(join(dir, OWNER_MARKER_NAME), `${JSON.stringify(content)}\n`, { flag: "wx", mode: 0o600 });
}

function refuse(dir: string, reason: string): LucyError {
  return new LucyError("PERMISSION_DENIED", `Refusing to remove ${dir}: ${reason}`, { details: { dir } });
}

/** Throws unless `dir` is a directory inside the real temp directory holding our marker. */
export function assertOwnedDirectory(dir: string, token: string): string {
  if (!isAbsolute(dir)) throw refuse(dir, "path is not absolute");
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    throw refuse(dir, "it does not exist");
  }
  const temp = realTempDir();
  if (real === temp || !isWithin(temp, real)) throw refuse(dir, "it is not inside the temporary directory");
  if (!lstatSync(real).isDirectory()) throw refuse(dir, "it is not a directory");

  const markerPath = join(real, OWNER_MARKER_NAME);
  let marker: Partial<MarkerContent> | null = null;
  try {
    // lstat first: a symlinked marker could vouch for a directory we never created.
    if (lstatSync(markerPath).isFile()) {
      marker = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<MarkerContent>;
    }
  } catch {
    marker = null;
  }
  if (marker?.createdBy !== "lucy-demo" || marker.token !== token) {
    throw refuse(dir, "it has no ownership marker from this demo build");
  }
  return real;
}

/**
 * Removes a directory the builder owns. With `keepDirectory`, only its contents are removed
 * (used when the caller supplied an existing, empty directory that we did not create).
 */
export function removeOwnedDirectory(dir: string, token: string, keepDirectory = false): void {
  const real = assertOwnedDirectory(dir, token);
  if (!keepDirectory) {
    rmSync(real, { recursive: true, force: true });
    return;
  }
  // The marker goes last so an interrupted cleanup can still be retried.
  for (const entry of readdirSync(real)) {
    if (entry !== OWNER_MARKER_NAME) rmSync(join(real, entry), { recursive: true, force: true });
  }
  rmSync(join(real, OWNER_MARKER_NAME), { force: true });
}
