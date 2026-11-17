/**
 * Several repositories below a workspace that is not a repository itself (real Git, isolated):
 * each is shown separately, a commit goes to the active repository, and refresh finds new ones.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mountApp } from "../helpers/app";
import { createMultiRepoWorkspace, createRepository } from "./multi-repo";
import { deferCleanup, registerCleanup } from "./support";

registerCleanup();

async function mountMulti() {
  const ws = await createMultiRepoWorkspace();
  deferCleanup(() => ws.dispose());
  const mounted = await mountApp({
    demoWorkspace: ws.demo,
    git: "real",
    startBackground: true,
    width: 120,
    height: 40,
    settings: { "git.repositoryScanDepth": 3, "workspace.watch": false },
  });
  await mounted.tui.act(() => mounted.ctx.commands.execute("view.showSourceControl"));
  await mounted.tui.waitForText("gamma", { timeoutMs: 8000 });
  return { ...mounted, ws };
}

describe("several repositories", () => {
  test("each repository is shown separately; plain folders and node_modules are not", async () => {
    const { tui, ctx } = await mountMulti();
    await tui.waitForText("new.txt", { timeoutMs: 8000 });
    const frame = tui.frame();
    for (const text of ["alpha", "beta", "gamma", "a.txt", "new.txt", "Commit to "])
      expect(frame).toContain(text);
    expect(frame).not.toContain("node_modules");
    expect(frame).not.toContain("No Git repository");
    // Nested deeper than one level: the path is shown beside the name (truncated when narrow).
    expect(frame).toContain("group/");
    const manager = ctx.services.gitRepositories;
    expect(manager.repositories.map((entry) => entry.root.split("/").at(-1))).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    // The status bar names the repository it describes and counts every change.
    const statusRow = tui.frame().trimEnd().split("\n").at(-1) ?? "";
    expect(statusRow).toMatch(/(alpha|beta|gamma): main/);
    expect(statusRow).toContain("2");
  }, 30_000);

  test("stage and commit act on the active repository, which the commit box names", async () => {
    const { tui, ctx, ws } = await mountMulti();
    await tui.waitForText("new.txt", { timeoutMs: 8000 });
    await tui.act(() => ctx.focus.focus("sidebar"));
    await tui.clickText("new.txt");
    await tui.waitForText("Commit to beta");
    // The click opened the diff of a file in a nested repository, loaded from that repository.
    await tui.waitForText("@@ -0,0 +1 @@", { timeoutMs: 8000 });
    expect(ctx.editors.active).toMatchObject({ kind: "diff", resource: "group/beta/new.txt" });
    await tui.act(() => ctx.focus.focus("sidebar"));
    await tui.press("s");
    await tui.waitForText("Staged new.txt");
    await tui.act(() => ctx.commands.execute("git.focusCommitInput"));
    await tui.type("Add new.txt to beta");
    await tui.press("ctrl+enter");
    await tui.waitForText("Committed", { timeoutMs: 10_000 });
    expect((await ws.git("group/beta", "log", "-1", "--format=%s")).trim()).toBe("Add new.txt to beta");
    expect((await ws.git("alpha", "log", "-1", "--format=%s")).trim()).toBe("Initial commit");
    // alpha's change is untouched and still listed.
    expect(tui.frame()).toContain("a.txt");
  }, 30_000);

  test("refresh finds a repository that appeared later", async () => {
    const { tui, ctx, ws } = await mountMulti();
    await createRepository(ws.containerDir, join(ws.root, "delta"), { "d.txt": "delta\n" });
    await tui.act(() => ctx.commands.execute("git.refresh"));
    await tui.waitForText("delta", { timeoutMs: 8000 });
    expect(ctx.services.gitRepositories.repositories).toHaveLength(4);
  }, 30_000);
});

describe("many repositories", () => {
  test("20 repositories: discovered, refreshed one after another, all shown (timings printed)", async () => {
    const ws = await createMultiRepoWorkspace();
    deferCleanup(() => ws.dispose());
    for (let i = 0; i < 17; i++) {
      await createRepository(ws.containerDir, join(ws.root, "many", `repo-${String(i).padStart(2, "0")}`), {
        "x.txt": "x\n",
      });
    }
    const started = performance.now();
    const { tui, ctx } = await mountApp({
      demoWorkspace: ws.demo,
      git: "real",
      startBackground: true,
      width: 120,
      height: 40,
      settings: { "git.repositoryScanDepth": 3, "workspace.watch": false },
    });
    const deadline = performance.now() + 20_000;
    while (
      ctx.services.createdServices.includes("gitRepositories") === false ||
      ctx.services.gitRepositories.repositories.length < 20
    ) {
      if (performance.now() > deadline) throw new Error("not all repositories appeared");
      await tui.advance(20);
    }
    const allMs = performance.now() - started;
    await tui.act(() => ctx.commands.execute("view.showSourceControl"));
    await tui.waitForText("repo-00");
    console.log(`20 repositories: all refreshed and listed ${allMs.toFixed(0)} ms after mounting`);
    expect(ctx.services.gitRepositories.repositories).toHaveLength(20);
  }, 60_000);
});
