/**
 * Renders the synthetic test scene to every screenshot format, for looking at the renderer's
 * output with your own eyes.
 *
 *   bun tests/tooling/render-test-scene.tsx [outDir]     (default: a new temp directory)
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { saveScreenshot } from "../../scripts/screenshot";
import { mountTui } from "../helpers/tui";
import { TestScene } from "./test-scene";

async function main(): Promise<void> {
  // Same isolation as the test preload: OpenTUI must never write into the user's data dir.
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "lucy-scene-data-"));
  const outDir = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "lucy-scene-")));
  const tui = await mountTui(<TestScene />, { width: 120, height: 35 });
  const frame = tui.spans();
  await tui.dispose();
  const plain = await saveScreenshot(frame, join(outDir, "test-scene"), { ansi: true });
  const framed = await saveScreenshot(frame, join(outDir, "test-scene-window"), {
    window: { title: "lucy — ~/projects/lucy-workspace" },
  });
  console.log(JSON.stringify({ plain, framed }, null, 2));
}

await main();
