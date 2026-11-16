import { describe, expect, test } from "bun:test";
import { layoutStatusItems, StatusBarService, type StatusItem } from "@/app/workbench/status-bar";
import { ViewRegistry } from "@/app/workbench/views";
import { isLucyError } from "@/core/errors";

const status = (id: string, alignment: "left" | "right", priority: number, text = id): StatusItem => ({
  id,
  alignment,
  priority,
  text,
});

describe("StatusBarService", () => {
  test("registers, updates and removes items", () => {
    const service = new StatusBarService();
    let notifications = 0;
    service.store.subscribe(() => notifications++);
    const branch = service.register(status("branch", "left", 100, "main"));
    expect(service.items.map((i) => i.text)).toEqual(["main"]);
    branch.update({ text: "feature" });
    expect(service.items[0]?.text).toBe("feature");
    const before = notifications;
    branch.update({ text: "feature" });
    expect(notifications).toBe(before);
    branch.update({ visible: false, tooltip: "x" });
    expect(service.items[0]).toMatchObject({ visible: false, tooltip: "x", alignment: "left" });
    branch.dispose();
    expect(service.items).toHaveLength(0);
    // Updating a disposed handle is harmless.
    branch.update({ text: "gone" });
    expect(service.items).toHaveLength(0);
  });

  test("duplicate ids are rejected", () => {
    const service = new StatusBarService();
    service.register(status("theme", "right", 1));
    let error: unknown;
    try {
      service.register(status("theme", "right", 2));
    } catch (caught) {
      error = caught;
    }
    expect(isLucyError(error, "ALREADY_EXISTS")).toBe(true);
  });
});

describe("layoutStatusItems", () => {
  const measure = (item: StatusItem) => item.text.length;

  test("orders both sides by descending priority from left to right", () => {
    const items = [
      status("b", "left", 50),
      status("a", "left", 100),
      status("y", "right", 10),
      status("z", "right", 40),
    ];
    const { left, right, dropped } = layoutStatusItems(items, 100, measure);
    expect(left.map((i) => i.id)).toEqual(["a", "b"]);
    // The least important right item sits at the far right (and is dropped first).
    expect(right.map((i) => i.id)).toEqual(["z", "y"]);
    expect(dropped).toEqual([]);
  });

  test("drops the lowest priority first until the rest fits", () => {
    const items = [
      status("branch", "left", 100, "feature/x"),
      status("sync", "left", 90, "1 2"),
      status("language", "right", 40, "TypeScript"),
      status("theme", "right", 10, "Catppuccin Mocha"),
    ];
    const roomy = layoutStatusItems(items, 1000, measure);
    expect(roomy.dropped).toEqual([]);
    const tight = layoutStatusItems(items, 25, measure);
    expect(tight.dropped.map((i) => i.id)).toEqual(["theme"]);
    const tighter = layoutStatusItems(items, 12, measure);
    expect(tighter.dropped.map((i) => i.id)).toEqual(["theme", "language"]);
    expect(tighter.left.map((i) => i.id)).toEqual(["branch", "sync"]);
  });

  test("gaps count, hidden and empty items are skipped", () => {
    const items = [
      status("a", "left", 3, "aaaa"),
      status("b", "left", 2, "bbbb"),
      { ...status("c", "left", 9), visible: false },
      status("d", "left", 9, ""),
    ];
    expect(layoutStatusItems(items, 8, measure, 1).dropped.map((i) => i.id)).toEqual(["b"]);
    expect(layoutStatusItems(items, 9, measure, 1).dropped).toEqual([]);
  });
});

describe("ViewRegistry", () => {
  const component = () => null;

  test("orders sidebar views and removes them on dispose", () => {
    const views = new ViewRegistry();
    const scm = views.registerSidebarView({
      id: "scm",
      title: "Source Control",
      icon: "sourceControl",
      order: 30,
      component,
    });
    views.registerSidebarView({ id: "explorer", title: "Explorer", icon: "explorer", order: 10, component });
    views.registerSidebarView({ id: "search", title: "Search", icon: "search", order: 20, component });
    expect(views.state.sidebar.map((v) => v.id)).toEqual(["explorer", "search", "scm"]);
    expect(views.sidebarView("search")?.title).toBe("Search");
    scm.dispose();
    expect(views.state.sidebar.map((v) => v.id)).toEqual(["explorer", "search"]);
  });

  test("duplicate ids throw for every registry", () => {
    const views = new ViewRegistry();
    views.registerSidebarView({ id: "x", title: "X", icon: "file", order: 1, component });
    views.registerAuxiliaryView({ id: "x", title: "X", icon: "ai", order: 1, component });
    views.registerBottomTab({ id: "x", title: "X", order: 1, component });
    views.registerEditorView({ kind: "file", component });
    const attempts = [
      () => views.registerSidebarView({ id: "x", title: "X", icon: "file", order: 2, component }),
      () => views.registerAuxiliaryView({ id: "x", title: "X", icon: "ai", order: 2, component }),
      () => views.registerBottomTab({ id: "x", title: "X", order: 2, component }),
      () => views.registerEditorView({ kind: "file", component }),
    ];
    for (const attempt of attempts) {
      let error: unknown;
      try {
        attempt();
      } catch (caught) {
        error = caught;
      }
      expect(isLucyError(error, "ALREADY_EXISTS")).toBe(true);
    }
  });

  test("auxiliary and bottom lookups fall back to the first view", () => {
    const views = new ViewRegistry();
    expect(views.auxiliaryView(null)).toBeUndefined();
    views.registerAuxiliaryView({ id: "claude", title: "Claude Code", icon: "ai", order: 10, component });
    views.registerBottomTab({ id: "output", title: "Output", order: 20, component });
    views.registerBottomTab({ id: "terminal", title: "Terminal", order: 10, component });
    expect(views.auxiliaryView(null)?.id).toBe("claude");
    expect(views.bottomTab("missing")?.id).toBe("terminal");
    expect(views.bottomTab("output")?.id).toBe("output");
  });

  test("editor views by kind; disposing only removes its own registration", () => {
    const views = new ViewRegistry();
    const first = views.registerEditorView({ kind: "diff", component, icon: "file" });
    expect(views.editorView("diff")?.icon).toBe("file");
    first.dispose();
    expect(views.editorView("diff")).toBeUndefined();
    const second = views.registerEditorView({ kind: "diff", component, icon: "sourceControl" });
    first.dispose();
    expect(views.editorView("diff")?.icon).toBe("sourceControl");
    second.dispose();
    expect(views.state.editors).toEqual({});
  });

  test("hasAuxiliary is a readable that notifies subscribers", () => {
    const views = new ViewRegistry();
    let calls = 0;
    const unsubscribe = views.hasAuxiliary.subscribe(() => calls++);
    expect(views.hasAuxiliary.get()).toBe(false);
    const registration = views.registerAuxiliaryView({
      id: "claude",
      title: "Claude",
      icon: "ai",
      order: 1,
      component,
    });
    expect(views.hasAuxiliary.get()).toBe(true);
    registration.dispose();
    expect(views.hasAuxiliary.get()).toBe(false);
    expect(calls).toBe(2);
    unsubscribe();
  });
});
