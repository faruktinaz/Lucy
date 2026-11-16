/** UI-independent models for project search and Quick Open. */
export { formatCount, pluralize, positionsToRanges, sanitizeWithRanges } from "./highlight";
export {
  type QuickOpenIndex,
  type QuickOpenItem,
  QuickOpenModel,
  type QuickOpenModelOptions,
  type QuickOpenResult,
  type QuickOpenState,
} from "./quick-open-model";
export { type FileGroup, fileKey, matchKey, type RowRef, SearchResultSet } from "./search-results";
export {
  EMPTY_QUERY,
  parseGlobList,
  RIPGREP_HINT,
  type SearchBackend,
  type SearchError,
  type SearchFileRow,
  type SearchMatchRow,
  type SearchOpenIntent,
  type SearchQueryInput,
  type SearchRow,
  type SearchSnapshot,
  type SearchStatus,
  SearchViewModel,
  type SearchViewModelOptions,
  type SearchViewState,
} from "./search-view-model";
