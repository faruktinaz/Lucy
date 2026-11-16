/**
 * Provider behind the Quick Open picker (Ctrl+P): fuzzy file search over `FileIndex`.
 *
 * The first query may have to build the index (`store.loading`); later queries reuse it and
 * are cancellable. An empty query lists recently opened files first, then the rest of the
 * index in its order. Highlights are split between the label (file name) and the description
 * (folder), because the fuzzy positions refer to the full path.
 */
import type { FileIndex, FileIndexStrategy, MatchRange } from "@/adapters/search";
import { fuzzyFilter, parseQuickOpenQuery } from "@/adapters/search";
import { errorMessage, isLucyError } from "@/core/errors";
import { Store } from "@/core/store";
import { sanitizeForDisplay } from "@/core/text";
import { type FileIcon, type IconTier, iconForFile } from "@/themes";
import { positionsToRanges, sanitizeWithRanges } from "./highlight";

export interface QuickOpenItem {
  /** The workspace-relative path (stable key). */
  readonly path: string;
  /** Display-safe file name. */
  readonly label: string;
  /** Display-safe folder, "" for files at the root. */
  readonly description: string;
  readonly labelHighlights: readonly MatchRange[];
  readonly descriptionHighlights: readonly MatchRange[];
  readonly icon: FileIcon;
  /** Recently opened. */
  readonly recent: boolean;
  readonly score: number;
}

export interface QuickOpenResult {
  /** The fuzzy part of the input (without the `:line:column` suffix). */
  readonly query: string;
  readonly line?: number;
  readonly column?: number;
  readonly items: readonly QuickOpenItem[];
  /** Files in the index. */
  readonly total: number;
  readonly truncated: boolean;
}

export interface QuickOpenState {
  /** The index is being built. */
  readonly loading: boolean;
  /** The index stopped at a limit: some files cannot be found. */
  readonly truncated: boolean;
  /** e.g. "Only the first 200,000 files are searchable." */
  readonly truncatedNotice: string | null;
  readonly strategy: FileIndexStrategy | null;
  readonly fileCount: number;
  /** The index could not be built. */
  readonly error: string | null;
}

/** The part of `FileIndex` the model uses (structural, so tests can pass a double). */
export type QuickOpenIndex = Pick<FileIndex, "list" | "peek" | "invalidate">;

export interface QuickOpenModelOptions {
  readonly fileIndex: QuickOpenIndex;
  readonly iconTier: IconTier;
  /** Recently opened files, most recent first. */
  readonly recentFiles?: readonly string[];
  /** Items returned at most. Default 200. */
  readonly limit?: number;
}

const numberFormat = new Intl.NumberFormat("en-US");

export class QuickOpenModel {
  readonly store = new Store<QuickOpenState>({
    loading: false,
    truncated: false,
    truncatedNotice: null,
    strategy: null,
    fileCount: 0,
    error: null,
  });
  private readonly fileIndex: QuickOpenIndex;
  private readonly limit: number;
  private tier: IconTier;
  private recent: readonly string[];

  constructor(options: QuickOpenModelOptions) {
    this.fileIndex = options.fileIndex;
    this.tier = options.iconTier;
    this.recent = options.recentFiles ?? [];
    this.limit = Math.max(1, options.limit ?? 200);
  }

  setRecentFiles(paths: readonly string[]): void {
    this.recent = paths;
  }

  setIconTier(tier: IconTier): void {
    this.tier = tier;
  }

  /** Drops the cached index (call on file-watcher batches). */
  invalidate(): void {
    this.fileIndex.invalidate();
  }

  /** Resolves the items for `text`; rejects with a `CANCELLED` LucyError when `signal` aborts. */
  async query(text: string, signal?: AbortSignal): Promise<QuickOpenResult> {
    const parsed = parseQuickOpenQuery(text);
    const files = await this.loadIndex(signal);
    const result = { line: parsed.line, column: parsed.column, total: files.length };
    const truncated = this.store.get().truncated;
    if (parsed.query === "") {
      // ":42" means "go to line" in the current editor: no file list.
      if (parsed.line !== undefined) return { query: "", ...result, items: [], truncated };
      return { query: "", ...result, items: this.recentFirst(files), truncated };
    }
    const recent = new Set(this.recent);
    const matches = await fuzzyFilter(parsed.query, files, { limit: this.limit, signal });
    const items = matches.map((match) =>
      this.item(match.item, match.positions, recent.has(match.item), match.score),
    );
    return { query: parsed.query, ...result, items, truncated };
  }

  private async loadIndex(signal?: AbortSignal): Promise<readonly string[]> {
    const cached = this.fileIndex.peek();
    if (cached) return cached.files;
    this.store.update({ loading: true, error: null });
    try {
      const listing = await this.fileIndex.list(signal);
      this.store.set({
        loading: false,
        truncated: listing.truncated,
        truncatedNotice: listing.truncated
          ? `Only the first ${numberFormat.format(listing.files.length)} files are searchable.`
          : null,
        strategy: listing.strategy,
        fileCount: listing.files.length,
        error: null,
      });
      return listing.files;
    } catch (error) {
      const cancelled = isLucyError(error, "CANCELLED");
      this.store.update({
        loading: false,
        error: cancelled ? null : sanitizeForDisplay(errorMessage(error)),
      });
      throw error;
    }
  }

  private recentFirst(files: readonly string[]): QuickOpenItem[] {
    const known = new Set(files);
    const recent = this.recent.filter((path) => known.has(path));
    const recentSet = new Set(recent);
    const out: QuickOpenItem[] = [];
    for (const path of recent) {
      if (out.length >= this.limit) return out;
      out.push(this.item(path, [], true, 0));
    }
    for (const path of files) {
      if (out.length >= this.limit) break;
      if (!recentSet.has(path)) out.push(this.item(path, [], false, 0));
    }
    return out;
  }

  private item(path: string, positions: readonly number[], recent: boolean, score: number): QuickOpenItem {
    const slash = path.lastIndexOf("/");
    const nameStart = slash + 1;
    const name = path.slice(nameStart);
    const folder = slash === -1 ? "" : path.slice(0, slash);
    // Positions refer to the full path: before the last "/" they belong to the folder, after it
    // to the name; a matched "/" itself is drawn in neither.
    const label = sanitizeWithRanges(name, positionsToRanges(positions, nameStart, name.length));
    const description = sanitizeWithRanges(folder, positionsToRanges(positions, 0, folder.length));
    return {
      path,
      label: label.text,
      description: description.text,
      labelHighlights: label.ranges,
      descriptionHighlights: description.ranges,
      icon: iconForFile(name, "file", this.tier),
      recent,
      score,
    };
  }
}
