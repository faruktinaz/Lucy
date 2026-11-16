/**
 * Streaming search results grouped by file, flattened for a virtualized list.
 *
 * Files appear in arrival order and never move once shown, so the selection and the scroll
 * position stay put while results stream in. Matches within a file are kept in line order.
 */
import type { SearchMatch } from "@/adapters/search";

export interface FileGroup {
  readonly path: string;
  readonly matches: SearchMatch[];
  collapsed: boolean;
  /** Bumped on every change, for row caching. */
  version: number;
}

/** A flattened row: a file header (`matchIndex === -1`) or one of its matches. */
export interface RowRef {
  readonly group: FileGroup;
  readonly matchIndex: number;
}

/** Row key of a file header. Paths never contain NUL, so the two key kinds cannot collide. */
export function fileKey(path: string): string {
  return path;
}

export function matchKey(path: string, line: number): string {
  return `${path}\0${line}`;
}

export class SearchResultSet {
  private groups: FileGroup[] = [];
  private readonly byPath = new Map<string, FileGroup>();
  private flat: RowRef[] | null = null;
  private keyIndex: Map<string, number> | null = null;
  private matches = 0;

  get matchCount(): number {
    return this.matches;
  }

  get fileCount(): number {
    return this.groups.length;
  }

  get files(): readonly FileGroup[] {
    return this.groups;
  }

  clear(): void {
    this.groups = [];
    this.byPath.clear();
    this.matches = 0;
    this.invalidate();
  }

  add(batch: readonly SearchMatch[]): void {
    if (batch.length === 0) return;
    for (const match of batch) {
      let group = this.byPath.get(match.path);
      if (!group) {
        group = { path: match.path, matches: [], collapsed: false, version: 0 };
        this.byPath.set(match.path, group);
        this.groups.push(group);
      }
      const list = group.matches;
      const last = list[list.length - 1];
      if (!last || last.line < match.line) list.push(match);
      else {
        // Out-of-order arrival (rare): insert in line order, replacing a duplicate line.
        let lo = 0;
        let hi = list.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if ((list[mid] as SearchMatch).line < match.line) lo = mid + 1;
          else hi = mid;
        }
        if (list[lo]?.line === match.line) {
          list[lo] = match;
          this.matches--;
        } else list.splice(lo, 0, match);
      }
      group.version++;
      this.matches++;
    }
    this.invalidate();
  }

  group(path: string): FileGroup | undefined {
    return this.byPath.get(path);
  }

  setCollapsed(path: string, collapsed: boolean): boolean {
    const group = this.byPath.get(path);
    if (!group || group.collapsed === collapsed) return false;
    group.collapsed = collapsed;
    group.version++;
    this.invalidate();
    return true;
  }

  setAllCollapsed(collapsed: boolean): void {
    for (const group of this.groups) {
      if (group.collapsed !== collapsed) {
        group.collapsed = collapsed;
        group.version++;
      }
    }
    this.invalidate();
  }

  rowCount(): number {
    return this.rows().length;
  }

  rowAt(index: number): RowRef | undefined {
    return this.rows()[index];
  }

  keyAt(index: number): string | null {
    const ref = this.rowAt(index);
    if (!ref) return null;
    return ref.matchIndex === -1
      ? fileKey(ref.group.path)
      : matchKey(ref.group.path, (ref.group.matches[ref.matchIndex] as SearchMatch).line);
  }

  indexOfKey(key: string | null): number {
    if (key === null) return -1;
    if (!this.keyIndex) {
      const index = new Map<string, number>();
      const rows = this.rows();
      for (let i = 0; i < rows.length; i++) index.set(this.keyAt(i) as string, i);
      this.keyIndex = index;
    }
    return this.keyIndex.get(key) ?? -1;
  }

  private rows(): RowRef[] {
    if (this.flat) return this.flat;
    const out: RowRef[] = [];
    for (const group of this.groups) {
      out.push({ group, matchIndex: -1 });
      if (group.collapsed) continue;
      for (let i = 0; i < group.matches.length; i++) out.push({ group, matchIndex: i });
    }
    this.flat = out;
    return out;
  }

  private invalidate(): void {
    this.flat = null;
    this.keyIndex = null;
  }
}
