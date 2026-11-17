/**
 * Registry of the non-Tree-sitter highlighters. They are served through the same client
 * interface as the grammars (see `LucyTreeSitterClient`), so `<code>`, `<markdown>` fences and
 * the diff view color these filetypes too.
 */
import type { HighlightRange } from "../types";
import { tokenizeConf } from "./conf-tokenizer";
import { tokenizeDiff } from "./diff-tokenizer";
import { tokenizeDotenv } from "./dotenv-tokenizer";
import { tokenizeGitCommit, tokenizeGitRebase } from "./git-tokenizers";
import { tokenizeIgnore } from "./ignore-tokenizer";
import { tokenizeJson } from "./json-tokenizer";
import { tokenizeLog } from "./log-tokenizer";
import { tokenizeMarkup } from "./markup-tokenizer";
import { createSpecTokenizer, keywordsOf, type LanguageKeywords, type LanguageSpec } from "./spec-tokenizer";
import { C_FAMILY_SPECS } from "./specs/c-family";
import { DATA_AND_CONFIG_SPECS } from "./specs/data-and-config";
import { SCRIPTING_SPECS } from "./specs/scripting";
import { tokenizeCsv, tokenizeTsv } from "./table-tokenizer";
import { tokenizeText } from "./text-tokenizer";

export interface FallbackTokenizer {
  readonly filetype: string;
  /** Other filetype names that resolve here, including Markdown fence info strings. */
  readonly aliases: readonly string[];
  tokenize(content: string): HighlightRange[];
  /** The word lists a spec-driven tokenizer colors (for completion); absent for the others. */
  readonly keywords?: LanguageKeywords;
}

/** The conservative highlighter for files nobody recognizes. Internal name, never a fence name. */
export const FALLBACK_TEXT_FILETYPE = "fallback-text";

export const LANGUAGE_SPECS: readonly LanguageSpec[] = [
  ...C_FAMILY_SPECS,
  ...SCRIPTING_SPECS,
  ...DATA_AND_CONFIG_SPECS,
];

function fromSpec(spec: LanguageSpec): FallbackTokenizer {
  const tokenizer = createSpecTokenizer(spec);
  return {
    filetype: spec.filetype,
    aliases: spec.aliases ?? [],
    tokenize: (content) => tokenizer.tokenize(content),
    keywords: keywordsOf(spec),
  };
}

export const FALLBACK_TOKENIZERS: readonly FallbackTokenizer[] = Object.freeze([
  { filetype: "json", aliases: ["jsonc", "json5", "jsonl", "ndjson"], tokenize: tokenizeJson },
  {
    filetype: "ini",
    aliases: ["dosini", "cfg", "conf", "properties", "editorconfig", "gitconfig", "systemd"],
    tokenize: tokenizeConf,
  },
  { filetype: "gitignore", aliases: ["ignore", "gitattributes"], tokenize: tokenizeIgnore },
  { filetype: "dotenv", aliases: ["env"], tokenize: tokenizeDotenv },
  { filetype: "csv", aliases: [], tokenize: tokenizeCsv },
  { filetype: "tsv", aliases: ["tab"], tokenize: tokenizeTsv },
  { filetype: "log", aliases: [], tokenize: tokenizeLog },
  { filetype: "diff", aliases: ["patch", "udiff"], tokenize: tokenizeDiff },
  { filetype: "gitcommit", aliases: ["git-commit"], tokenize: tokenizeGitCommit },
  { filetype: "gitrebase", aliases: ["git-rebase", "git-rebase-todo"], tokenize: tokenizeGitRebase },
  {
    filetype: "xml",
    aliases: ["svg", "plist", "xsd", "xsl", "xslt", "rss", "atom", "xaml", "wsdl"],
    tokenize: tokenizeMarkup,
  },
  { filetype: FALLBACK_TEXT_FILETYPE, aliases: [], tokenize: tokenizeText },
  ...LANGUAGE_SPECS.map(fromSpec),
]);

let byName: Map<string, FallbackTokenizer> | undefined;

export function fallbackTokenizerFor(filetype: string): FallbackTokenizer | undefined {
  if (!byName) {
    const index = new Map<string, FallbackTokenizer>();
    for (const entry of FALLBACK_TOKENIZERS) {
      for (const name of [entry.filetype, ...entry.aliases]) if (!index.has(name)) index.set(name, entry);
    }
    byName = index;
  }
  return byName.get(filetype);
}

export type { LanguageKeywords, LanguageSpec } from "./spec-tokenizer";
