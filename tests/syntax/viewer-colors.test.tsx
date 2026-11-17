/**
 * One real render: the code viewer in the mounted app colors a `.env.example` and a `.sql` file
 * (the two file types reported as uncolored) with the active theme's syntax colors.
 *
 * Colors are checked per screen row, not per cell: cell-exact alignment of highlighter output is
 * covered by `code-consistency.test.tsx`, and this test should only fail if a file is uncolored.
 */
import { describe, expect, test } from "bun:test";
import type { RGBA } from "@opentui/core";
import { editorFeature } from "@/features/editor";
import { type MountedApp, mountApp } from "../helpers/app";

const ENV = "# Database settings\nDATABASE_URL=postgres://localhost:5432/app\nDEBUG=true\n";
const SQL = "-- active users\nSELECT id, name FROM users WHERE name = 'Lucy';\n";

const key = (color: RGBA): string => color.toInts().join(",");

/** Foreground colors of the visible characters on the screen row that shows `text`. */
function rowColors(app: MountedApp, text: string): Set<string> | undefined {
  for (const line of app.tui.spans().lines) {
    if (
      !line.spans
        .map((span) => span.text)
        .join("")
        .includes(text)
    )
      continue;
    return new Set(line.spans.filter((span) => span.text.trim().length > 0).map((span) => key(span.fg)));
  }
  return undefined;
}

async function open(app: MountedApp, path: string): Promise<void> {
  await app.tui.act(() => {
    app.ctx.editors.open({ kind: "file", resource: path });
    app.ctx.focus.focus("editor");
  });
}

/** Highlighting runs asynchronously: wait until the row showing `text` uses every `colors`. */
async function expectRowColored(app: MountedApp, text: string, colors: readonly RGBA[]): Promise<void> {
  const deadline = performance.now() + 4000;
  const wanted = colors.map(key);
  while (true) {
    const seen = rowColors(app, text);
    if (seen && wanted.every((color) => seen.has(color))) return;
    if (performance.now() > deadline) {
      throw new Error(
        `${text}: wanted ${wanted.join(" / ")}, saw ${seen ? [...seen].join(" / ") : "no row"}`,
      );
    }
    await app.tui.advance(25);
  }
}

describe("viewer colors", () => {
  test("a .env.example and a .sql file are colored", async () => {
    const app = await mountApp({
      features: [editorFeature],
      files: { ".env.example": ENV, "db/query.sql": SQL },
    });
    try {
      const syntax = app.ctx.themes.current.colors.syntax;

      await open(app, ".env.example");
      await app.tui.waitForText("DATABASE_URL");
      await expectRowColored(app, "# Database settings", [syntax.comment]);
      await expectRowColored(app, "DATABASE_URL=postgres", [syntax.property, syntax.string]);
      await expectRowColored(app, "DEBUG=true", [syntax.property, syntax.constant]);
      expect(app.tui.frame()).toContain("Dotenv");

      await open(app, "db/query.sql");
      await app.tui.waitForText("SELECT id");
      await expectRowColored(app, "-- active users", [syntax.comment]);
      await expectRowColored(app, "SELECT id, name", [syntax.keyword, syntax.string, syntax.type]);
      expect(app.tui.frame()).toContain("SQL");
    } finally {
      await app.dispose();
    }
  }, 30_000);
});
