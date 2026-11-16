import { describe, expect, test } from "bun:test";
import { CONFIG_MIGRATIONS, migrateConfig } from "@/core/config/migrations";
import {
  CONFIG_SECTIONS,
  type Config,
  getDescriptor,
  isSettingPath,
  type SettingDescriptor,
  settingsSchema,
  toSnakeCase,
} from "@/core/config/schema";
import {
  changedPaths,
  cloneValue,
  deepEqual,
  defaultConfig,
  getSetting,
  withSetting,
} from "@/core/config/values";
import type { ThemeId } from "@/themes/ids";

describe("settingsSchema", () => {
  for (const d of settingsSchema as readonly SettingDescriptor[]) {
    test(`${d.path} is well formed`, () => {
      expect(d.path).toBe(`${d.section}.${d.key}`);
      expect(d.tomlKey).toBe(toSnakeCase(d.key));
      expect(d.tomlPath).toBe(`${d.section}.${d.tomlKey}`);
      expect(d.title.length).toBeGreaterThan(2);
      expect(d.description.length).toBeGreaterThan(10);
      expect(d.expected.length).toBeGreaterThan(2);
      expect(d.schema.safeParse(d.default).success).toBe(true);
      if (d.type === "enum") expect(d.options?.map((o) => o.value)).toContain(d.default as string);
      if (d.type === "integer") {
        expect(d.default as number).toBeGreaterThanOrEqual(d.min ?? Number.NEGATIVE_INFINITY);
        expect(d.default as number).toBeLessThanOrEqual(d.max ?? Number.POSITIVE_INFINITY);
        expect(d.schema.safeParse((d.max ?? 0) + 1).success).toBe(false);
      }
    });
  }

  test("paths are unique and cover the documented sections", () => {
    const paths = settingsSchema.map((d) => d.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect([...CONFIG_SECTIONS]).toEqual([
      "ui",
      "layout",
      "editor",
      "explorer",
      "search",
      "git",
      "ai",
      "terminal",
      "workspace",
      "keybindings",
    ]);
  });

  test("lookups", () => {
    expect(getDescriptor("ui.theme").tomlKey).toBe("theme");
    expect(getDescriptor("layout.aiPanelWidth").tomlPath).toBe("layout.ai_panel_width");
    expect(isSettingPath("ui.theme")).toBe(true);
    expect(isSettingPath("ui.telemetry")).toBe(false);
    expect(toSnakeCase("networkTimeoutSeconds")).toBe("network_timeout_seconds");
  });

  test("the Config type is derived from the descriptors", () => {
    const config: Config = defaultConfig();
    const theme: ThemeId = config.ui.theme;
    const width: number = config.layout.sidebarWidth;
    const external: string | string[] = config.editor.external;
    expect([theme, width, external]).toEqual(["catppuccin-mocha", 30, "auto"]);
  });
});

describe("value helpers", () => {
  test("defaultConfig returns fresh copies", () => {
    const a = defaultConfig();
    a.explorer.exclude.push("x");
    expect(defaultConfig().explorer.exclude).toEqual([".git", ".DS_Store"]);
  });

  test("withSetting is immutable and keeps untouched sections", () => {
    const base = defaultConfig();
    const next = withSetting(base, "ui.density", "compact");
    expect(getSetting(next, "ui.density")).toBe("compact");
    expect(getSetting(base, "ui.density")).toBe("comfortable");
    expect(next.layout).toBe(base.layout);
    expect(changedPaths(base, next)).toEqual(["ui.density"]);
  });

  test("deepEqual and cloneValue", () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    const source = { list: [{ x: 1 }] };
    const copy = cloneValue(source);
    expect(copy).toEqual(source);
    expect(copy.list[0]).not.toBe(source.list[0]);
  });
});

describe("migrateConfig", () => {
  test("an empty table just gets the current version", () => {
    expect(migrateConfig({}, 0)).toMatchObject({ table: { version: 1 }, version: 1, notes: [] });
  });

  test("stops at a missing step instead of guessing", () => {
    const result = migrateConfig({ a: 1 }, 0, [], 3);
    expect(result.version).toBe(0);
    expect(result.applied).toEqual([]);
  });

  test("does not mutate its input", () => {
    const input = { theme: "tokyo-night", ui: { density: "compact" } };
    const snapshot = structuredClone(input);
    migrateConfig(input, 0);
    expect(input).toEqual(snapshot);
  });

  test("every migration is registered once per version", () => {
    const froms = CONFIG_MIGRATIONS.map((m) => m.from);
    expect(new Set(froms).size).toBe(froms.length);
  });
});
