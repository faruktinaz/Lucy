import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { configFilePath } from "@/core/config/load";
import { ConfigService } from "@/core/config/service";
import { resolveAppDirs } from "@/core/paths";
import {
  onboardingMarkerPath,
  readOnboardingMarker,
  shouldRunOnboarding,
  writeOnboardingMarker,
} from "@/features/settings/model/onboarding-marker";
import {
  type EditorCandidate,
  type OnboardingDeps,
  OnboardingModel,
} from "@/features/settings/model/onboarding-model";
import { UI_ICONS } from "@/themes/icons";
import { makeTempDirs, type TempDirs } from "../core/helpers";

let temp: TempDirs;
beforeEach(async () => {
  temp = await makeTempDirs();
});
afterEach(async () => {
  await temp.cleanup();
});

const EDITORS: EditorCandidate[] = [
  { id: "nvim", label: "Neovim", path: "/usr/bin/nvim" },
  { id: "micro", label: "micro", path: "/usr/bin/micro" },
];

async function setup(overrides: Partial<OnboardingDeps> = {}) {
  const config = await ConfigService.load(temp.dirs);
  const model = new OnboardingModel({
    config,
    dirs: temp.dirs,
    kittyKeyboard: false,
    platform: "linux",
    detectEditors: async () => EDITORS,
    ai: { detect: async () => ({ found: true, path: "/usr/local/bin/claude", version: "1.0.33" }) },
    now: () => new Date("2026-11-16T12:00:00.000Z"),
    home: join(temp.root, "home"),
    ...overrides,
  });
  await model.start();
  return { config, model };
}

const configExists = () => Bun.file(configFilePath(temp.dirs)).exists();

describe("shouldRunOnboarding", () => {
  test("only on a real first run, never in demo mode", async () => {
    expect(await shouldRunOnboarding({ dirs: temp.dirs })).toBe(true);
    expect(await shouldRunOnboarding({ dirs: temp.dirs, demo: true })).toBe(false);
    await mkdir(temp.dirs.config, { recursive: true });
    await writeFile(configFilePath(temp.dirs), "");
    expect(await shouldRunOnboarding({ dirs: temp.dirs })).toBe(false);
  });

  test("the marker alone prevents a second run, even if corrupt", async () => {
    await writeOnboardingMarker(temp.dirs, "skipped");
    expect(await shouldRunOnboarding({ dirs: temp.dirs })).toBe(false);
    await writeFile(onboardingMarkerPath(temp.dirs), "{ corrupt");
    expect(await shouldRunOnboarding({ dirs: temp.dirs })).toBe(false);
    expect(await readOnboardingMarker(temp.dirs)).toBeNull();
  });

  test("the marker lives in the state directory, not the config", () => {
    expect(onboardingMarkerPath(temp.dirs).startsWith(temp.dirs.state)).toBe(true);
  });
});

describe("the flow", () => {
  test("end to end: finish writes exactly the chosen keys and marks completion", async () => {
    const { config, model } = await setup();
    expect(model.state).toMatchObject({
      step: "theme",
      stepIndex: 0,
      stepCount: 6,
      canGoBack: false,
      canGoNext: true,
    });
    expect(model.state.themes.map((t) => t.id)).toEqual([
      "catppuccin-mocha",
      "tokyo-night",
      "gruvbox-dark",
      "dracula",
      "nord",
      "one-dark",
      "rose-pine",
      "kanagawa-wave",
      "everforest-dark",
      "github-dark",
      "solarized-dark",
      "high-contrast",
    ]);

    await model.chooseTheme("tokyo-night");
    // Live preview in memory; nothing on disk.
    expect(config.get("ui.theme")).toBe("tokyo-night");
    expect(await configExists()).toBe(false);
    expect(model.next()).toBe(true);

    expect(model.state.step).toBe("icons");
    expect(model.state.iconSamples.map((s) => s.glyph)).toContain(UI_ICONS.nerd.folder);
    expect(model.state.canGoNext).toBe(false);
    expect(model.next()).toBe(false);
    model.answerNerdFont(true);
    expect(model.next()).toBe(true);

    expect(model.state.step).toBe("keyboard");
    expect(model.state.keyboard.explanation).toContain("Ctrl+Shift+P");
    expect(model.state.keyboard.explanation).toContain("F1");
    model.next();

    expect(model.state.step).toBe("editor");
    expect(model.state.editors).toEqual({ status: "ready", value: EDITORS });
    model.chooseEditor("nvim");
    model.next();

    expect(model.state.step).toBe("ai");
    expect(model.state.ai).toEqual({
      status: "ready",
      value: { found: true, path: "/usr/local/bin/claude", version: "1.0.33" },
    });
    expect(model.state.aiStatement).toContain("never sends prompts by itself");
    expect(model.state.aiStatement).toContain("permission-bypass");
    model.next();

    expect(model.state.step).toBe("summary");
    expect(model.state.canGoNext).toBe(false);
    expect(model.state.summary.entries.map((e) => [e.configKey, e.valueLabel])).toEqual([
      ["ui.theme", "Tokyo Night"],
      ["ui.icons", "Nerd Font"],
      ["editor.external", "Neovim"],
    ]);
    // The config dir is outside the injected home here, so no "~" shortening applies.
    expect(model.state.summary.filePath).toBe(configFilePath(temp.dirs));

    expect(await model.finish()).toBe(true);
    expect(model.state.status).toBe("finished");
    expect(parse(await readFile(configFilePath(temp.dirs), "utf8"))).toEqual({
      version: 1,
      ui: { theme: "tokyo-night", icons: "nerd" },
      editor: { external: "nvim" },
    });
    expect(await readOnboardingMarker(temp.dirs)).toEqual({
      version: 1,
      outcome: "finished",
      completedAt: "2026-11-16T12:00:00.000Z",
    });
    expect(await shouldRunOnboarding({ dirs: temp.dirs })).toBe(false);
  });

  test("back navigation and finish only from the summary", async () => {
    const { model } = await setup();
    expect(model.back()).toBe(false);
    model.answerNerdFont(false);
    model.next();
    model.next();
    expect(model.state.step).toBe("keyboard");
    expect(model.back()).toBe(true);
    expect(model.state.step).toBe("icons");
    expect(await model.finish()).toBe(false);
  });

  test("skip writes no config, restores the previewed theme and prevents a second run", async () => {
    const { config, model } = await setup();
    await model.chooseTheme("gruvbox-dark");
    expect(await model.skip()).toBe(true);
    expect(config.get("ui.theme")).toBe("catppuccin-mocha");
    expect(await configExists()).toBe(false);
    expect((await readOnboardingMarker(temp.dirs))?.outcome).toBe("skipped");
    expect(await shouldRunOnboarding({ dirs: temp.dirs })).toBe(false);
    expect(await model.skip()).toBe(false);
  });

  test("finishing without changes writes no config file", async () => {
    const { model } = await setup();
    model.answerNerdFont(false);
    for (let i = 0; i < 5; i++) model.next();
    expect(model.state.summary.entries).toEqual([]);
    expect(await model.finish()).toBe(true);
    expect(await configExists()).toBe(false);
    expect((await readOnboardingMarker(temp.dirs))?.outcome).toBe("finished");
  });

  test("a failed save keeps the flow open and writes no marker", async () => {
    await writeFile(join(temp.root, "blocker"), "x");
    const dirs = resolveAppDirs({
      LUCY_CONFIG_DIR: join(temp.root, "blocker", "config"),
      LUCY_STATE_DIR: temp.dirs.state,
      HOME: temp.root,
    });
    const config = await ConfigService.load(dirs);
    const model = new OnboardingModel({
      config,
      dirs,
      kittyKeyboard: true,
      detectEditors: async () => [],
      ai: { detect: async () => ({ found: false }) },
    });
    await model.chooseTheme("tokyo-night");
    model.answerNerdFont(true);
    for (let i = 0; i < 5; i++) model.next();
    expect(await model.finish()).toBe(false);
    expect(model.state.status).toBe("active");
    expect(model.state.error).toContain("Could not save your choices");
    expect(await readOnboardingMarker(temp.dirs)).toBeNull();
  });

  test("detector failures are shown, not thrown", async () => {
    const { model } = await setup({
      detectEditors: async () => {
        throw new Error("PATH unreadable");
      },
      ai: {
        detect: async () => {
          throw new Error("claude --version crashed");
        },
      },
    });
    expect(model.state.editors).toEqual({ status: "error", error: "PATH unreadable" });
    expect(model.state.ai).toEqual({ status: "error", error: "claude --version crashed" });
  });

  test("the keyboard step explains the kitty protocol and the macOS Option caveat", async () => {
    const { model } = await setup({ kittyKeyboard: true, platform: "darwin" });
    expect(model.state.keyboard.kittyKeyboard).toBe(true);
    expect(model.state.keyboard.explanation).toContain("⌃⇧P work as written");
    expect(model.state.keyboard.explanation).toContain("Option");
  });

  test("re-running starts from the current settings", async () => {
    const config = await ConfigService.load(temp.dirs);
    await config.setMany([
      { path: "ui.theme", value: "gruvbox-dark" },
      { path: "ui.icons", value: "nerd" },
      { path: "editor.external", value: ["code", "--wait"] },
    ]);
    const model = new OnboardingModel({
      config,
      dirs: temp.dirs,
      kittyKeyboard: false,
      detectEditors: async () => EDITORS,
      ai: { detect: async () => ({ found: false }) },
    });
    expect(model.state.choices).toEqual({
      theme: "gruvbox-dark",
      nerdFontRenders: true,
      editor: ["code", "--wait"],
    });
    expect(model.state.summary.entries).toEqual([]);
    // Answering "no" moves away from the Nerd Font tier.
    model.answerNerdFont(false);
    expect(model.state.summary.entries.map((e) => [e.path, e.value])).toEqual([["ui.icons", "auto"]]);
  });

  test("abandon undoes the preview and writes nothing", async () => {
    const { config, model } = await setup();
    await model.chooseTheme("high-contrast");
    await model.abandon();
    expect(config.get("ui.theme")).toBe("catppuccin-mocha");
    expect(await readOnboardingMarker(temp.dirs)).toBeNull();
  });
});
