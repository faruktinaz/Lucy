import { fuzzyMatch, rankByFuzzyMatch } from "../src/features/palette/fuzzy-match";

// A realistic upper bound: a palette with a few hundred commands and task titles.
const CANDIDATES = Array.from({ length: 400 }, (_, index) => {
  const verbs = ["Open", "Close", "Toggle", "Reload", "Archive", "Export", "Assign", "Rename"];
  const nouns = ["task", "note", "sidebar", "theme", "filter", "folder", "release", "label"];
  return `${verbs[index % verbs.length]} ${nouns[(index * 7) % nouns.length]} ${index}`;
});

const QUERIES = ["t", "tg", "tgs", "open task", "arch fold", "xyz"];

function measure(label: string, iterations: number, work: () => void): void {
  work(); // Warm up the JIT before timing.
  const started = performance.now();
  for (let i = 0; i < iterations; i++) work();
  const perIteration = (performance.now() - started) / iterations;
  console.log(`${label.padEnd(28)} ${(perIteration * 1000).toFixed(1).padStart(8)} µs`);
}

for (const query of QUERIES) {
  measure(`rank "${query}"`, 500, () => {
    rankByFuzzyMatch(CANDIDATES, query, (candidate) => candidate);
  });
}

measure("single match, long title", 50_000, () => {
  fuzzyMatch("rls nts", "Draft the release notes for the next minor version");
});
