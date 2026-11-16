/**
 * Registry of the non-Tree-sitter highlighters. They are served through the same client
 * interface as the grammars (see `LucyTreeSitterClient`), so `<code>` and `<markdown>` color
 * these filetypes too.
 */
import type { HighlightRange } from "../types";
import { tokenizeConf } from "./conf-tokenizer";
import { tokenizeIgnore } from "./ignore-tokenizer";
import { tokenizeJson } from "./json-tokenizer";

export interface FallbackTokenizer {
  readonly filetype: string;
  /** Other filetype names that resolve here, including Markdown fence info strings. */
  readonly aliases: readonly string[];
  tokenize(content: string): HighlightRange[];
}

export const FALLBACK_TOKENIZERS: readonly FallbackTokenizer[] = Object.freeze([
  { filetype: "json", aliases: ["jsonc", "json5", "jsonl", "ndjson"], tokenize: tokenizeJson },
  {
    filetype: "ini",
    aliases: ["dosini", "cfg", "properties", "editorconfig", "gitconfig"],
    tokenize: tokenizeConf,
  },
  { filetype: "gitignore", aliases: ["ignore", "gitattributes"], tokenize: tokenizeIgnore },
]);

export function fallbackTokenizerFor(filetype: string): FallbackTokenizer | undefined {
  return FALLBACK_TOKENIZERS.find((entry) => entry.filetype === filetype || entry.aliases.includes(filetype));
}
