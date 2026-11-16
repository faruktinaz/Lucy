/** Where Lucy's log file lives, and how large it may grow. */
import { join } from "node:path";
import type { AppDirs } from "@/core/paths";

/** Rotated to `lucy.log.1` when it grows past this size at startup. */
export const LOG_FILE_MAX_BYTES = 2 * 1024 * 1024;

export function logFilePath(dirs: Pick<AppDirs, "state">): string {
  return join(dirs.state, "logs", "lucy.log");
}
