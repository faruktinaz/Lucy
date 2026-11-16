import { expect, test } from "bun:test";
import {
  clampIndex,
  findTypeAhead,
  firstChildIndex,
  moveIndex,
  pageIndex,
  parentIndex,
} from "@/features/explorer/model";

const depths = [0, 1, 2, 2, 1, 0, 0];
const depthAt = (index: number) => depths[index] ?? 0;
const names = ["src", "app", "main.ts", "Makefile", "util.ts", "README.md", "readme.txt"];
const nameAt = (index: number) => names[index] ?? null;

test("index moves clamp to the list and start from the edges when nothing is selected", () => {
  expect(clampIndex(10, 3)).toBe(2);
  expect(clampIndex(0, 0)).toBe(-1);
  expect(moveIndex(-1, 1, 5)).toBe(0);
  expect(moveIndex(-1, -1, 5)).toBe(4);
  expect(moveIndex(4, 1, 5)).toBe(4);
  expect(moveIndex(0, -1, 5)).toBe(0);
  expect(pageIndex(0, 1, 10, 50)).toBe(9);
  expect(pageIndex(30, -1, 10, 50)).toBe(21);
  expect(pageIndex(0, 1, 1, 50)).toBe(1);
});

test("parent and first child follow the depth structure", () => {
  expect(parentIndex(depthAt, 3)).toBe(1);
  expect(parentIndex(depthAt, 4)).toBe(0);
  expect(parentIndex(depthAt, 5)).toBe(-1);
  expect(firstChildIndex(depthAt, 0, depths.length)).toBe(1);
  expect(firstChildIndex(depthAt, 2, depths.length)).toBe(-1);
  expect(firstChildIndex(depthAt, 6, depths.length)).toBe(-1);
});

test("type-ahead matches prefixes after the current row, cycles on repeated letters, and wraps", () => {
  expect(findTypeAhead(nameAt, names.length, -1, "m")).toBe(2);
  expect(findTypeAhead(nameAt, names.length, 2, "m")).toBe(3);
  expect(findTypeAhead(nameAt, names.length, 3, "mm")).toBe(2); // Repeated letter: next "m…", wrapping.
  expect(findTypeAhead(nameAt, names.length, 2, "ma")).toBe(2); // Refining keeps the current row.
  expect(findTypeAhead(nameAt, names.length, 0, "READ")).toBe(5);
  expect(findTypeAhead(nameAt, names.length, 5, "readme.t")).toBe(6);
  expect(findTypeAhead(nameAt, names.length, 0, "zzz")).toBe(-1);
  expect(findTypeAhead(nameAt, 0, -1, "a")).toBe(-1);
});
