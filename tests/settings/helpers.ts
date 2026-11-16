import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeatureModule } from "@/app/feature";
import { FEATURES } from "@/app/features";
import { createSettingsFeature, type SettingsFeatureOptions } from "@/features/settings";

/** The real feature list with the Settings feature configured for a test. */
export function withSettings(options: SettingsFeatureOptions): readonly FeatureModule[] {
  return FEATURES.map((feature) => (feature.id === "settings" ? createSettingsFeature(options) : feature));
}

/** A temporary PATH directory with fake executables (`name -> shell script body`). */
export function fakeBin(tools: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(process.env.LUCY_TEST_ROOT ?? tmpdir(), "bin-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(tools)) {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }
  return dir;
}

/** Masks what differs between runs (temporary names and paths) for text snapshots. */
export function normalizeFrame(frame: string): string {
  return (
    frame
      .split("\n")
      .map((line) =>
        line.includes("Saved in") ? line.replace(/Saved in .*/, "Saved in <config path>") : line,
      )
      .join("\n")
      .replace(/workspace-[A-Za-z0-9]+/g, "workspace-XXXXXX")
      // Bun's snapshot files cannot round-trip these characters (key labels Ctrl+` and Ctrl+\).
      .replace(/`/g, "'")
      .replace(/\\/g, "|")
  );
}
