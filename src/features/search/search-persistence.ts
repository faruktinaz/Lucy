/**
 * The Search view's restore state, stored in the workspace state's `search.query` slice.
 *
 * The slice is a single string capped at `STATE_LIMITS.searchQueryLength` characters, but the
 * view restores more than the pattern: the toggles, the include and exclude globs and the
 * recent queries. They are encoded as a small versioned JSON object that always fits the cap
 * (recent queries are dropped first, then the globs, then the pattern is shortened), so the
 * state store never has to clip it into invalid JSON. Anything that does not decode, such as
 * a plain pattern written by an older build, is read as just the pattern.
 */
import type { CaseMode } from "@/adapters/search";
import { STATE_LIMITS } from "@/core/workspace";
import { EMPTY_QUERY, type SearchQueryInput, type SearchSnapshot } from "./model";

const VERSION = 1;
const CASE_MODES: readonly CaseMode[] = ["smart", "sensitive", "insensitive"];

interface EncodedSnapshot {
  v: number;
  p: string;
  r?: 1;
  c?: CaseMode;
  w?: 1;
  i?: string;
  x?: string;
  h?: string[];
}

function toJson(query: SearchQueryInput, recent: readonly string[]): string {
  const encoded: EncodedSnapshot = { v: VERSION, p: query.pattern };
  if (query.isRegex) encoded.r = 1;
  if (query.caseMode !== EMPTY_QUERY.caseMode) encoded.c = query.caseMode;
  if (query.wholeWord) encoded.w = 1;
  if (query.include) encoded.i = query.include;
  if (query.exclude) encoded.x = query.exclude;
  if (recent.length > 0) encoded.h = [...recent];
  return JSON.stringify(encoded);
}

/** Encodes a snapshot into at most `maxLength` characters. An empty snapshot encodes to "". */
export function encodeSearchSnapshot(
  snapshot: SearchSnapshot,
  maxLength: number = STATE_LIMITS.searchQueryLength,
): string {
  const query = snapshot.query;
  const isEmpty =
    query.pattern === "" &&
    !query.isRegex &&
    !query.wholeWord &&
    query.caseMode === EMPTY_QUERY.caseMode &&
    query.include === "" &&
    query.exclude === "" &&
    snapshot.recentQueries.length === 0;
  if (isEmpty) return "";
  const recent = [...snapshot.recentQueries];
  let text = toJson(query, recent);
  while (text.length > maxLength && recent.length > 0) {
    recent.pop();
    text = toJson(query, recent);
  }
  if (text.length <= maxLength) return text;
  // Last resort: drop the globs and keep the longest prefix of the pattern that fits. JSON
  // escaping makes the encoded length non-linear in the pattern length, hence the search.
  const base: SearchQueryInput = { ...query, include: "", exclude: "" };
  let low = 0;
  let high = base.pattern.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (toJson({ ...base, pattern: base.pattern.slice(0, middle) }, []).length <= maxLength) low = middle;
    else high = middle - 1;
  }
  text = toJson({ ...base, pattern: base.pattern.slice(0, low) }, []);
  return text.length <= maxLength ? text : "";
}

/** Decodes what `encodeSearchSnapshot` wrote; a plain string becomes the pattern. */
export function decodeSearchSnapshot(text: string): SearchSnapshot {
  if (text === "") return { query: EMPTY_QUERY, recentQueries: [] };
  let parsed: unknown;
  try {
    parsed = text.startsWith("{") ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (parsed === null || typeof parsed !== "object" || (parsed as { v?: unknown }).v !== VERSION) {
    return { query: { ...EMPTY_QUERY, pattern: text }, recentQueries: [] };
  }
  const value = parsed as Record<string, unknown>;
  const string = (key: string): string => (typeof value[key] === "string" ? (value[key] as string) : "");
  const caseMode = CASE_MODES.find((mode) => mode === value.c) ?? EMPTY_QUERY.caseMode;
  return {
    query: {
      pattern: string("p"),
      isRegex: value.r === 1,
      caseMode,
      wholeWord: value.w === 1,
      include: string("i"),
      exclude: string("x"),
    },
    recentQueries: Array.isArray(value.h)
      ? value.h.filter((query): query is string => typeof query === "string" && query !== "")
      : [],
  };
}
