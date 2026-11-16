import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_FIXTURE_DIR, fixtureSourcePath, listFixtureFiles } from "../../src/app/demo/fixture";
import { GENERATED_ASSETS } from "../../src/app/demo/generate-assets";
import {
  CONFLICT_BRANCH_COMMIT,
  FEATURE_COMMITS,
  MAIN_COMMITS,
  STAGED_NEW_FILE,
  UNTRACKED_FILES,
} from "../../src/app/demo/scenario";

const files = listFixtureFiles();
const read = (path: string) => readFileSync(join(DEFAULT_FIXTURE_DIR, fixtureSourcePath(path)));

describe("demo fixture", () => {
  test("has a believable size", () => {
    expect(files.length).toBeGreaterThanOrEqual(35);
    expect(files.length).toBeLessThanOrEqual(55);
  });

  test("contains the required kinds of files", () => {
    for (const path of ["README.md", "package.json", "tsconfig.json", ".env.example", ".gitignore"]) {
      expect(files).toContain(path);
    }
    const has = (pattern: RegExp) => files.some((path) => pattern.test(path));
    expect(has(/^src\/.+\.ts$/)).toBe(true);
    expect(has(/^src\/.+\.tsx$/)).toBe(true);
    expect(has(/^scripts\/[^/]+\.sh$/)).toBe(true);
    expect(has(/^tools\/[^/]+\.go$/)).toBe(true);
    expect(has(/^analysis\/[^/]+\.py$/)).toBe(true);
    expect(has(/^config\/[^/]+\.yaml$/)).toBe(true);
    expect(has(/^config\/[^/]+\.toml$/)).toBe(true);
    expect(has(/^docs\/[^/]+\.md$/)).toBe(true);
    expect(has(/\.json$/)).toBe(true);
  });

  test("never stores a real .git or .gitignore inside the outer repository", () => {
    expect(existsSync(join(DEFAULT_FIXTURE_DIR, ".git"))).toBe(false);
    expect(existsSync(join(DEFAULT_FIXTURE_DIR, ".gitignore"))).toBe(false);
    expect(existsSync(join(DEFAULT_FIXTURE_DIR, "_gitignore"))).toBe(true);
  });

  test("README exercises Markdown rendering", () => {
    const readme = read("README.md").toString("utf8");
    expect(readme).toMatch(/^# /m);
    expect(readme).toMatch(/^## /m);
    expect(readme).toMatch(/^- /m);
    expect(readme).toMatch(/^1\. /m);
    expect(readme).toMatch(/^\| .* \|$/m);
    expect(readme).toMatch(/^> /m);
    expect(readme).toMatch(/\[[^\]]+\]\([^)]+\)/);
    const fences = new Set([...readme.matchAll(/^```(\w+)/gm)].map((match) => match[1]));
    expect(fences.size).toBeGreaterThanOrEqual(4);
  });

  test("covers the edge cases the UI must handle", () => {
    const turkish = "docs/çalışma-notları.md";
    expect(readdirSync(join(DEFAULT_FIXTURE_DIR, "docs")).map((name) => name.normalize("NFC"))).toContain(
      "çalışma-notları.md",
    );
    expect(read(turkish).toString("utf8")).toContain("Çalışma notları");

    const deepest = Math.max(...files.map((path) => path.split("/").length));
    expect(deepest).toBeGreaterThanOrEqual(8);

    const longest = Math.max(
      ...files.map((path) =>
        Math.max(
          ...read(path)
            .toString("utf8")
            .split("\n")
            .map((line) => line.length),
        ),
      ),
    );
    expect(longest).toBeGreaterThan(2000);

    expect(
      files.some((path) => statSync(join(DEFAULT_FIXTURE_DIR, fixtureSourcePath(path))).size === 0),
    ).toBe(true);
  });

  test("binary assets match their generator byte for byte", () => {
    for (const [path, create] of Object.entries(GENERATED_ASSETS)) {
      expect(read(path).equals(create())).toBe(true);
    }
    const png = read("assets/logo.png");
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(32);
    expect(png.readUInt32BE(20)).toBe(32);
  });

  test("the environment example holds only obvious placeholders", () => {
    const env = read(".env.example").toString("utf8");
    for (const line of env.split("\n")) {
      if (line.startsWith("#") || !line.includes("=")) continue;
      const key = line.slice(0, line.indexOf("="));
      const value = line.slice(line.indexOf("=") + 1);
      // Anything credential-like must read as a placeholder in screenshots, never as a leaked key.
      if (/TOKEN|SECRET|KEY|PASSWORD/.test(key)) expect(value).toStartWith("replace-me");
      expect(value).not.toMatch(/^(sk-|ghp_|gho_|xox[abp]-|AKIA|AIza)/);
      expect(value).not.toMatch(/[A-Za-z0-9+/]{32,}/);
    }
  });

  test("every fixture file has a place in the scenario", () => {
    const claimed = new Set<string>([STAGED_NEW_FILE, ...UNTRACKED_FILES]);
    for (const step of [...MAIN_COMMITS, ...FEATURE_COMMITS, CONFLICT_BRANCH_COMMIT]) {
      for (const file of step.files) claimed.add(typeof file === "string" ? file : file.path);
    }
    expect(files.filter((path) => !claimed.has(path.normalize("NFC")))).toEqual([]);
    expect([...claimed].filter((path) => !files.includes(path))).toEqual([]);
  });
});
