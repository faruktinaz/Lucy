/**
 * In-progress operation detection from marker files in the per-worktree Git directory (the same
 * files Git's own prompt scripts inspect). Reading files avoids spawning Git and never locks.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { GitOperation } from "./types";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ordered by precedence: a rebase that stops on a conflict can leave other markers behind
 * (e.g. MERGE_HEAD for merge commits being replayed), and the rebase is what the user must
 * continue or abort.
 */
const MARKERS: ReadonlyArray<readonly [GitOperation, string]> = [
  ["rebase", "rebase-merge"],
  ["merge", "MERGE_HEAD"],
  ["cherry-pick", "CHERRY_PICK_HEAD"],
  ["revert", "REVERT_HEAD"],
  ["bisect", "BISECT_LOG"],
];

export async function detectOperation(gitDir: string): Promise<GitOperation | null> {
  const [rebaseApply, amApplying, ...found] = await Promise.all([
    exists(join(gitDir, "rebase-apply")),
    exists(join(gitDir, "rebase-apply", "applying")),
    ...MARKERS.map(([, marker]) => exists(join(gitDir, marker))),
  ]);
  if (found[0]) return "rebase";
  // `rebase-apply/` is shared by `git am` and the apply backend of `git rebase`.
  if (rebaseApply) return amApplying ? "am" : "rebase";
  for (let i = 1; i < MARKERS.length; i++) {
    const marker = MARKERS[i];
    if (marker && found[i]) return marker[0];
  }
  return null;
}
