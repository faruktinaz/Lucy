/**
 * UI-independent model of project-wide search (Ctrl+Shift+F) on top of `ContentSearch`.
 *
 * - Query edits schedule a debounced run; `run()` searches now. A new run (or `cancel()`)
 *   aborts the previous one, and results of a superseded run are ignored even if they were
 *   already in flight.
 * - Streaming results are grouped by file and flattened for a virtualized list; state updates
 *   are coalesced while streaming. Rows are pulled with `getRows(start, end)`.
 * - Selection is by key, so it survives streaming, collapsing and expanding.
 * - Honest about engines: `engine`/`engineLabel` say what ran, `engineHint` suggests ripgrep
 *   when it is missing.
 */
import type {
  CaseMode,
  ContentSearch,
  ContentSearchQuery,
  MatchRange,
  SearchEngineName,
  SearchMatch,
  SearchSummary,
} from "@/adapters/search";
import { isInvalidPatternError } from "@/adapters/search";
import { errorMessage, isLucyError } from "@/core/errors";
import type { Disposable } from "@/core/events";
import { Store } from "@/core/store";
import { sanitizeForDisplay } from "@/core/text";
import { type FileIcon, type IconTier, iconForFile } from "@/themes";
import { formatCount, pluralize } from "./highlight";
import { type FileGroup, fileKey, matchKey, SearchResultSet } from "./search-results";

export interface SearchQueryInput {
  readonly pattern: string;
  readonly isRegex: boolean;
  readonly caseMode: CaseMode;
  readonly wholeWord: boolean;
  /** Comma-separated globs as typed ("src, *.ts"). */
  readonly include: string;
  readonly exclude: string;
}

export const EMPTY_QUERY: SearchQueryInput = {
  pattern: "",
  isRegex: false,
  caseMode: "smart",
  wholeWord: false,
  include: "",
  exclude: "",
};

export interface SearchOpenIntent {
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

export type SearchStatus = "idle" | "searching" | "done" | "cancelled" | "error";

export interface SearchError {
  readonly kind: "invalid-pattern" | "failed";
  readonly message: string;
}

export interface SearchViewState {
  readonly query: SearchQueryInput;
  readonly status: SearchStatus;
  /** Engine of the last run, or the detected one before the first run. */
  readonly engine: SearchEngineName | null;
  readonly engineLabel: string;
  /** One line suggesting ripgrep when it is not installed, else null. */
  readonly engineHint: string | null;
  readonly matchCount: number;
  readonly fileCount: number;
  /** "12 results in 4 files", "Searching…", "No results", or "". */
  readonly summary: string;
  readonly truncated: boolean;
  readonly truncatedNotice: string | null;
  readonly error: SearchError | null;
  readonly durationMs: number | null;
  readonly rowCount: number;
  /** Bumped whenever rows may have changed. */
  readonly rowsVersion: number;
  readonly selectedKey: string | null;
  readonly selectedIndex: number;
  readonly recentQueries: readonly string[];
}

export interface SearchFileRow {
  readonly type: "file";
  readonly key: string;
  readonly path: string;
  /** Display-safe file name. */
  readonly name: string;
  /** Display-safe folder ("" at the root). */
  readonly directory: string;
  readonly matchCount: number;
  readonly collapsed: boolean;
  readonly icon: FileIcon;
  readonly selected: boolean;
}

export interface SearchMatchRow {
  readonly type: "match";
  readonly key: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  /** Display-safe excerpt; `ranges` index into it. */
  readonly preview: string;
  readonly ranges: readonly MatchRange[];
  readonly clippedStart: boolean;
  readonly clippedEnd: boolean;
  readonly selected: boolean;
}

export type SearchRow = SearchFileRow | SearchMatchRow;

export interface SearchSnapshot {
  readonly query: SearchQueryInput;
  readonly recentQueries: readonly string[];
}

/** The part of `ContentSearch` the model uses (a structural type, so tests can pass a double). */
export type SearchBackend = Pick<ContentSearch, "search" | "resolveEngine" | "ripgrepPath">;

export interface SearchViewModelOptions {
  readonly search: SearchBackend;
  readonly iconTier: IconTier;
  readonly onOpen?: (intent: SearchOpenIntent) => void;
  /** Delay after a query edit before searching. Default 300 ms. */
  readonly debounceMs?: number;
  /** Default 2000 (the engine default). */
  readonly maxResults?: number;
  /** Default 20. */
  readonly maxRecentQueries?: number;
  /** Coalescing window for streamed results. Default 50 ms. */
  readonly flushIntervalMs?: number;
}

const ENGINE_LABELS: Readonly<Record<SearchEngineName, string>> = {
  ripgrep: "ripgrep",
  "git-grep": "git grep",
  builtin: "built-in search",
};

export const RIPGREP_HINT = "Install ripgrep (rg) to make search faster.";

/** Splits "src, *.ts ,, docs/" into globs. */
export function parseGlobList(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function lastSlash(path: string): number {
  return path.lastIndexOf("/");
}

export class SearchViewModel implements Disposable {
  readonly store: Store<SearchViewState>;
  private readonly search: SearchBackend;
  private readonly onOpen?: (intent: SearchOpenIntent) => void;
  private readonly debounceMs: number;
  private readonly maxResults: number;
  private readonly maxRecent: number;
  private readonly flushIntervalMs: number;
  private tier: IconTier;
  private readonly results = new SearchResultSet();

  private query: SearchQueryInput = EMPTY_QUERY;
  private status: SearchStatus = "idle";
  private engine: SearchEngineName | null = null;
  private engineHint: string | null = null;
  private truncated = false;
  private error: SearchError | null = null;
  private durationMs: number | null = null;
  private selectedKey: string | null = null;
  private lastIndex = -1;
  private recent: string[] = [];
  private rowsVersion = 0;

  private runId = 0;
  private controller: AbortController | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly matchViews = new WeakMap<SearchMatch, { selected: boolean; view: SearchMatchRow }>();
  private readonly fileViews = new WeakMap<
    FileGroup,
    { version: number; selected: boolean; tier: IconTier; view: SearchFileRow }
  >();

  constructor(options: SearchViewModelOptions) {
    this.search = options.search;
    this.tier = options.iconTier;
    this.onOpen = options.onOpen;
    this.debounceMs = options.debounceMs ?? 300;
    this.maxResults = options.maxResults ?? 2000;
    this.maxRecent = options.maxRecentQueries ?? 20;
    this.flushIntervalMs = options.flushIntervalMs ?? 50;
    this.store = new Store<SearchViewState>(this.computeState());
  }

  /** Detects the engine up front so the panel can show it (and the ripgrep hint) before a search. */
  async detectEngine(): Promise<SearchEngineName> {
    const engine = await this.search.resolveEngine();
    if (this.engine === null) this.engine = engine;
    this.updateHint();
    this.sync();
    return engine;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimers();
    this.controller?.abort();
  }

  // ---------------------------------------------------------------------------------------
  // Query

  /** Updates the query and schedules a debounced run (an empty pattern clears the results). */
  setQuery(partial: Partial<SearchQueryInput>): void {
    const next = { ...this.query, ...partial };
    if (
      next.pattern === this.query.pattern &&
      next.isRegex === this.query.isRegex &&
      next.caseMode === this.query.caseMode &&
      next.wholeWord === this.query.wholeWord &&
      next.include === this.query.include &&
      next.exclude === this.query.exclude
    ) {
      return;
    }
    this.query = next;
    // Results for the old query are obsolete the moment it changes.
    this.abortCurrent();
    this.scheduleRun();
    this.sync();
  }

  setPattern(pattern: string): void {
    this.setQuery({ pattern });
  }

  toggleRegex(): void {
    this.setQuery({ isRegex: !this.query.isRegex });
  }

  /** Cycles smart → sensitive → insensitive → smart. */
  cycleCaseMode(): void {
    const order: CaseMode[] = ["smart", "sensitive", "insensitive"];
    this.setQuery({ caseMode: order[(order.indexOf(this.query.caseMode) + 1) % order.length] as CaseMode });
  }

  toggleWholeWord(): void {
    this.setQuery({ wholeWord: !this.query.wholeWord });
  }

  /** Searches now (cancels a pending debounce and any running search). */
  async run(): Promise<SearchSummary | null> {
    this.cancelTimers();
    this.abortCurrent();
    const id = ++this.runId;
    const query = this.query;
    this.results.clear();
    this.selectedKey = null;
    this.lastIndex = -1;
    this.truncated = false;
    this.error = null;
    this.durationMs = null;
    if (query.pattern === "") {
      this.status = "idle";
      this.sync();
      return null;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.status = "searching";
    this.sync();
    const request: ContentSearchQuery = {
      pattern: query.pattern,
      isRegex: query.isRegex,
      caseMode: query.caseMode,
      wholeWord: query.wholeWord,
      include: parseGlobList(query.include),
      exclude: parseGlobList(query.exclude),
      maxResults: this.maxResults,
    };
    try {
      const summary = await this.search.search(
        request,
        {
          onMatches: (batch) => {
            if (id !== this.runId) return;
            this.results.add(batch);
            this.scheduleFlush();
          },
        },
        controller.signal,
      );
      if (id !== this.runId) return null;
      this.engine = summary.engine;
      this.truncated = summary.truncated;
      this.durationMs = summary.durationMs;
      this.status = "done";
      this.rememberQuery(query.pattern);
      this.updateHint();
      return summary;
    } catch (error) {
      if (id !== this.runId) return null;
      if (isLucyError(error, "CANCELLED")) {
        this.status = "cancelled";
      } else {
        this.status = "error";
        this.error = isInvalidPatternError(error)
          ? { kind: "invalid-pattern", message: sanitizeForDisplay(error.message) }
          : { kind: "failed", message: sanitizeForDisplay(errorMessage(error)) };
      }
      return null;
    } finally {
      if (id === this.runId) {
        this.controller = null;
        this.cancelFlush();
        this.sync();
      }
    }
  }

  /** Stops the running search, keeping what arrived so far. */
  cancel(): void {
    this.cancelTimers();
    if (this.controller) this.controller.abort();
  }

  /** Clears the pattern and the results. */
  clear(): void {
    this.query = { ...this.query, pattern: "" };
    this.cancelTimers();
    this.abortCurrent();
    this.runId++;
    this.results.clear();
    this.status = "idle";
    this.error = null;
    this.truncated = false;
    this.selectedKey = null;
    this.sync();
  }

  // ---------------------------------------------------------------------------------------
  // Rows and selection

  getRows(start: number, end: number): SearchRow[] {
    const out: SearchRow[] = [];
    const count = this.results.rowCount();
    for (let index = Math.max(0, start); index < Math.min(end, count); index++) {
      const row = this.getRow(index);
      if (row) out.push(row);
    }
    return out;
  }

  getRow(index: number): SearchRow | undefined {
    const ref = this.results.rowAt(index);
    if (!ref) return undefined;
    if (ref.matchIndex === -1) return this.fileRow(ref.group);
    return this.matchRow(ref.group.matches[ref.matchIndex] as SearchMatch);
  }

  select(key: string | null): void {
    this.selectedKey = key;
    this.sync();
  }

  selectIndex(index: number): void {
    const key = this.results.keyAt(index);
    if (key !== null) this.select(key);
  }

  moveUp(): void {
    this.selectIndex(this.step(-1));
  }

  moveDown(): void {
    this.selectIndex(this.step(1));
  }

  pageUp(pageSize: number): void {
    this.selectIndex(this.step(-Math.max(1, pageSize - 1)));
  }

  pageDown(pageSize: number): void {
    this.selectIndex(this.step(Math.max(1, pageSize - 1)));
  }

  home(): void {
    this.selectIndex(0);
  }

  end(): void {
    this.selectIndex(this.results.rowCount() - 1);
  }

  /** On a match: select its file. On an expanded file: collapse it. */
  left(): void {
    const ref = this.results.rowAt(this.currentIndex());
    if (!ref) return;
    if (ref.matchIndex !== -1) this.select(fileKey(ref.group.path));
    else this.setCollapsed(ref.group.path, true);
  }

  /** On a collapsed file: expand it. On an expanded file: select its first match. */
  right(): void {
    const ref = this.results.rowAt(this.currentIndex());
    if (ref?.matchIndex !== -1 || !ref) return;
    if (ref.group.collapsed) this.setCollapsed(ref.group.path, false);
    else {
      const first = ref.group.matches[0];
      if (first) this.select(matchKey(ref.group.path, first.line));
    }
  }

  /** Enter: opens the selected match, or toggles the selected file. */
  enter(): void {
    const ref = this.results.rowAt(this.currentIndex());
    if (!ref) return;
    if (ref.matchIndex === -1) this.toggleFile(ref.group.path);
    else this.openMatch(ref.group.matches[ref.matchIndex] as SearchMatch);
  }

  openMatch(match: SearchMatch): void {
    this.onOpen?.({ path: match.path, line: match.line, column: match.column });
  }

  /** Selects the next match across files (wrapping, expanding collapsed files) and returns it. */
  nextMatch(): SearchMatch | null {
    return this.stepMatch(1);
  }

  previousMatch(): SearchMatch | null {
    return this.stepMatch(-1);
  }

  toggleFile(path: string): void {
    const group = this.results.group(path);
    if (group) this.setCollapsed(path, !group.collapsed);
  }

  collapseAll(): void {
    this.results.setAllCollapsed(true);
    this.reselectHeaderIfHidden();
    this.sync();
  }

  expandAll(): void {
    this.results.setAllCollapsed(false);
    this.sync();
  }

  setIconTier(tier: IconTier): void {
    this.tier = tier;
    this.sync();
  }

  // ---------------------------------------------------------------------------------------
  // Recent queries and restore

  /** Puts a recent query back into the pattern field and searches. */
  useRecentQuery(index: number): void {
    const pattern = this.recent[index];
    if (pattern !== undefined) this.setQuery({ pattern });
  }

  exportSnapshot(): SearchSnapshot {
    return { query: this.query, recentQueries: [...this.recent] };
  }

  /** Restores the query and recents without running a search. */
  restoreSnapshot(snapshot: Partial<SearchSnapshot>): void {
    if (snapshot.query) this.query = { ...EMPTY_QUERY, ...snapshot.query };
    if (snapshot.recentQueries) {
      this.recent = [...new Set(snapshot.recentQueries.filter((query) => query !== ""))].slice(
        0,
        this.maxRecent,
      );
    }
    this.sync();
  }

  // ---------------------------------------------------------------------------------------
  // Internals

  private fileRow(group: FileGroup): SearchFileRow {
    const key = fileKey(group.path);
    const selected = key === this.selectedKey;
    const cached = this.fileViews.get(group);
    if (
      cached &&
      cached.version === group.version &&
      cached.selected === selected &&
      cached.tier === this.tier
    ) {
      return cached.view;
    }
    const slash = lastSlash(group.path);
    const name = group.path.slice(slash + 1);
    const view: SearchFileRow = {
      type: "file",
      key,
      path: group.path,
      name: sanitizeForDisplay(name),
      directory: slash === -1 ? "" : sanitizeForDisplay(group.path.slice(0, slash)),
      matchCount: group.matches.length,
      collapsed: group.collapsed,
      icon: iconForFile(name, "file", this.tier),
      selected,
    };
    this.fileViews.set(group, { version: group.version, selected, tier: this.tier, view });
    return view;
  }

  private matchRow(match: SearchMatch): SearchMatchRow {
    const key = matchKey(match.path, match.line);
    const selected = key === this.selectedKey;
    const cached = this.matchViews.get(match);
    if (cached && cached.selected === selected) return cached.view;
    const view: SearchMatchRow = {
      type: "match",
      key,
      path: match.path,
      line: match.line,
      column: match.column,
      preview: match.lineText,
      ranges: match.ranges,
      clippedStart: match.clippedStart,
      clippedEnd: match.clippedEnd,
      selected,
    };
    this.matchViews.set(match, { selected, view });
    return view;
  }

  private currentIndex(): number {
    const index = this.results.indexOfKey(this.selectedKey);
    if (index !== -1) return index;
    return this.lastIndex >= 0 ? Math.min(this.lastIndex, this.results.rowCount() - 1) : -1;
  }

  private step(delta: number): number {
    const count = this.results.rowCount();
    if (count === 0) return -1;
    const current = this.results.indexOfKey(this.selectedKey);
    if (current === -1) return delta > 0 ? 0 : count - 1;
    return Math.max(0, Math.min(count - 1, current + delta));
  }

  private stepMatch(direction: 1 | -1): SearchMatch | null {
    const files = this.results.files;
    if (this.results.matchCount === 0) return null;
    // Position of the current selection as (file, match); a file header sits before its matches.
    let fileIndex = -1;
    let matchIndex = direction > 0 ? -1 : 0;
    const ref = this.results.rowAt(this.results.indexOfKey(this.selectedKey));
    if (ref) {
      fileIndex = files.indexOf(ref.group);
      matchIndex = ref.matchIndex;
    } else if (direction < 0) {
      fileIndex = files.length;
    }
    for (let guard = 0; guard <= files.length + 1; guard++) {
      const group = files[fileIndex];
      if (group) {
        const next = matchIndex + direction;
        if (next >= 0 && next < group.matches.length) {
          const match = group.matches[next] as SearchMatch;
          if (group.collapsed) this.results.setCollapsed(group.path, false);
          this.select(matchKey(group.path, match.line));
          return match;
        }
      }
      fileIndex = (((fileIndex + direction) % files.length) + files.length) % files.length;
      const target = files[fileIndex] as FileGroup;
      matchIndex = direction > 0 ? -1 : target.matches.length;
    }
    return null;
  }

  private setCollapsed(path: string, collapsed: boolean): void {
    if (!this.results.setCollapsed(path, collapsed)) return;
    if (collapsed) this.reselectHeaderIfHidden();
    this.sync();
  }

  /** A selected match inside a collapsed file moves the selection to the file header. */
  private reselectHeaderIfHidden(): void {
    if (this.selectedKey === null || this.results.indexOfKey(this.selectedKey) !== -1) return;
    const path = this.selectedKey.split("\0")[0] as string;
    if (this.results.group(path)) this.selectedKey = fileKey(path);
  }

  private rememberQuery(pattern: string): void {
    this.recent = [pattern, ...this.recent.filter((query) => query !== pattern)].slice(0, this.maxRecent);
  }

  private updateHint(): void {
    this.engineHint = this.engine !== "ripgrep" && this.search.ripgrepPath() === null ? RIPGREP_HINT : null;
  }

  private scheduleRun(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (!this.disposed) void this.run();
    }, this.debounceMs);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.sync();
    }, this.flushIntervalMs);
  }

  private cancelFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private cancelTimers(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.cancelFlush();
  }

  private abortCurrent(): void {
    if (!this.controller) return;
    this.runId++;
    this.controller.abort();
    this.controller = null;
    if (this.status === "searching") this.status = "cancelled";
  }

  private summaryText(): string {
    const matches = this.results.matchCount;
    if (this.status === "idle" || this.status === "error") return "";
    if (matches === 0) return this.status === "searching" ? "Searching…" : "No results";
    return `${pluralize(matches, "result")} in ${pluralize(this.results.fileCount, "file")}`;
  }

  private computeState(): SearchViewState {
    const selectedIndex = this.results.indexOfKey(this.selectedKey);
    return {
      query: this.query,
      status: this.status,
      engine: this.engine,
      engineLabel: this.engine ? ENGINE_LABELS[this.engine] : "",
      engineHint: this.engineHint,
      matchCount: this.results.matchCount,
      fileCount: this.results.fileCount,
      summary: this.summaryText(),
      truncated: this.truncated,
      truncatedNotice: this.truncated
        ? `Showing the first ${formatCount(this.results.matchCount)} results. Narrow the search to see more.`
        : null,
      error: this.error,
      durationMs: this.durationMs,
      rowCount: this.results.rowCount(),
      rowsVersion: this.rowsVersion,
      selectedKey: this.selectedKey,
      selectedIndex,
      recentQueries: this.recent,
    };
  }

  private sync(): void {
    if (this.disposed) return;
    const index = this.results.indexOfKey(this.selectedKey);
    if (index !== -1) this.lastIndex = index;
    this.rowsVersion++;
    this.store.set(this.computeState());
  }
}
