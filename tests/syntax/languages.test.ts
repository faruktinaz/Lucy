import { describe, expect, test } from "bun:test";
import {
  BUNDLED_FILETYPES,
  detectLanguage,
  FALLBACK_TOKENIZERS,
  GRAMMARS,
  interpreterFromShebang,
  LANGUAGES,
  languageById,
} from "../../src/adapters/syntax";

describe("detectLanguage", () => {
  const table: [path: string, id: string, displayName: string, filetype: string | undefined][] = [
    ["src/app.ts", "typescript", "TypeScript", "typescript"],
    ["src/types.d.ts", "typescript", "TypeScript", "typescript"],
    ["lib/x.mts", "typescript", "TypeScript", "typescript"],
    ["lib/x.cts", "typescript", "TypeScript", "typescript"],
    ["ui/App.tsx", "tsx", "TypeScript JSX", "typescriptreact"],
    ["index.js", "javascript", "JavaScript", "javascript"],
    ["x.mjs", "javascript", "JavaScript", "javascript"],
    ["x.cjs", "javascript", "JavaScript", "javascript"],
    ["Button.jsx", "jsx", "JavaScript JSX", "javascriptreact"],
    ["package.json", "json", "JSON", "json"],
    ["data/FILE.JSON", "json", "JSON", "json"],
    ["events.jsonl", "json", "JSON", "json"],
    [".babelrc", "json", "JSON", "json"],
    ["composer.lock", "json", "JSON", "json"],
    ["tsconfig.json", "jsonc", "JSON with Comments", "jsonc"],
    ["tsconfig.build.json", "jsonc", "JSON with Comments", "jsonc"],
    ["bun.lock", "jsonc", "JSON with Comments", "jsonc"],
    [".vscode/settings.json", "jsonc", "JSON with Comments", "jsonc"],
    ["a/b/.vscode/launch.json", "jsonc", "JSON with Comments", "jsonc"],
    ["config.jsonc", "jsonc", "JSON with Comments", "jsonc"],
    ["config.json5", "json5", "JSON5", "json5"],
    [".github/workflows/ci.yml", "yaml", "YAML", "yaml"],
    ["docker-compose.yaml", "yaml", "YAML", "yaml"],
    [".clang-format", "yaml", "YAML", "yaml"],
    ["Cargo.toml", "toml", "TOML", "toml"],
    ["Cargo.lock", "toml", "TOML", "toml"],
    ["uv.lock", "toml", "TOML", "toml"],
    ["Pipfile", "toml", "TOML", "toml"],
    ["README.md", "markdown", "Markdown", "markdown"],
    ["notes.markdown", "markdown", "Markdown", "markdown"],
    ["page.mdx", "mdx", "MDX", "markdown"],
    ["main.py", "python", "Python", "python"],
    ["stubs.pyi", "python", "Python", "python"],
    ["SConstruct", "python", "Python", "python"],
    ["BUILD", "starlark", "Starlark", "python"],
    ["BUILD.bazel", "starlark", "Starlark", "python"],
    ["defs.bzl", "starlark", "Starlark", "python"],
    ["main.go", "go", "Go", "go"],
    ["go.mod", "go-module", "Go Module File", undefined],
    ["go.sum", "go-sum", "Go Checksum File", undefined],
    ["install.sh", "shell", "Shell Script", "bash"],
    ["x.bash", "shell", "Shell Script", "bash"],
    ["x.zsh", "shell", "Shell Script", "bash"],
    [".zshrc", "shell", "Shell Script", "bash"],
    ["/home/u/.bashrc", "shell", "Shell Script", "bash"],
    [".bash_profile", "shell", "Shell Script", "bash"],
    [".profile", "shell", "Shell Script", "bash"],
    [".envrc", "shell", "Shell Script", "bash"],
    ["PKGBUILD", "shell", "Shell Script", "bash"],
    [".env", "dotenv", "Dotenv", "bash"],
    [".env.local", "dotenv", "Dotenv", "bash"],
    [".env.example", "dotenv", "Dotenv", "bash"],
    ["main.rs", "rust", "Rust", "rust"],
    ["style.css", "css", "CSS", "css"],
    ["style.scss", "scss", "SCSS", "css"],
    ["style.less", "less", "Less", "css"],
    ["index.html", "html", "HTML", "html"],
    ["page.htm", "html", "HTML", "html"],
    ["feed.xml", "xml", "XML", "html"],
    ["icon.svg", "xml", "XML", "html"],
    ["Dockerfile", "dockerfile", "Dockerfile", undefined],
    ["Dockerfile.dev", "dockerfile", "Dockerfile", undefined],
    ["Containerfile", "dockerfile", "Dockerfile", undefined],
    ["app.dockerfile", "dockerfile", "Dockerfile", undefined],
    ["Makefile", "makefile", "Makefile", undefined],
    ["makefile", "makefile", "Makefile", undefined],
    ["GNUmakefile", "makefile", "Makefile", undefined],
    ["rules.mk", "makefile", "Makefile", undefined],
    ["setup.cfg", "ini", "INI", "ini"],
    ["tox.ini", "ini", "INI", "ini"],
    [".npmrc", "ini", "INI", "ini"],
    ["app.properties", "properties", "Properties", "ini"],
    [".gitconfig", "git-config", "Git Config", "ini"],
    [".gitmodules", "git-config", "Git Config", "ini"],
    ["repo/.git/config", "git-config", "Git Config", "ini"],
    [".editorconfig", "editorconfig", "EditorConfig", "ini"],
    [".gitignore", "ignore", "Ignore", "gitignore"],
    ["sub/.dockerignore", "ignore", "Ignore", "gitignore"],
    [".npmignore", "ignore", "Ignore", "gitignore"],
    [".git/info/exclude", "ignore", "Ignore", "gitignore"],
    [".gitattributes", "git-attributes", "Git Attributes", "gitignore"],
    ["fix.patch", "diff", "Diff", undefined],
    ["notes.txt", "plaintext", "Plain Text", undefined],
    ["LICENSE", "plaintext", "Plain Text", undefined],
    ["archive.unknownext", "plaintext", "Plain Text", undefined],
    [".hidden", "plaintext", "Plain Text", undefined],
    ["trailing.", "plaintext", "Plain Text", undefined],
    ["C:\\work\\src\\app.ts", "typescript", "TypeScript", "typescript"],
  ];

  test.each(table)("%s → %s", (path, id, displayName, filetype) => {
    const language = detectLanguage(path);
    expect(language.id).toBe(id as never);
    expect(language.displayName).toBe(displayName);
    expect(language.filetype).toBe(filetype);
  });

  test("file names are case-sensitive, so a script named `build` is not Starlark", () => {
    expect(detectLanguage("scripts/build").id).toBe("plaintext");
    expect(detectLanguage("scripts/build", "#!/usr/bin/env bash").id).toBe("shell");
  });

  test("shebang detects extension-less scripts", () => {
    const cases: [string, string][] = [
      ["#!/bin/sh", "shell"],
      ["#!/bin/bash -e", "shell"],
      ["#!/usr/bin/env zsh", "shell"],
      ["#!/usr/bin/env python3", "python"],
      ["#!/usr/bin/python3.12 -u", "python"],
      ["#!/usr/bin/env -S python3 -X dev", "python"],
      ["#!/usr/bin/env -u FOO node", "javascript"],
      ["#!/usr/bin/env LANG=C bun", "typescript"],
      ["#!/usr/bin/env -S deno run --allow-read", "typescript"],
      ["#!/usr/bin/env ruby", "plaintext"],
      ["# not a shebang", "plaintext"],
      ["", "plaintext"],
    ];
    for (const [line, id] of cases)
      expect(`${line} → ${detectLanguage("bin/tool", line).id}`).toBe(`${line} → ${id}`);
  });

  test("an extension wins over the shebang", () => {
    expect(detectLanguage("tool.py", "#!/bin/sh").id).toBe("python");
  });

  test("interpreterFromShebang strips paths, env flags and versions", () => {
    expect(interpreterFromShebang("#!/usr/bin/env -S python3.11 -u")).toBe("python");
    expect(interpreterFromShebang("#! /bin/bash")).toBe("bash");
    expect(interpreterFromShebang("#!/usr/bin/env")).toBeUndefined();
    expect(interpreterFromShebang("no shebang")).toBeUndefined();
  });
});

describe("registry", () => {
  test("ids are unique and every language is reachable by id", () => {
    const ids = LANGUAGES.map((language) => language.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const language of LANGUAGES) expect(languageById(language.id)).toBe(language);
    expect(languageById("cobol")).toBeUndefined();
  });

  test("every filetype in the registry has a grammar, a bundled grammar or a fallback tokenizer", () => {
    const known = new Set<string>(BUNDLED_FILETYPES);
    for (const grammar of GRAMMARS) {
      known.add(grammar.filetype);
      for (const alias of grammar.aliases) known.add(alias);
    }
    for (const tokenizer of FALLBACK_TOKENIZERS) {
      known.add(tokenizer.filetype);
      for (const alias of tokenizer.aliases) known.add(alias);
    }
    for (const language of LANGUAGES) {
      if (language.filetype !== undefined)
        expect(`${language.id}:${known.has(language.filetype)}`).toBe(`${language.id}:true`);
    }
  });

  test("every required language is highlighted", () => {
    const required = [
      "typescript",
      "tsx",
      "javascript",
      "jsx",
      "markdown",
      "json",
      "jsonc",
      "yaml",
      "toml",
      "python",
      "go",
      "shell",
    ];
    for (const id of required) expect(languageById(id)?.filetype).toBeString();
  });
});
