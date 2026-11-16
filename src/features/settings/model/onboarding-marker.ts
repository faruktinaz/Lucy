/**
 * The "onboarding done" marker. It is machine state (in Lucy's state directory), not a user
 * setting: a user who deletes config.toml to start over should not be onboarded again, and
 * someone who skipped onboarding should not find an unexplained key in their config.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@/core/config/atomic-write";
import { configFilePath } from "@/core/config/load";
import type { AppDirs } from "@/core/paths";

export const ONBOARDING_MARKER_FILE = "onboarding.json";

export interface OnboardingMarker {
  version: 1;
  outcome: "finished" | "skipped";
  completedAt: string;
}

export function onboardingMarkerPath(dirs: Pick<AppDirs, "state">): string {
  return join(dirs.state, ONBOARDING_MARKER_FILE);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function readOnboardingMarker(dirs: Pick<AppDirs, "state">): Promise<OnboardingMarker | null> {
  try {
    const data: unknown = JSON.parse(await readFile(onboardingMarkerPath(dirs), "utf8"));
    if (data && typeof data === "object" && (data as { version?: unknown }).version === 1) {
      return data as OnboardingMarker;
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeOnboardingMarker(
  dirs: Pick<AppDirs, "state">,
  outcome: OnboardingMarker["outcome"],
  now: Date = new Date(),
): Promise<OnboardingMarker> {
  const marker: OnboardingMarker = { version: 1, outcome, completedAt: now.toISOString() };
  await writeFileAtomic(onboardingMarkerPath(dirs), `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}

/**
 * True only on a real first run: no config file and no completion marker, and never in demo
 * mode. Any existing marker counts, even a corrupt one, so a damaged file cannot cause
 * onboarding to reappear for a user who already went through it.
 */
export async function shouldRunOnboarding(options: {
  dirs: Pick<AppDirs, "config" | "state">;
  demo?: boolean;
}): Promise<boolean> {
  if (options.demo) return false;
  if (await exists(configFilePath(options.dirs))) return false;
  return !(await exists(onboardingMarkerPath(options.dirs)));
}
