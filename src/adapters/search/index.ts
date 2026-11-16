/** Search services: file index for Quick Open, fuzzy matching, project-wide content search. */
export { type BuiltinLimits, DEFAULT_BUILTIN_LIMITS } from "./builtin-engine";
export { canonicalGlobs, hasUppercase } from "./compile-query";
export { ContentSearch, type ContentSearchOptions } from "./content-search";
export {
  FileIndex,
  type FileIndexOptions,
  type FileIndexResult,
  type FileIndexStrategy,
} from "./file-index";
export {
  type FuzzyFilterOptions,
  type FuzzyMatch,
  type FuzzyResult,
  fuzzyFilter,
  fuzzyFilterBy,
  fuzzyMatch,
  fuzzyMatchPrepared,
  type PreparedFuzzyQuery,
  prepareFuzzyQuery,
} from "./fuzzy";
export { MAX_PREVIEW_LENGTH } from "./line-preview";
export { parseQuickOpenQuery, type QuickOpenQuery } from "./quick-open-query";
export {
  type CaseMode,
  type ContentSearchQuery,
  DEFAULT_SEARCH_LIMITS,
  InvalidPatternError,
  isInvalidPatternError,
  type MatchRange,
  type SearchCallbacks,
  type SearchEngineName,
  type SearchLimitHit,
  type SearchLimits,
  type SearchMatch,
  type SearchSummary,
} from "./search-types";
