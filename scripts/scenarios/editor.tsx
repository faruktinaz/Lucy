/**
 * Screenshot scenarios for the code viewer, against the demo workspace. Loaded by
 * `bun run screenshots` (every file in this folder is imported before the run).
 */
import type { MountedApp } from "../../tests/helpers/app";
import { defineScenario, SIZES, untilHighlighted } from "../screenshots";

/** Highlighting runs in a worker (cold start about 250 ms, OPENTUI_NOTES §8). */
async function waitForColors(app: MountedApp): Promise<void> {
  await untilHighlighted(app);
}

async function openFile(app: MountedApp, path: string, line?: number, column?: number): Promise<void> {
  await app.tui.act(() => {
    const tab = app.ctx.editors.open({ kind: "file", resource: path });
    app.ctx.focus.focus("editor");
    if (line !== undefined) app.ctx.editors.reveal({ tabId: tab.id, line, column });
  });
  await app.tui.advance(50);
}

export async function typescriptScenario(app: MountedApp): Promise<void> {
  await openFile(app, "src/server/store/task-store.ts", 24);
  await waitForColors(app);
}

export async function findScenario(app: MountedApp): Promise<void> {
  await openFile(app, "src/server/store/task-store.ts");
  await waitForColors(app);
  await app.tui.press("ctrl+f");
  await app.tui.type("task");
  await app.tui.advance(150);
  await app.tui.press("enter");
  await app.tui.press("enter");
  await app.tui.advance(50);
}

export async function markdownPreviewScenario(app: MountedApp): Promise<void> {
  await openFile(app, "README.md");
  await app.tui.act(() => app.ctx.commands.execute("editor.toggleMarkdownPreview"));
  await waitForColors(app);
  await app.tui.advance(200);
}

export async function imageScenario(app: MountedApp): Promise<void> {
  await openFile(app, "assets/logo.png");
  await app.tui.advance(200);
}

export async function binaryScenario(app: MountedApp): Promise<void> {
  await openFile(app, "data/snapshot.bin");
  await app.tui.advance(100);
}

export async function unavailableScenario(app: MountedApp): Promise<void> {
  await openFile(app, "src/server/legacy-routes.ts");
  await app.tui.advance(100);
}

export async function longLinesScenario(app: MountedApp): Promise<void> {
  await openFile(app, "data/fixtures/tasks.min.json");
  await waitForColors(app);
  await app.tui.press("right");
  await app.tui.press("right");
}

export async function wrappedScenario(app: MountedApp): Promise<void> {
  await openFile(app, "data/fixtures/tasks.min.json");
  await app.tui.act(() => app.ctx.commands.execute("editor.toggleWrap"));
  await waitForColors(app);
}

const sizes = [SIZES.wide, SIZES.medium];

defineScenario("editor-typescript", typescriptScenario, {
  description: "A TypeScript file with syntax colors, line numbers and the active line",
  sizes,
});
defineScenario("editor-find", findScenario, {
  description: "The find bar with matches highlighted and the current match",
  sizes,
});
defineScenario("editor-markdown-preview", markdownPreviewScenario, {
  description: "The README rendered as a Markdown preview",
  sizes,
});
defineScenario("editor-image", imageScenario, {
  description: "An image: information card with dimensions and a preview",
  sizes,
});
defineScenario("editor-binary", binaryScenario, {
  description: "A binary file: information card and actions",
  sizes,
});
defineScenario("editor-unavailable", unavailableScenario, {
  description: "A file that does not exist: the calm unavailable state",
  sizes,
});
defineScenario("editor-long-lines", longLinesScenario, {
  description: "A minified JSON file scrolled horizontally",
  sizes,
});
defineScenario("editor-wrapped", wrappedScenario, {
  description: "The same file with word wrap on",
  sizes,
});
