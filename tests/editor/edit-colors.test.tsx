/**
 * Syntax colors in the editable view land on the right cells: every checked token's cells carry
 * the color the syntax service assigns, on lines far apart, after a line with Turkish text and
 * an emoji, after a tab, and in a CRLF file.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RGBA } from "@opentui/core";
import { tokenizeLines } from "@/adapters/syntax";
import { editorFeature } from "@/features/editor";
import { BufferCells } from "@/features/editor/buffer-cells";
import { type MountedApp, mountApp } from "../helpers/app";

function body(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 45; i++) {
    if (i === 6) lines.push('// İstanbul ışık 😀 漢字 note "x"');
    else if (i === 9) lines.push("\tconst tabbed = 'tab';");
    else lines.push(`const value${i} = "text${i}"; // n${i}`);
  }
  return lines.join("\n");
}

async function mount(file: string, content: string): Promise<MountedApp> {
  const root = join(mkdtempSync(join(process.env.LUCY_TEST_ROOT ?? tmpdir(), "colors-")), "orbit");
  mkdirSync(root);
  writeFileSync(join(root, file), content);
  const app = await mountApp({ features: [editorFeature], workspace: { root } });
  await app.tui.act(() => {
    app.ctx.editors.open({ kind: "file", resource: file });
    app.ctx.focus.focus("editor");
  });
  await app.tui.waitForText("Saved");
  return app;
}

/** The foreground of the cell at (x, y). */
function cellFg(app: MountedApp, x: number, y: number): RGBA | undefined {
  const line = app.tui.spans().lines[y];
  let column = 0;
  for (const span of line?.spans ?? []) {
    if (x < column + span.width) return span.fg;
    column += span.width;
  }
  return undefined;
}

const ints = (color: RGBA | undefined) => color?.toInts().slice(0, 3).join(",");

/**
 * Checks every colored token of `lineIndex` (0-based) against the theme color of its group,
 * cell by cell. `anchor` is unique text on that line used to find it on screen.
 */
async function expectLineColors(
  app: MountedApp,
  text: string,
  lineIndex: number,
  anchor: string,
): Promise<number> {
  const style = app.ctx.themes.current.syntaxStyle;
  if (!style) throw new Error("no syntax style");
  const tokens =
    tokenizeLines(text, await app.ctx.services.syntax.highlight(text, "typescript"))[lineIndex] ?? [];
  const line = text.split("\n")[lineIndex] as string;
  const position = app.tui.findText(anchor);
  if (!position) throw new Error(`"${anchor}" is not on screen`);
  const cells = new BufferCells(text, 4);
  const anchorCell = cells.cell(lineIndex, line.indexOf(anchor));
  let checked = 0;
  for (const token of tokens) {
    const expected =
      style.getStyle(token.group)?.fg ?? style.getStyle(token.group.split(".")[0] as string)?.fg;
    if (!expected) continue;
    const from = cells.cell(lineIndex, token.start);
    const to = cells.cell(lineIndex, token.end);
    for (let cell = from; cell < to; cell++) {
      const x = position.x + cell - anchorCell;
      const char = line[token.start] ?? "";
      if (char.trim() === "") continue;
      expect({
        line: lineIndex + 1,
        token: line.slice(token.start, token.end),
        cell,
        fg: ints(cellFg(app, x, position.y)),
      }).toEqual({
        line: lineIndex + 1,
        token: line.slice(token.start, token.end),
        cell,
        fg: ints(expected as RGBA),
      });
      checked++;
    }
  }
  return checked;
}

async function untilColored(app: MountedApp, anchor: string): Promise<void> {
  const keyword = app.ctx.themes.current.colors.syntax.keyword;
  const deadline = performance.now() + 4000;
  while (performance.now() < deadline) {
    const position = app.tui.findText(anchor);
    if (position && ints(cellFg(app, position.x, position.y)) === ints(keyword)) return;
    await app.tui.advance(25);
  }
  throw new Error("the file was never colored");
}

describe("syntax colors in the editable view", () => {
  test("colors land on the right cells on lines far apart, after Turkish, emoji, CJK and a tab", async () => {
    const text = body();
    const app = await mount("colors.ts", `${text}\n`);
    // Colors come right after the file opens, without typing anything.
    await untilColored(app, "const value1 ");
    expect(await expectLineColors(app, text, 0, "const value1 ")).toBeGreaterThan(5);
    expect(await expectLineColors(app, text, 6, "const value7 ")).toBeGreaterThan(5);
    expect(await expectLineColors(app, text, 8, "const tabbed")).toBeGreaterThan(5);
    expect(await expectLineColors(app, text, 11, "const value12 ")).toBeGreaterThan(5);
    await app.tui.press("ctrl+end");
    await untilColored(app, "const value40 ");
    expect(await expectLineColors(app, text, 39, "const value40 ")).toBeGreaterThan(5);
  });

  test("a CRLF file", async () => {
    const text = body();
    const app = await mount("crlf.ts", `${text.replace(/\n/g, "\r\n")}\r\n`);
    await untilColored(app, "const value1 ");
    expect(await expectLineColors(app, text, 6, "const value7 ")).toBeGreaterThan(5);
    expect(await expectLineColors(app, text, 20, "const value21 ")).toBeGreaterThan(5);
  });
});
