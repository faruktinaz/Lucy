/**
 * Simple `Bun.Glob` matching for the explorer's always-hidden list.
 *
 * Semantics follow `.gitignore` intuition: a pattern without "/" (".DS_Store", "*.pyc")
 * matches an entry's name at any depth; a pattern with "/" ("build/out", "docs/**") matches
 * the workspace-relative path from the root. Note that `Bun.Glob`'s "*" also matches
 * dotfiles.
 */

export interface GlobMatcher {
  readonly isEmpty: boolean;
  matches(relPath: string, name: string): boolean;
}

export function createGlobMatcher(patterns: readonly string[]): GlobMatcher {
  const byName: Bun.Glob[] = [];
  const byPath: Bun.Glob[] = [];
  const literalNames = new Set<string>();
  for (const raw of patterns) {
    let pattern = raw.trim();
    if (pattern.startsWith("./")) pattern = pattern.slice(2);
    if (pattern.startsWith("/")) pattern = pattern.slice(1);
    if (pattern.endsWith("/")) pattern = pattern.slice(0, -1);
    if (pattern === "") continue;
    if (!pattern.includes("/")) {
      if (/^[^*?[\]{}!\\]+$/.test(pattern)) literalNames.add(pattern);
      else byName.push(new Bun.Glob(pattern));
    } else {
      byPath.push(new Bun.Glob(pattern));
    }
  }
  const isEmpty = literalNames.size === 0 && byName.length === 0 && byPath.length === 0;
  return {
    isEmpty,
    matches(relPath, name) {
      if (isEmpty) return false;
      if (literalNames.has(name)) return true;
      for (const glob of byName) if (glob.match(name)) return true;
      for (const glob of byPath) if (glob.match(relPath)) return true;
      return false;
    },
  };
}
