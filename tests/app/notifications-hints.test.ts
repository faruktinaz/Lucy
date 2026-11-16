import { describe, expect, test } from "bun:test";
import { HintService } from "@/app/workbench/hints";
import { MAX_TOASTS, NotificationService } from "@/app/workbench/notifications";
import { createFakeClock } from "./fake-clock";

const toastTitles = (service: NotificationService) => service.toasts.map((t) => t.title);

describe("NotificationService", () => {
  test("shows at most three toasts; older ones stay in the history", () => {
    const service = new NotificationService(createFakeClock());
    for (const title of ["one", "two", "three", "four"]) service.info(title);
    expect(MAX_TOASTS).toBe(3);
    expect(toastTitles(service)).toEqual(["two", "three", "four"]);
    expect(service.store.get().history.map((n) => n.title)).toEqual(["four", "three", "two", "one"]);
  });

  test("toasts with the same key replace each other", () => {
    const service = new NotificationService(createFakeClock());
    service.show({ key: "zen", title: "first" });
    service.info("other");
    service.show({ key: "zen", title: "second" });
    expect(toastTitles(service)).toEqual(["other", "second"]);
  });

  test("auto-dismisses by severity: success, info, warning, error", () => {
    const clock = createFakeClock();
    const service = new NotificationService(clock);
    service.success("saved");
    service.info("fyi");
    service.warn("careful");
    clock.advance(3000);
    expect(toastTitles(service)).toEqual(["fyi", "careful"]);
    clock.advance(1000);
    expect(toastTitles(service)).toEqual(["careful"]);
    service.error("broken");
    clock.advance(2000);
    expect(toastTitles(service)).toEqual(["broken"]);
    clock.advance(6000);
    expect(toastTitles(service)).toEqual([]);
    expect(clock.pending).toBe(0);
  });

  test("toasts with actions wait for the user; an explicit timeout wins", () => {
    const clock = createFakeClock();
    const service = new NotificationService(clock);
    service.show({ title: "with action", actions: [{ label: "Retry", run: () => {} }] });
    service.show({ title: "sticky", timeoutMs: 0 });
    service.show({ title: "quick", timeoutMs: 100 });
    clock.advance(60_000);
    expect(toastTitles(service)).toEqual(["with action", "sticky"]);
  });

  test("dismiss, dismissAll and handles", () => {
    const clock = createFakeClock();
    const service = new NotificationService(clock);
    const handle = service.info("a");
    service.info("b");
    handle.dispose();
    expect(toastTitles(service)).toEqual(["b"]);
    service.dismissAll();
    expect(service.toasts).toHaveLength(0);
    expect(clock.pending).toBe(0);
  });

  test("the history is capped and can be cleared", () => {
    const service = new NotificationService(createFakeClock());
    for (let i = 0; i < 120; i++) service.info(`n${i}`);
    expect(service.store.get().history).toHaveLength(100);
    expect(service.store.get().history[0]?.title).toBe("n119");
    service.clearHistory();
    expect(service.store.get().history).toHaveLength(0);
  });

  test("onDidShow reports every toast", () => {
    const service = new NotificationService(createFakeClock(5));
    const shown: string[] = [];
    service.onDidShow((n) => shown.push(`${n.severity}:${n.title}@${n.createdAt}`));
    service.warn("w", "detail");
    expect(shown).toEqual(["warning:w@5"]);
    expect(service.toasts[0]?.message).toBe("detail");
  });
});

describe("HintService", () => {
  test("precedence: pending sequence, then transient message, then hover", () => {
    const clock = createFakeClock();
    const hints = new HintService(clock);
    const owner = {};
    expect(hints.current).toBeNull();
    hints.setHover(owner, { text: "hover" });
    expect(hints.current?.text).toBe("hover");
    hints.flash({ text: "flash" });
    expect(hints.current?.text).toBe("flash");
    hints.setPending({ text: "Ctrl+K was pressed" });
    expect(hints.current?.text).toBe("Ctrl+K was pressed");
    hints.setPending(null);
    expect(hints.current?.text).toBe("flash");
    clock.advance(2500);
    expect(hints.current?.text).toBe("hover");
  });

  test("a new flash restarts the timer", () => {
    const clock = createFakeClock();
    const hints = new HintService(clock);
    hints.flash({ text: "first" }, 1000);
    clock.advance(900);
    hints.flash({ text: "second" }, 1000);
    clock.advance(900);
    expect(hints.current?.text).toBe("second");
    clock.advance(200);
    expect(hints.current).toBeNull();
  });

  test("only the owner that set a hover hint can clear it", () => {
    const hints = new HintService(createFakeClock());
    const a = {};
    const b = {};
    hints.setHover(a, { text: "a" });
    hints.setHover(b, { text: "b" });
    hints.setHover(a, null);
    expect(hints.current?.text).toBe("b");
    hints.setHover(b, null);
    expect(hints.current).toBeNull();
  });
});
