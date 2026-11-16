import { expect, test } from "bun:test";
import { fuzzyFilter } from "@/adapters/search/fuzzy";

/** Deterministic pseudo-random generator so the benchmark corpus is stable. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function syntheticPaths(count: number): string[] {
  const random = lcg(42);
  const dirs = ["src", "lib", "packages", "apps", "test", "docs", "scripts", "internal", "vendor", "tools"];
  const parts = [
    "core",
    "ui",
    "server",
    "client",
    "utils",
    "models",
    "routes",
    "hooks",
    "store",
    "api",
    "auth",
  ];
  const names = ["index", "button", "userService", "config", "README", "handler", "parser", "types", "main"];
  const exts = [".ts", ".tsx", ".js", ".md", ".json", ".css", ".test.ts"];
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const depth = 1 + Math.floor(random() * 4);
    const segments = [pick(dirs)];
    for (let d = 0; d < depth; d++) segments.push(`${pick(parts)}${random() < 0.3 ? `-${i % 97}` : ""}`);
    segments.push(`${pick(names)}${i}${pick(exts)}`);
    out.push(segments.join("/"));
  }
  return out;
}

test("benchmark: fuzzyFilter over 100k paths (loose upper bound)", async () => {
  const paths = syntheticPaths(100_000);
  const queries = ["btn", "usrsv", "config", "srvidx", "rdme", "hooks/", "parsts"];
  const timings: string[] = [];
  for (const query of queries) {
    const started = performance.now();
    const results = await fuzzyFilter(query, paths, { limit: 100 });
    const elapsed = performance.now() - started;
    timings.push(`${query}=${elapsed.toFixed(0)}ms(${results.length})`);
    expect(elapsed).toBeLessThan(3000);
  }
  console.log(`[fuzzy-bench] 100k paths, limit 100: ${timings.join(" ")}`);
}, 60_000);
