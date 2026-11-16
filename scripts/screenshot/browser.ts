/** Finds a headless-capable Chromium-family browser for PNG rendering. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { which } from "@/core/process";

export interface BrowserInfo {
  name: string;
  path: string;
}

/** Overrides discovery with an explicit executable path. */
export const BROWSER_ENV_VAR = "LUCY_SCREENSHOT_BROWSER";

const MAC_APPS: [name: string, bundle: string, binary: string][] = [
  ["Google Chrome", "Google Chrome.app", "Google Chrome"],
  ["Chromium", "Chromium.app", "Chromium"],
  ["Brave Browser", "Brave Browser.app", "Brave Browser"],
  ["Google Chrome Canary", "Google Chrome Canary.app", "Google Chrome Canary"],
  ["Microsoft Edge", "Microsoft Edge.app", "Microsoft Edge"],
];

const PATH_NAMES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "brave-browser",
  "brave",
  "microsoft-edge",
];

export interface FindBrowserOptions {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

/** The first browser found, or null. Never launches anything. */
export function findBrowser(options: FindBrowserOptions = {}): BrowserInfo | null {
  const env = options.env ?? process.env;
  const explicit = env[BROWSER_ENV_VAR];
  if (explicit) return existsSync(explicit) ? { name: "custom", path: explicit } : null;

  if ((options.platform ?? process.platform) === "darwin") {
    for (const root of ["/Applications", join(env.HOME || homedir(), "Applications")]) {
      for (const [name, bundle, binary] of MAC_APPS) {
        const path = join(root, bundle, "Contents", "MacOS", binary);
        if (existsSync(path)) return { name, path };
      }
    }
  }
  for (const name of PATH_NAMES) {
    const path = which(name, env);
    if (path) return { name, path };
  }
  return null;
}
