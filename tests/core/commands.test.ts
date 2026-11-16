import { describe, expect, test } from "bun:test";
import {
  type CommandExecutionEvent,
  type CommandFailureEvent,
  CommandRegistry,
} from "@/core/commands/registry";
import { isLucyError } from "@/core/errors";
import { ContextKeys } from "@/core/keybindings/context-keys";

const noop = () => {};

describe("register", () => {
  test("validates the area.verbNoun id convention", () => {
    const registry = new CommandRegistry();
    for (const id of ["view.toggleSidebar", "git.commit", "ai.newSession", "theme.select", "a.b.c"]) {
      expect(() => registry.register({ id, title: "x", category: "x", run: noop })).not.toThrow();
    }
    for (const id of ["toggleSidebar", "View.toggle", "view.", "view.toggle-sidebar", "view toggle", ".x"]) {
      expect(() => registry.register({ id, title: "x", category: "x", run: noop })).toThrow();
    }
  });

  test("rejects duplicates and invalid expressions", () => {
    const registry = new CommandRegistry();
    registry.register({ id: "file.open", title: "Open", category: "File", run: noop });
    let error: unknown;
    try {
      registry.register({ id: "file.open", title: "Open", category: "File", run: noop });
    } catch (e) {
      error = e;
    }
    expect(isLucyError(error, "ALREADY_EXISTS")).toBe(true);
    expect(() =>
      registry.register({ id: "file.close", title: "Close", category: "File", run: noop, when: "a &&" }),
    ).toThrow();
  });

  test("disposing unregisters, and only its own registration", () => {
    const registry = new CommandRegistry();
    const events: string[] = [];
    registry.onDidChangeCommands((e) => events.push(`${e.registered ? "+" : "-"}${e.id}`));
    const first = registry.register({ id: "file.open", title: "Open", category: "File", run: noop });
    first.dispose();
    expect(registry.has("file.open")).toBe(false);
    const second = registry.register({ id: "file.open", title: "Open 2", category: "File", run: noop });
    first.dispose();
    expect(registry.get("file.open")?.title).toBe("Open 2");
    second.dispose();
    expect(events).toEqual(["+file.open", "-file.open", "+file.open", "-file.open"]);
  });
});

describe("execute", () => {
  test("runs sync and async commands with args and returns their result", async () => {
    const registry = new CommandRegistry();
    registry.register({
      id: "math.double",
      title: "Double",
      category: "Math",
      run: (n) => (n as number) * 2,
    });
    registry.register({
      id: "math.later",
      title: "Later",
      category: "Math",
      run: async (n) => {
        await Bun.sleep(1);
        return `got ${n as string}`;
      },
    });
    expect(await registry.execute("math.double", 21)).toBe(42);
    expect(await registry.execute("math.later", "x")).toBe("got x");
  });

  test("an unknown id rejects with NOT_FOUND and is reported", async () => {
    const registry = new CommandRegistry();
    const failures: CommandFailureEvent[] = [];
    registry.onDidFail((e) => failures.push(e));
    const error = await registry.execute("no.such").catch((e: unknown) => e);
    expect(isLucyError(error, "NOT_FOUND")).toBe(true);
    expect(failures.map((f) => f.id)).toEqual(["no.such"]);
  });

  test("failures propagate to the caller AND are emitted", async () => {
    const registry = new CommandRegistry();
    const boom = new Error("boom");
    registry.register({
      id: "git.push",
      title: "Push",
      category: "Git",
      run: async () => {
        throw boom;
      },
    });
    const failures: CommandFailureEvent[] = [];
    const executions: CommandExecutionEvent[] = [];
    registry.onDidFail((e) => failures.push(e));
    registry.onDidExecute((e) => executions.push(e));
    await expect(registry.execute("git.push", { force: false })).rejects.toBe(boom);
    expect(failures).toEqual([{ id: "git.push", args: { force: false }, error: boom }]);
    expect(executions[0]?.ok).toBe(false);
    expect(executions[0]?.error).toBe(boom);
  });

  test("a synchronous throw is a rejection, not an exception from execute", async () => {
    const registry = new CommandRegistry();
    registry.register({
      id: "x.fail",
      title: "Fail",
      category: "X",
      run: () => {
        throw new Error("sync");
      },
    });
    const promise = registry.execute("x.fail");
    await expect(promise).rejects.toThrow("sync");
  });

  test("disabled commands are rejected with UNSUPPORTED", async () => {
    const context = new ContextKeys();
    const registry = new CommandRegistry({ context });
    let ran = 0;
    registry.register({
      id: "git.commit",
      title: "Commit",
      category: "Git",
      enabled: "git.hasStaged",
      run: () => ran++,
    });
    registry.register({
      id: "git.fetch",
      title: "Fetch",
      category: "Git",
      enabled: () => false,
      run: () => ran++,
    });
    expect(isLucyError(await registry.execute("git.commit").catch((e: unknown) => e), "UNSUPPORTED")).toBe(
      true,
    );
    expect(isLucyError(await registry.execute("git.fetch").catch((e: unknown) => e), "UNSUPPORTED")).toBe(
      true,
    );
    context.set("git.hasStaged", true);
    await registry.execute("git.commit");
    expect(ran).toBe(1);
    expect(registry.canExecute("git.commit")).toBe(true);
    expect(registry.canExecute("git.fetch")).toBe(false);
    expect(registry.canExecute("no.such")).toBe(false);
  });

  test("emits an execution event with timing", async () => {
    const registry = new CommandRegistry();
    registry.register({ id: "view.toggleSidebar", title: "Toggle Sidebar", category: "View", run: noop });
    const events: CommandExecutionEvent[] = [];
    registry.onDidExecute((e) => events.push(e));
    await registry.execute("view.toggleSidebar");
    expect(events).toHaveLength(1);
    expect(events[0]?.ok).toBe(true);
    expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("list", () => {
  test("filters hidden commands and false when clauses, reports enabled state", () => {
    const registry = new CommandRegistry();
    registry.register({
      id: "file.quickOpen",
      title: "Go to File",
      category: "File",
      keywords: ["open"],
      run: noop,
    });
    registry.register({ id: "internal.debug", title: "Debug", category: "Dev", hidden: true, run: noop });
    registry.register({ id: "git.commit", title: "Commit", category: "Git", when: "git.isRepo", run: noop });
    registry.register({
      id: "git.push",
      title: "Push",
      category: "Git",
      enabled: "git.hasRemote",
      run: noop,
    });

    expect(registry.list().map((c) => c.id)).toEqual(["file.quickOpen", "git.push"]);
    expect(registry.list().find((c) => c.id === "git.push")?.enabled).toBe(false);
    expect(registry.list({ context: { "git.isRepo": true } }).map((c) => c.id)).toEqual([
      "file.quickOpen",
      "git.commit",
      "git.push",
    ]);
    const all = registry.list({ includeHidden: true });
    expect(all.map((c) => [c.id, c.hidden])).toEqual([
      ["file.quickOpen", false],
      ["internal.debug", true],
      ["git.commit", true],
      ["git.push", false],
    ]);
    expect(all[0]?.keywords).toEqual(["open"]);
  });
});

describe("most recently used", () => {
  test("tracks successful, visible executions newest first, capped", async () => {
    const registry = new CommandRegistry({ recentLimit: 3 });
    for (const id of ["a.one", "a.two", "a.three", "a.four"]) {
      registry.register({ id, title: id, category: "A", run: noop });
    }
    registry.register({ id: "a.hidden", title: "h", category: "A", hidden: true, run: noop });
    registry.register({
      id: "a.fails",
      title: "f",
      category: "A",
      run: () => {
        throw new Error("x");
      },
    });
    for (const id of ["a.one", "a.two", "a.one", "a.hidden", "a.three", "a.four"]) await registry.execute(id);
    await registry.execute("a.fails").catch(noop);
    expect(registry.getRecent()).toEqual(["a.four", "a.three", "a.one"]);
  });

  test("setRecent restores a persisted list, dropping junk and duplicates", () => {
    const registry = new CommandRegistry({ recentLimit: 3 });
    registry.setRecent(["a.one", "a.one", "not valid", "a.two", "a.three", "a.four"]);
    expect(registry.getRecent()).toEqual(["a.one", "a.two", "a.three"]);
    const copy = registry.getRecent();
    copy.pop();
    expect(registry.getRecent()).toHaveLength(3);
  });
});
