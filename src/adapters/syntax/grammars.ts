/**
 * The Tree-sitter grammars Lucy adds on top of OpenTUI's bundled ones (JavaScript, TypeScript,
 * TSX, Markdown, Zig), and the rule that every grammar source is a local absolute path.
 *
 * Grammar wasm files come from exact-pinned npm packages; highlight queries are Lucy's own
 * (`./queries/*.scm`), because the packaged ones assume first-match-wins semantics and use
 * capture names that OpenTUI does not style. Specifiers are string literals on purpose, so a
 * bundler can see every asset (see README, "Packaging").
 */
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { FiletypeParserOptions } from "@opentui/core";
import { LucyError } from "@/core/errors";

export interface GrammarSpec {
  readonly filetype: string;
  /** Extra names accepted by the client, e.g. Markdown fence info strings that OpenTUI passes through. */
  readonly aliases: readonly string[];
  readonly packageName: string;
  readonly wasmUrl: () => string;
  readonly queryUrl: () => URL;
}

/** Filetypes OpenTUI ships grammars for (`node_modules/@opentui/core/assets`). */
export const BUNDLED_FILETYPES: readonly string[] = Object.freeze([
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact",
  "markdown",
  "markdown_inline",
  "zig",
]);

export const GRAMMARS: readonly GrammarSpec[] = Object.freeze([
  {
    filetype: "python",
    aliases: ["py", "python3", "starlark", "bzl"],
    packageName: "tree-sitter-python",
    wasmUrl: () => import.meta.resolve("tree-sitter-python/tree-sitter-python.wasm"),
    queryUrl: () => new URL("./queries/python.scm", import.meta.url),
  },
  {
    filetype: "go",
    aliases: ["golang"],
    packageName: "tree-sitter-go",
    wasmUrl: () => import.meta.resolve("tree-sitter-go/tree-sitter-go.wasm"),
    queryUrl: () => new URL("./queries/go.scm", import.meta.url),
  },
  {
    filetype: "bash",
    aliases: ["sh", "shell", "shellscript", "zsh", "ksh", "dotenv"],
    packageName: "tree-sitter-bash",
    wasmUrl: () => import.meta.resolve("tree-sitter-bash/tree-sitter-bash.wasm"),
    queryUrl: () => new URL("./queries/bash.scm", import.meta.url),
  },
  {
    filetype: "yaml",
    aliases: ["yml"],
    packageName: "@tree-sitter-grammars/tree-sitter-yaml",
    wasmUrl: () => import.meta.resolve("@tree-sitter-grammars/tree-sitter-yaml/tree-sitter-yaml.wasm"),
    queryUrl: () => new URL("./queries/yaml.scm", import.meta.url),
  },
  {
    filetype: "toml",
    aliases: [],
    packageName: "@tree-sitter-grammars/tree-sitter-toml",
    wasmUrl: () => import.meta.resolve("@tree-sitter-grammars/tree-sitter-toml/tree-sitter-toml.wasm"),
    queryUrl: () => new URL("./queries/toml.scm", import.meta.url),
  },
  {
    filetype: "rust",
    aliases: ["rs"],
    packageName: "tree-sitter-rust",
    wasmUrl: () => import.meta.resolve("tree-sitter-rust/tree-sitter-rust.wasm"),
    queryUrl: () => new URL("./queries/rust.scm", import.meta.url),
  },
  {
    filetype: "css",
    aliases: ["scss", "less", "postcss"],
    packageName: "tree-sitter-css",
    wasmUrl: () => import.meta.resolve("tree-sitter-css/tree-sitter-css.wasm"),
    queryUrl: () => new URL("./queries/css.scm", import.meta.url),
  },
  {
    filetype: "html",
    aliases: ["htm", "xhtml", "xml", "svg"],
    packageName: "tree-sitter-html",
    wasmUrl: () => import.meta.resolve("tree-sitter-html/tree-sitter-html.wasm"),
    queryUrl: () => new URL("./queries/html.scm", import.meta.url),
  },
]);

const REMOTE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Throws unless `source` is an absolute local path. OpenTUI's worker would `fetch()` any
 * http(s) source and cache it on disk; Lucy is offline by design, so that must be impossible.
 */
export function assertLocalSource(source: string): void {
  if (REMOTE.test(source) || !isAbsolute(source)) {
    throw new LucyError("INVALID_ARGUMENT", `Grammar sources must be absolute local paths: ${source}`, {
      details: { source },
    });
  }
}

export function assertLocalParser(parser: FiletypeParserOptions): void {
  assertLocalSource(parser.wasm);
  for (const query of parser.queries.highlights) assertLocalSource(query);
  for (const query of parser.queries.injections ?? []) assertLocalSource(query);
}

function toPath(url: string | URL): string {
  return fileURLToPath(url);
}

export interface ResolvedGrammars {
  readonly parsers: readonly FiletypeParserOptions[];
  /** Grammars whose files could not be found; their languages render as plain text. */
  readonly missing: readonly { readonly filetype: string; readonly reason: string }[];
}

/** Resolves every grammar to absolute file paths. Never touches the network. */
export function resolveGrammars(): ResolvedGrammars {
  const parsers: FiletypeParserOptions[] = [];
  const missing: { filetype: string; reason: string }[] = [];
  for (const grammar of GRAMMARS) {
    try {
      const wasm = toPath(grammar.wasmUrl());
      const query = toPath(grammar.queryUrl());
      for (const file of [wasm, query]) {
        if (!existsSync(file)) throw new Error(`missing file ${file}`);
      }
      const parser: FiletypeParserOptions = {
        filetype: grammar.filetype,
        aliases: [...grammar.aliases],
        wasm,
        queries: { highlights: [query] },
      };
      assertLocalParser(parser);
      parsers.push(parser);
    } catch (error) {
      missing.push({
        filetype: grammar.filetype,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { parsers, missing };
}
