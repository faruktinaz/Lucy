import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { FeatureModule } from "@/app/feature";
import { FEATURES } from "@/app/features";
import { createTestDirs, mountApp } from "../helpers/app";
import { stableWorkspace } from "./support";

describe("error containment", () => {
  test("a view that throws shows an error state with Retry; the rest of the workbench keeps working", async () => {
    let broken = true;
    const flaky: FeatureModule = {
      id: "flaky",
      activate: (ctx) =>
        ctx.views.registerSidebarView({
          id: "flaky",
          title: "Flaky",
          icon: "extensions",
          order: 1,
          component: () => {
            if (broken) throw new Error("The view exploded");
            return <text>Recovered view</text>;
          },
        }),
    };
    const original = console.error;
    console.error = () => {};
    try {
      const { tui, ctx } = await mountApp({
        workspace: { root: stableWorkspace() },
        features: [flaky, ...FEATURES],
      });
      await tui.act(() => ctx.layout.showSidebarView("flaky"));
      const frame = tui.frame();
      expect(frame).toContain("Flaky stopped working");
      expect(frame).toContain("The view exploded.");
      expect(frame).toContain("Retry");
      // Everything else still renders and responds.
      expect(frame).toContain("Search files and commands");
      await tui.press("f1");
      expect(ctx.quickPick.state.open).toBe(true);
      await tui.press("escape");
      broken = false;
      await tui.clickText("Retry");
      expect(tui.frame()).toContain("Recovered view");
    } finally {
      console.error = original;
    }
  });

  test("a feature that fails to activate is reported and the app still starts", async () => {
    const failing: FeatureModule = {
      id: "failing",
      activate: () => {
        throw new Error("boom");
      },
    };
    const { tui } = await mountApp({
      workspace: { root: stableWorkspace() },
      features: [failing, ...FEATURES],
    });
    const frame = tui.frame();
    expect(frame).toContain("The failing feature failed to start");
    expect(frame).toContain("EXPLORER");
  });
});

describe("workspace restore", () => {
  test("layout and open tabs come back in the same workspace", async () => {
    const root = stableWorkspace();
    const dirs = createTestDirs();
    const first = await mountApp({ workspace: { root }, dirs });
    await first.tui.act(() => {
      first.ctx.editors.open({ kind: "file", resource: "README.md" });
      first.ctx.editors.open({ kind: "file", resource: "src/main.ts" });
      first.ctx.layout.setBottomVisible(true);
      first.ctx.layout.setSidebarWidth(36);
      first.ctx.layout.showSidebarView("scm");
    });
    await first.dispose();

    const second = await mountApp({ workspace: { root }, dirs });
    const { ctx } = second;
    expect(ctx.editors.tabs.map((tab) => tab.resource)).toEqual(["README.md", "src/main.ts"]);
    expect(ctx.editors.active?.resource).toBe("src/main.ts");
    expect(ctx.layout.state.bottom.visible).toBe(true);
    expect(ctx.layout.state.sidebar.width).toBe(36);
    expect(ctx.layout.state.sidebar.view).toBe("scm");
    expect(second.tui.frame()).toContain("SOURCE CONTROL");
  });

  test("--no-restore and workspace.restore = false start fresh", async () => {
    const root = stableWorkspace();
    const dirs = createTestDirs();
    const first = await mountApp({ workspace: { root }, dirs });
    await first.tui.act(() => first.ctx.editors.open({ kind: "file", resource: "README.md" }));
    await first.dispose();

    const noRestore = await mountApp({ workspace: { root }, dirs, restore: false });
    expect(noRestore.ctx.editors.tabs).toEqual([]);
    await noRestore.dispose();
    const disabled = await mountApp({ workspace: { root }, dirs, settings: { "workspace.restore": false } });
    expect(disabled.ctx.editors.tabs).toEqual([]);
  });
});

describe("design tokens only", () => {
  const roots = ["src/ui", "src/features"];
  const HEX = /["'`]#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})["'`]/;

  function files(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) out.push(...files(path));
      else if (/\.(ts|tsx)$/.test(name)) out.push(path);
    }
    return out;
  }

  test("no hex color literals under src/ui or src/features", () => {
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of files(join(import.meta.dir, "..", "..", root))) {
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, index) => {
            if (HEX.test(line))
              offenders.push(`${relative(process.cwd(), file)}:${index + 1}: ${line.trim()}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });

  test("components do not construct colors from numbers either", () => {
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of files(join(import.meta.dir, "..", "..", root))) {
        const text = readFileSync(file, "utf8");
        if (/RGBA\.(fromHex|fromInts)\(/.test(text) && !file.endsWith(join("theme", "ui-theme.ts"))) {
          offenders.push(relative(process.cwd(), file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
