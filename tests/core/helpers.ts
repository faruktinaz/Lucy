import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppDirs, resolveAppDirs } from "@/core/paths";

export interface TempDirs {
  /** Real (symlink-resolved) temp root; macOS's /var is a link to /private/var. */
  root: string;
  dirs: AppDirs;
  cleanup(): Promise<void>;
}

/** A private temp tree with Lucy's directories redirected into it via the LUCY_* overrides. */
export async function makeTempDirs(prefix = "lucy-test-"): Promise<TempDirs> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const dirs = resolveAppDirs({
    LUCY_CONFIG_DIR: join(root, "config"),
    LUCY_STATE_DIR: join(root, "state"),
    LUCY_CACHE_DIR: join(root, "cache"),
    HOME: join(root, "home"),
  });
  return { root, dirs, cleanup: () => rm(root, { recursive: true, force: true }) };
}
