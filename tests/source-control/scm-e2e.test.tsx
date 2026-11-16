/**
 * End-to-end flows against the real demo workspace (real Git, isolated environment):
 * stage → commit → the UI refreshes by itself; open a diff, toggle the layout, jump to the
 * next change and open the file at that line. Also the editor-view priority contract that lets
 * the diff view supersede the editor feature's placeholder.
 */
import { describe, expect, test } from "bun:test";
import { ViewRegistry } from "@/app/workbench/views";
import { mountApp } from "../helpers/app";
import { registerCleanup } from "./support";

registerCleanup();

const MULTI_HUNK_FILE = "src/server/routes/tasks.ts";

async function until(check: () => boolean, advance: (ms: number) => Promise<void>, timeoutMs = 8000) {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("Timed out");
    await advance(25);
  }
}

describe("Source Control with the real demo workspace", () => {
  test("stage → commit → the panel, badge and status bar refresh by themselves", async () => {
    const { tui, ctx } = await mountApp({
      workspace: "demo",
      git: "real",
      startBackground: true,
      width: 120,
      height: 35,
    });
    await tui.act(() => ctx.commands.execute("view.showSourceControl"));
    await until(
      () => tui.frame().includes("STAGED CHANGES"),
      (ms) => tui.advance(ms),
    );
    const before = ctx.services.git.state.status;
    if (!before) throw new Error("no status");
    const stagedBefore = before.staged.length;
    const totalBefore = before.staged.length + before.unstaged.length + before.untracked.length;
    expect(stagedBefore).toBeGreaterThan(0);

    // Stage one more file from the keyboard: select tasks.ts and press s.
    await tui.act(() => ctx.focus.focus("sidebar"));
    await tui.clickText("tasks.ts");
    await tui.act(() => ctx.focus.focus("sidebar"));
    await tui.press("s");
    await until(
      () => ctx.services.git.state.status?.staged.some((change) => change.path === MULTI_HUNK_FILE) ?? false,
      (ms) => tui.advance(ms),
    );

    // Commit through the commit box.
    await tui.act(() => ctx.commands.execute("git.focusCommitInput"));
    await tui.type("Tune task paging");
    await tui.press("ctrl+enter");
    await until(
      () => tui.frame().includes("Committed"),
      (ms) => tui.advance(ms),
      15000,
    );

    // No manual refresh: the status, the panel, the badge and the status bar follow.
    await until(
      () => !tui.frame().includes("STAGED CHANGES"),
      (ms) => tui.advance(ms),
    );
    const after = ctx.services.git.state.status;
    expect(after?.staged).toEqual([]);
    expect(after?.branch.ahead).toBe((before.branch.ahead ?? 0) + 1);
    const frame = tui.frame();
    expect(frame).toContain("Message (");
    expect(frame).toContain("Committed");
    expect(frame).toContain("Tune task paging on feature/command-");
    const totalAfter = (after?.unstaged.length ?? 0) + (after?.untracked.length ?? 0);
    expect(totalAfter).toBeLessThan(totalBefore);
    const statusRow = frame.trimEnd().split("\n").at(-1) ?? "";
    expect(statusRow).toContain(String(totalAfter));
    expect(statusRow).toContain(String((before.branch.ahead ?? 0) + 1));
    const log = await ctx.services.git.log({ limit: 1 });
    expect(log[0]?.subject).toBe("Tune task paging");
    expect(ctx.persisted.state.commitDraft).toBe("");
  }, 60_000);

  test("diff: open, toggle the layout, next change, open the file at that line", async () => {
    const { tui, ctx } = await mountApp({
      workspace: "demo",
      git: "real",
      startBackground: true,
      width: 120,
      height: 35,
    });
    await tui.act(() => ctx.commands.execute("view.showSourceControl"));
    await until(
      () => tui.frame().includes("tasks.ts"),
      (ms) => tui.advance(ms),
    );
    await tui.clickText("tasks.ts");
    await until(
      () => tui.frame().includes("@@ -"),
      (ms) => tui.advance(ms),
    );
    const tab = ctx.editors.active;
    expect(tab).toMatchObject({ kind: "diff", resource: MULTI_HUNK_FILE, preview: true });
    expect(tui.frame()).toContain("Working Tree");
    expect(tab?.viewState.resolvedLayout).toBe("unified");

    await tui.act(() => ctx.focus.focus("editor"));
    await tui.press("f7");
    const cursorAfterNext = ctx.editors.active?.viewState.cursor;
    expect(typeof cursorAfterNext).toBe("number");
    expect(cursorAfterNext).toBeGreaterThan(0);

    await tui.press("v");
    await until(
      () => ctx.editors.active?.viewState.resolvedLayout === "split",
      (ms) => tui.advance(ms),
    );
    expect(tui.frame()).toContain("Side by side");
    await tui.press("v");
    await until(
      () => ctx.editors.active?.viewState.resolvedLayout === "unified",
      (ms) => tui.advance(ms),
    );

    await tui.press("enter");
    await until(
      () => ctx.editors.active?.kind === "file",
      (ms) => tui.advance(ms),
    );
    expect(ctx.editors.active?.resource).toBe(MULTI_HUNK_FILE);
  }, 60_000);
});

describe("editor view priority", () => {
  const view = (priority?: number) => ({ kind: "diff", component: () => null, priority });

  test("the higher priority wins in either registration order and yields back on dispose", () => {
    for (const order of ["placeholder-first", "real-first"] as const) {
      const registry = new ViewRegistry();
      const placeholder = view();
      const real = view(10);
      const first = registry.registerEditorView(order === "placeholder-first" ? placeholder : real);
      const second = registry.registerEditorView(order === "placeholder-first" ? real : placeholder);
      expect(registry.editorView("diff")).toBe(real);
      (order === "placeholder-first" ? second : first).dispose();
      expect(registry.editorView("diff")).toBe(placeholder);
      (order === "placeholder-first" ? first : second).dispose();
      expect(registry.editorView("diff")).toBeUndefined();
    }
  });

  test("equal priorities still throw", () => {
    const registry = new ViewRegistry();
    registry.registerEditorView(view());
    expect(() => registry.registerEditorView(view())).toThrow();
  });
});
