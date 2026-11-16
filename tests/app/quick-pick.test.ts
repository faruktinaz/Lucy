import { describe, expect, test } from "bun:test";
import { OverlayService } from "@/app/workbench/overlays";
import { filterQuickPickItems, type QuickPickItem, QuickPickService } from "@/app/workbench/quick-pick";
import { type KeyStroke, keyStroke } from "@/core/keybindings/key-stroke";

const key = (name: string, modifiers: Partial<Omit<KeyStroke, "key">> = {}) => keyStroke(name, modifiers);
const item = (id: string, label = id, extra: Partial<QuickPickItem> = {}): QuickPickItem => ({
  id,
  label,
  ...extra,
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function createPicker() {
  const overlays = new OverlayService();
  const errors: string[] = [];
  const picker = new QuickPickService(overlays, undefined, (title) => errors.push(title));
  return { overlays, picker, errors };
}

describe("QuickPickService providers", () => {
  test("the longest matching prefix chooses the provider", () => {
    const { picker, overlays } = createPicker();
    const queries: string[] = [];
    for (const prefix of ["", ">", ":"]) {
      picker.registerProvider({
        prefix,
        title: `provider ${prefix || "files"}`,
        placeholder: `placeholder ${prefix}`,
        provideItems: (query) => {
          queries.push(`${prefix}|${query}`);
          return [item(`${prefix}-result`)];
        },
        accept: () => {},
      });
    }
    picker.show(">");
    expect(picker.state).toMatchObject({
      open: true,
      prefix: ">",
      title: "provider >",
      placeholder: "placeholder >",
    });
    expect(overlays.top?.id).toBe("quickPick");
    picker.setValue("> toggle side");
    picker.setValue(":42");
    picker.setValue("main.ts");
    expect(queries).toEqual([">|", ">|toggle side", ":|42", "|main.ts"]);
    expect(picker.state.items.map((i) => i.id)).toEqual(["-result"]);
  });

  test("an async provider shows loading, and a stale answer is ignored", async () => {
    const { picker } = createPicker();
    const pending = new Map<string, ReturnType<typeof deferred<readonly QuickPickItem[]>>>();
    const aborted: string[] = [];
    picker.registerProvider({
      prefix: "",
      title: "Files",
      placeholder: "",
      provideItems: (query, signal) => {
        const d = deferred<readonly QuickPickItem[]>();
        pending.set(query, d);
        signal.addEventListener("abort", () => aborted.push(query));
        return d.promise;
      },
      accept: () => {},
    });
    picker.show("");
    expect(picker.state.loading).toBe(true);
    picker.setValue("ma");
    expect(aborted).toEqual([""]);
    pending.get("ma")?.resolve([item("main.ts")]);
    await tick();
    expect(picker.state.loading).toBe(false);
    expect(picker.state.items.map((i) => i.id)).toEqual(["main.ts"]);
    // The first request answers late: its result must not replace the newer one.
    pending.get("")?.resolve([item("stale")]);
    await tick();
    expect(picker.state.items.map((i) => i.id)).toEqual(["main.ts"]);
  });

  test("provider failures become a calm empty text", async () => {
    const { picker } = createPicker();
    picker.registerProvider({
      prefix: ">",
      title: "Commands",
      placeholder: "",
      provideItems: () => {
        throw new Error("registry exploded");
      },
      accept: () => {},
    });
    picker.registerProvider({
      prefix: "",
      title: "Files",
      placeholder: "",
      provideItems: async () => {
        throw new Error("index failed");
      },
      accept: () => {},
    });
    picker.show(">");
    expect(picker.state.items).toEqual([]);
    expect(picker.state.emptyText).toBe("Could not list items: registry exploded");
    picker.setValue("x");
    await tick();
    expect(picker.state.emptyText).toBe("Could not list items: index failed");
    expect(picker.state.loading).toBe(false);
  });

  test("Enter accepts with the query after the prefix and closes", async () => {
    const { picker, overlays, errors } = createPicker();
    const accepted: string[] = [];
    picker.registerProvider({
      prefix: ">",
      title: "Commands",
      placeholder: "",
      provideItems: () => [item("a"), item("b"), item("disabled", "disabled", { disabled: true })],
      accept: (picked, query) => {
        accepted.push(`${picked.id}|${query}`);
        if (picked.id === "b") throw new Error("nope");
      },
    });
    picker.show(">  run ");
    expect(picker.handleKey(key("enter"))).toBe(true);
    await tick();
    expect(accepted).toEqual(["a|run"]);
    expect(picker.isOpen).toBe(false);
    expect(overlays.layers).toHaveLength(0);

    picker.show(">");
    picker.handleKey(key("down"));
    await picker.accept();
    expect(errors).toEqual(["Commands: nope"]);

    picker.show(">");
    await picker.accept(2);
    expect(picker.isOpen).toBe(true);
  });

  test("keys: arrows wrap, Ctrl+P moves down in provider mode, Escape closes, Tab is captured", () => {
    const { picker } = createPicker();
    picker.registerProvider({
      prefix: "",
      title: "Files",
      placeholder: "",
      provideItems: () => [item("a"), item("b"), item("c")],
      accept: () => {},
    });
    picker.show("");
    picker.handleKey(key("up"));
    expect(picker.state.activeIndex).toBe(2);
    picker.handleKey(key("down"));
    expect(picker.state.activeIndex).toBe(0);
    picker.handleKey(key("p", { ctrl: true }));
    expect(picker.state.activeIndex).toBe(1);
    picker.handleKey(key("n", { ctrl: true }));
    expect(picker.state.activeIndex).toBe(2);
    picker.handleKey(key("pageup"));
    expect(picker.state.activeIndex).toBe(0);
    picker.handleKey(key("pagedown"));
    expect(picker.state.activeIndex).toBe(2);
    expect(picker.handleKey(key("tab"))).toBe(true);
    expect(picker.handleKey(key("a"))).toBe(false);
    expect(picker.handleKey(key("escape"))).toBe(true);
    expect(picker.isOpen).toBe(false);
    expect(picker.handleKey(key("down"))).toBe(false);
  });
});

describe("QuickPickService.pick", () => {
  const themes = [
    item("mocha", "Catppuccin Mocha"),
    item("night", "Tokyo Night", { current: true }),
    item("hc", "High Contrast"),
  ];

  test("resolves with the accepted item and previews the active one", async () => {
    const { picker } = createPicker();
    const previews: string[] = [];
    const result = picker.pick({ items: themes, title: "Color Theme", onActive: (i) => previews.push(i.id) });
    // The current value is selected first.
    expect(picker.state).toMatchObject({ mode: "pick", title: "Color Theme", activeIndex: 1 });
    picker.handleKey(key("down"));
    picker.handleKey(key("p", { ctrl: true }));
    expect(previews).toEqual(["night", "hc", "night"]);
    picker.handleKey(key("enter"));
    expect((await result)?.id).toBe("night");
  });

  test("resolves undefined on Escape and when replaced by another picker", async () => {
    const { picker } = createPicker();
    const first = picker.pick({ items: themes });
    picker.handleKey(key("escape"));
    expect(await first).toBeUndefined();
    const second = picker.pick({ items: themes });
    picker.show(">");
    expect(await second).toBeUndefined();
  });

  test("typing filters the list with highlights", async () => {
    const { picker } = createPicker();
    const result = picker.pick({ items: themes, activeId: "hc" });
    expect(picker.state.activeIndex).toBe(2);
    picker.setValue("tok");
    expect(picker.state.items.map((i) => i.id)).toEqual(["night"]);
    expect(picker.state.items[0]?.highlights).toEqual([0, 1, 2]);
    expect(picker.state.activeIndex).toBe(0);
    picker.close();
    expect(await result).toBeUndefined();
  });
});

describe("filterQuickPickItems", () => {
  test("an empty query keeps the order", () => {
    const items = [item("b"), item("a")];
    expect(filterQuickPickItems(items, "  ").map((i) => i.id)).toEqual(["b", "a"]);
  });

  test("ranks by score, highlights label matches, and drops groups", () => {
    const items = [
      item("1", "View: Toggle Sidebar", { group: "recently used" }),
      item("2", "View: Toggle Zen Mode"),
      item("3", "Preferences: Color Theme"),
    ];
    const result = filterQuickPickItems(items, "zen");
    expect(result.map((i) => i.id)).toEqual(["2"]);
    expect(result[0]?.highlights).toEqual([13, 14, 15]);
    const sidebar = filterQuickPickItems(items, "tog sid");
    expect(sidebar[0]?.id).toBe("1");
    expect(sidebar[0]?.group).toBeUndefined();
  });

  test("can match on descriptions, ranked below label matches", () => {
    const items = [item("a", "alpha", { description: "theme" }), item("b", "theme picker")];
    expect(filterQuickPickItems(items, "theme").map((i) => i.id)).toEqual(["b"]);
    const withDescriptions = filterQuickPickItems(items, "theme", { matchOnDescription: true });
    expect(withDescriptions.map((i) => i.id)).toEqual(["b", "a"]);
    expect(withDescriptions[1]?.descriptionHighlights).toEqual([0, 1, 2, 3, 4]);
  });
});
