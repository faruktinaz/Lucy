import { describe, expect, test } from "bun:test";
import {
  clampLine,
  clampViewerState,
  createViewerState,
  maxScrollTop,
  moveActiveLine,
  pageSize,
  scrollBy,
  scrollHorizontally,
  scrollToReveal,
  type ViewerState,
} from "@/features/editor/model";

const at = (activeLine: number, scrollTop = 0): ViewerState => ({
  ...createViewerState(),
  activeLine,
  scrollTop,
});
const metrics = { lineCount: 100, viewportHeight: 10 };

describe("clamping", () => {
  test("clampLine and maxScrollTop", () => {
    expect(clampLine(-5, 10)).toBe(0);
    expect(clampLine(15, 10)).toBe(9);
    expect(clampLine(3.7, 10)).toBe(3);
    expect(clampLine(Number.NaN, 10)).toBe(0);
    expect(clampLine(4, 0)).toBe(0);
    expect(maxScrollTop(100, 10)).toBe(90);
    expect(maxScrollTop(5, 10)).toBe(0);
    expect(pageSize(10)).toBe(9);
    expect(pageSize(1)).toBe(1);
  });

  test("clampViewerState keeps valid state by reference", () => {
    const state = at(5, 2);
    expect(clampViewerState(state, 100, 10)).toBe(state);
    expect(clampViewerState(at(150, 140), 100, 10)).toMatchObject({ activeLine: 99, scrollTop: 90 });
    expect(clampViewerState(at(150, 140), 100)).toMatchObject({ activeLine: 99, scrollTop: 99 });
  });
});

describe("scrollToReveal", () => {
  test("no scroll while the line is inside the margin band", () => {
    expect(scrollToReveal(0, 5, metrics)).toBe(0);
    expect(scrollToReveal(10, 12, metrics)).toBe(10);
  });

  test("scrolls minimally to keep the margin (2 lines)", () => {
    expect(scrollToReveal(0, 8, metrics)).toBe(1); // line 8 must be <= top + 7
    expect(scrollToReveal(20, 21, metrics)).toBe(19);
    expect(scrollToReveal(50, 0, metrics)).toBe(0);
    expect(scrollToReveal(0, 99, metrics)).toBe(90);
  });

  test("center alignment for jumps off screen", () => {
    expect(scrollToReveal(0, 50, metrics, "center")).toBe(46);
    expect(scrollToReveal(45, 50, metrics, "center")).toBe(45); // already visible: stays
    expect(scrollToReveal(0, 98, metrics, "center")).toBe(90);
  });

  test("margin shrinks for tiny viewports", () => {
    expect(scrollToReveal(0, 3, { lineCount: 100, viewportHeight: 3 })).toBe(2);
    expect(scrollToReveal(0, 7, { lineCount: 100, viewportHeight: 1 })).toBe(7);
  });
});

describe("moveActiveLine", () => {
  test("by lines, clamped to the document", () => {
    expect(moveActiveLine(at(0), { kind: "lines", delta: 1 }, metrics)).toMatchObject({
      activeLine: 1,
      scrollTop: 0,
    });
    expect(moveActiveLine(at(7), { kind: "lines", delta: 1 }, metrics)).toMatchObject({
      activeLine: 8,
      scrollTop: 1,
    });
    expect(moveActiveLine(at(99, 90), { kind: "lines", delta: 5 }, metrics)).toMatchObject({
      activeLine: 99,
    });
  });

  test("no-op moves return the same reference", () => {
    const top = at(0);
    expect(moveActiveLine(top, { kind: "lines", delta: -1 }, metrics)).toBe(top);
    expect(moveActiveLine(top, { kind: "start" }, metrics)).toBe(top);
    const bottom = at(99, 90);
    expect(moveActiveLine(bottom, { kind: "end" }, metrics)).toBe(bottom);
  });

  test("pages move cursor and viewport together", () => {
    const next = moveActiveLine(at(3, 0), { kind: "pages", delta: 1 }, metrics);
    expect(next).toMatchObject({ activeLine: 12, scrollTop: 9 });
    const back = moveActiveLine(next, { kind: "pages", delta: -1 }, metrics);
    expect(back).toMatchObject({ activeLine: 3, scrollTop: 0 });
    expect(moveActiveLine(at(95, 90), { kind: "pages", delta: 1 }, metrics)).toMatchObject({
      activeLine: 99,
      scrollTop: 90,
    });
    expect(moveActiveLine(at(4, 0), { kind: "pages", delta: -1 }, metrics)).toMatchObject({
      activeLine: 0,
      scrollTop: 0,
    });
  });

  test("home / end", () => {
    expect(moveActiveLine(at(40, 35), { kind: "start" }, metrics)).toMatchObject({
      activeLine: 0,
      scrollTop: 0,
    });
    expect(moveActiveLine(at(4), { kind: "end" }, metrics)).toMatchObject({ activeLine: 99, scrollTop: 90 });
  });

  test("jump to a line centers it", () => {
    expect(moveActiveLine(at(0), { kind: "line", line: 50 }, metrics)).toMatchObject({
      activeLine: 50,
      scrollTop: 46,
    });
    expect(moveActiveLine(at(0), { kind: "line", line: 500 }, metrics)).toMatchObject({
      activeLine: 99,
      scrollTop: 90,
    });
  });

  test("short documents never scroll", () => {
    const short = { lineCount: 3, viewportHeight: 10 };
    expect(moveActiveLine(at(0), { kind: "end" }, short)).toMatchObject({ activeLine: 2, scrollTop: 0 });
    expect(moveActiveLine(at(0), { kind: "pages", delta: 3 }, short)).toMatchObject({
      activeLine: 2,
      scrollTop: 0,
    });
  });
});

describe("scrolling without moving", () => {
  test("scrollBy clamps and keeps the active line", () => {
    expect(scrollBy(at(5), 3, metrics)).toMatchObject({ activeLine: 5, scrollTop: 3 });
    expect(scrollBy(at(5), 500, metrics).scrollTop).toBe(90);
    const top = at(0);
    expect(scrollBy(top, -3, metrics)).toBe(top);
  });

  test("horizontal scroll is ignored while wrapping", () => {
    expect(scrollHorizontally(at(0), 8).scrollLeft).toBe(8);
    expect(scrollHorizontally({ ...at(0), scrollLeft: 2 }, -8).scrollLeft).toBe(0);
    const wrapped = { ...at(0), wrap: true };
    expect(scrollHorizontally(wrapped, 8)).toBe(wrapped);
  });
});
