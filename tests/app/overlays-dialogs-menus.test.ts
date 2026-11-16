import { describe, expect, test } from "bun:test";
import { DialogService } from "@/app/workbench/dialogs";
import { MenuService } from "@/app/workbench/menus";
import { OverlayService } from "@/app/workbench/overlays";
import { ContextKeys } from "@/core/keybindings";
import { type KeyStroke, keyStroke } from "@/core/keybindings/key-stroke";

const key = (name: string, modifiers: Partial<Omit<KeyStroke, "key">> = {}) => keyStroke(name, modifiers);

describe("OverlayService", () => {
  test("keeps a stack, tracks overlayOpen and emits changes", () => {
    const contextKeys = new ContextKeys();
    const overlays = new OverlayService(contextKeys);
    const changes: number[] = [];
    overlays.onDidChange((layers) => changes.push(layers.length));
    const dismissed: string[] = [];
    const a = overlays.push({ id: "a", modal: true, dismiss: () => dismissed.push("a") });
    const b = overlays.push({ id: "b", modal: false, dismiss: () => dismissed.push("b") });
    expect(overlays.top?.id).toBe("b");
    expect(overlays.isModalOpen).toBe(true);
    expect(contextKeys.get("overlayOpen")).toBe(true);
    expect(overlays.dismissTop()).toBe(true);
    expect(dismissed).toEqual(["b"]);
    a.dispose();
    expect(overlays.top?.id).toBe("b");
    b.dispose();
    b.dispose();
    expect(overlays.layers).toHaveLength(0);
    expect(contextKeys.get("overlayOpen")).toBe(false);
    expect(overlays.dismissTop()).toBe(false);
    expect(changes).toEqual([1, 2, 1, 0]);
  });

  test("pushing a layer with an existing id replaces it", () => {
    const overlays = new OverlayService();
    overlays.push({ id: "menu", modal: true, dismiss: () => {} });
    overlays.push({ id: "menu", modal: false, dismiss: () => {} });
    expect(overlays.layers).toHaveLength(1);
    expect(overlays.top?.modal).toBe(false);
  });
});

describe("DialogService", () => {
  test("confirm opens with the safe action focused and Enter cancels it", async () => {
    const overlays = new OverlayService();
    const dialogs = new DialogService(overlays);
    const result = dialogs.confirm({ title: "Discard changes?", confirmLabel: "Discard", danger: true });
    const request = dialogs.request;
    expect(request?.kind).toBe("confirm");
    expect(request?.danger).toBe(true);
    expect(request?.buttons.map((b) => [b.id, b.label, b.kind])).toEqual([
      ["cancel", "Cancel", "ghost"],
      ["confirm", "Discard", "danger"],
    ]);
    expect(request?.focusIndex).toBe(0);
    expect(overlays.top?.id).toBe("dialog");
    expect(overlays.top?.handleKey?.(key("enter"))).toBe(true);
    expect(await result).toBe(false);
    expect(dialogs.request).toBeNull();
    expect(overlays.layers).toHaveLength(0);
  });

  test("Tab and the arrow keys move between buttons", async () => {
    const dialogs = new DialogService(new OverlayService());
    const result = dialogs.confirm({ title: "Delete?" });
    dialogs.handleKey(key("tab"));
    expect(dialogs.request?.focusIndex).toBe(1);
    dialogs.handleKey(key("tab"));
    expect(dialogs.request?.focusIndex).toBe(0);
    dialogs.handleKey(key("tab", { shift: true }));
    expect(dialogs.request?.focusIndex).toBe(1);
    dialogs.handleKey(key("left"));
    expect(dialogs.request?.focusIndex).toBe(0);
    dialogs.handleKey(key("right"));
    dialogs.handleKey(key("right"));
    expect(dialogs.request?.focusIndex).toBe(1);
    dialogs.handleKey(key("enter"));
    expect(await result).toBe(true);
  });

  test("Escape cancels; other keys are not handled", async () => {
    const dialogs = new DialogService(new OverlayService());
    const result = dialogs.confirm({ title: "Sure?" });
    expect(dialogs.handleKey(key("x"))).toBe(false);
    expect(dialogs.handleKey(key("escape"))).toBe(true);
    expect(await result).toBe(false);
  });

  test("prompt: validation blocks submit until the value is fixed", async () => {
    const dialogs = new DialogService(new OverlayService());
    const result = dialogs.prompt({
      title: "New branch",
      value: "",
      validate: (value) => (value.trim() === "" ? "Enter a name" : undefined),
    });
    expect(dialogs.request?.focusIndex).toBe(-1);
    dialogs.handleKey(key("enter"));
    expect(dialogs.request?.error).toBe("Enter a name");
    dialogs.setValue("feature/x");
    expect(dialogs.request?.error).toBeUndefined();
    // Arrow keys belong to the text field while it has focus.
    expect(dialogs.handleKey(key("left"))).toBe(false);
    dialogs.handleKey(key("enter"));
    expect(await result).toBe("feature/x");
  });

  test("prompt: Tab cycles through the input and the buttons; cancel resolves undefined", async () => {
    const dialogs = new DialogService(new OverlayService());
    const result = dialogs.prompt({ title: "Name", value: "x" });
    dialogs.handleKey(key("tab"));
    expect(dialogs.request?.focusIndex).toBe(0);
    dialogs.handleKey(key("tab"));
    expect(dialogs.request?.focusIndex).toBe(1);
    dialogs.handleKey(key("tab"));
    expect(dialogs.request?.focusIndex).toBe(-1);
    dialogs.activate("cancel");
    expect(await result).toBeUndefined();
  });

  test("alert resolves on OK", async () => {
    const dialogs = new DialogService(new OverlayService());
    const result = dialogs.alert({ title: "Done" });
    expect(dialogs.request?.buttons.map((b) => b.id)).toEqual(["confirm"]);
    dialogs.handleKey(key("enter"));
    await result;
    expect(dialogs.request).toBeNull();
  });

  test("a second dialog waits for the first", async () => {
    const overlays = new OverlayService();
    const dialogs = new DialogService(overlays);
    const first = dialogs.confirm({ title: "First" });
    const second = dialogs.confirm({ title: "Second" });
    expect(dialogs.request?.title).toBe("First");
    dialogs.activate("confirm");
    expect(await first).toBe(true);
    expect(dialogs.request?.title).toBe("Second");
    expect(overlays.layers).toHaveLength(1);
    dialogs.cancel();
    expect(await second).toBe(false);
    expect(overlays.layers).toHaveLength(0);
  });

  test("dispose resolves everything as cancelled", async () => {
    const dialogs = new DialogService(new OverlayService());
    const a = dialogs.confirm({ title: "a" });
    const b = dialogs.prompt({ title: "b" });
    dialogs.dispose();
    expect(await a).toBe(false);
    expect(await b).toBeUndefined();
  });
});

describe("MenuService", () => {
  function createMenus() {
    const overlays = new OverlayService();
    const executed: string[] = [];
    const errors: string[] = [];
    const menus = new MenuService(overlays, {
      execute: async (command) => {
        executed.push(command);
        if (command === "boom") throw new Error("kaput");
      },
      onError: (title) => errors.push(title),
    });
    return { overlays, menus, executed, errors };
  }

  const items = [
    { id: "disabled", label: "Disabled", disabled: true },
    { id: "open", label: "Open", command: "file.open" },
    { kind: "separator" as const, id: "sep" },
    { id: "rename", label: "Rename", command: "file.rename" },
    { id: "boom", label: "Explode", command: "boom" },
  ];

  test("highlights the first enabled item and steps over separators and disabled items", () => {
    const { menus, overlays } = createMenus();
    menus.show({ x: 3, y: 4, items });
    expect(overlays.top?.id).toBe("menu");
    expect(menus.state.activeIndex).toBe(1);
    menus.handleKey(key("down"));
    expect(menus.state.activeIndex).toBe(3);
    menus.handleKey(key("down"));
    expect(menus.state.activeIndex).toBe(4);
    menus.handleKey(key("down"));
    expect(menus.state.activeIndex).toBe(1);
    menus.handleKey(key("up"));
    expect(menus.state.activeIndex).toBe(4);
    menus.handleKey(key("tab", { shift: true }));
    expect(menus.state.activeIndex).toBe(3);
    menus.handleKey(key("home"));
    expect(menus.state.activeIndex).toBe(1);
  });

  test("Enter runs the item's command and closes; every other key is captured", async () => {
    const { menus, executed, overlays } = createMenus();
    menus.show({ x: 0, y: 0, items });
    expect(menus.handleKey(key("q"))).toBe(true);
    menus.handleKey(key("down"));
    menus.handleKey(key("enter"));
    await Promise.resolve();
    expect(executed).toEqual(["file.rename"]);
    expect(menus.state.open).toBe(false);
    expect(overlays.layers).toHaveLength(0);
  });

  test("a run callback wins over a command; failures are reported", async () => {
    const { menus, executed, errors } = createMenus();
    let ran = false;
    menus.show({
      x: 0,
      y: 0,
      items: [
        {
          id: "x",
          label: "Callback",
          run: () => {
            ran = true;
          },
        },
        ...items,
      ],
    });
    await menus.choose(0);
    expect(ran).toBe(true);
    menus.show({ x: 0, y: 0, items });
    await menus.choose(4);
    expect(executed).toEqual(["boom"]);
    expect(errors).toEqual(["Explode failed: kaput"]);
    // Disabled items and separators do nothing.
    menus.show({ x: 0, y: 0, items });
    await menus.choose(0);
    await menus.choose(2);
    expect(menus.state.open).toBe(true);
  });

  test("Escape closes without running anything", () => {
    const { menus, executed } = createMenus();
    menus.show({ x: 0, y: 0, items }, { highlightFirst: false });
    expect(menus.state.activeIndex).toBe(-1);
    menus.handleKey(key("escape"));
    expect(menus.state.open).toBe(false);
    expect(executed).toEqual([]);
    expect(menus.handleKey(key("down"))).toBe(false);
  });
});
