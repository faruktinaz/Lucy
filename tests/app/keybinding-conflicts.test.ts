/**
 * Every feature is tested on its own; this test checks the union. Two default bindings on the
 * same keys that can fire in the same context make one of them silently dead, so any
 * overlap across DEFAULT_KEYBINDINGS and all feature modules fails here.
 */
import { describe, expect, test } from "bun:test";
import { FEATURES } from "@/app/features";
import { FOCUS_CONTEXT_KEYS } from "@/app/workbench/focus";
import { DEFAULT_KEYBINDINGS, KeybindingRegistry } from "@/core/keybindings";
import { EXCLUSIVE_CONTEXT_KEY_GROUPS } from "@/core/keybindings/context-keys";
import { parseWhen, whenOverlap } from "@/core/keybindings/when";

describe("default keybindings across all features", () => {
  test("no two default bindings can fire in the same context", () => {
    const defaults = [...DEFAULT_KEYBINDINGS, ...FEATURES.flatMap((feature) => feature.keybindings ?? [])];
    const conflicts = new KeybindingRegistry({ defaults }).conflicts();
    expect(conflicts.map((c) => c.message)).toEqual([]);
  });

  test("the declared focus-zone group is exactly the keys the focus service sets", () => {
    const zoneKeys = Object.values(FOCUS_CONTEXT_KEYS).sort();
    expect(EXCLUSIVE_CONTEXT_KEY_GROUPS.some((group) => [...group].sort().join() === zoneKeys.join())).toBe(
      true,
    );
  });

  test("exclusive groups separate zones but not keys outside the group", () => {
    const groups = EXCLUSIVE_CONTEXT_KEY_GROUPS;
    expect(whenOverlap(parseWhen("editorFocus"), parseWhen("sidebarFocus"), groups)).toBe(false);
    expect(whenOverlap(parseWhen("editorFocus"), parseWhen("sidebarFocus"))).toBe(true);
    expect(whenOverlap(parseWhen("editorFocus"), parseWhen("!sidebarFocus"), groups)).toBe(true);
    expect(whenOverlap(parseWhen("panelFocus"), parseWhen("terminalFocus"), groups)).toBe(true);
  });
});
