import { describe, expect, test } from "bun:test";
import { normalizeWorkspaceState, STATE_LIMITS } from "@/core/workspace";
import { EMPTY_QUERY } from "@/features/search/model";
import { decodeSearchSnapshot, encodeSearchSnapshot } from "@/features/search/search-persistence";

describe("search restore state", () => {
  test("round-trips the query, the toggles, the globs and the recent queries", () => {
    const snapshot = {
      query: {
        pattern: "TaskStore",
        isRegex: true,
        caseMode: "sensitive" as const,
        wholeWord: true,
        include: "src/**",
        exclude: "*.test.ts",
      },
      recentQueries: ["TaskStore", "çalışma", "route\\("],
    };
    const encoded = encodeSearchSnapshot(snapshot);
    expect(decodeSearchSnapshot(encoded)).toEqual(snapshot);
  });

  test("an empty snapshot stores nothing", () => {
    expect(encodeSearchSnapshot({ query: EMPTY_QUERY, recentQueries: [] })).toBe("");
    expect(decodeSearchSnapshot("")).toEqual({ query: EMPTY_QUERY, recentQueries: [] });
  });

  test("always fits the workspace-state limit: recent queries go first, then the pattern shrinks", () => {
    const recent = Array.from({ length: 20 }, (_, i) => `query number ${i} ${"x".repeat(60)}`);
    const encoded = encodeSearchSnapshot({
      query: { ...EMPTY_QUERY, pattern: "needle" },
      recentQueries: recent,
    });
    expect(encoded.length).toBeLessThanOrEqual(STATE_LIMITS.searchQueryLength);
    const decoded = decodeSearchSnapshot(encoded);
    expect(decoded.query.pattern).toBe("needle");
    expect(decoded.recentQueries.length).toBeGreaterThan(0);
    expect(decoded.recentQueries.length).toBeLessThan(20);

    const huge = encodeSearchSnapshot({
      query: { ...EMPTY_QUERY, pattern: '"\\'.repeat(900) },
      recentQueries: [],
    });
    expect(huge.length).toBeLessThanOrEqual(STATE_LIMITS.searchQueryLength);
    expect(decodeSearchSnapshot(huge).query.pattern.startsWith('"\\')).toBe(true);
  });

  test("survives the workspace-state validator unchanged", () => {
    const encoded = encodeSearchSnapshot({
      query: { ...EMPTY_QUERY, pattern: "TODO" },
      recentQueries: ["TODO"],
    });
    const state = normalizeWorkspaceState({ search: { query: encoded } });
    expect(state.search.query).toBe(encoded);
  });

  test("a plain or damaged value is read as the pattern only", () => {
    expect(decodeSearchSnapshot("TODO").query).toEqual({ ...EMPTY_QUERY, pattern: "TODO" });
    expect(decodeSearchSnapshot("{not json").query.pattern).toBe("{not json");
    const odd = decodeSearchSnapshot(JSON.stringify({ v: 1, p: 7, c: "loud", h: [1, "ok", ""] }));
    expect(odd).toEqual({ query: EMPTY_QUERY, recentQueries: ["ok"] });
  });
});
