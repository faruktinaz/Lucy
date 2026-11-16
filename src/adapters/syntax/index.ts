/**
 * Public surface of the syntax layer: language detection, offline highlighting and the mapping
 * from highlight groups to theme tokens. Import from `@/adapters/syntax`.
 */
export { FALLBACK_TOKENIZERS, type FallbackTokenizer, fallbackTokenizerFor } from "./fallback";
export {
  assertLocalSource,
  BUNDLED_FILETYPES,
  GRAMMARS,
  type GrammarSpec,
  resolveGrammars,
} from "./grammars";
export {
  detectLanguage,
  interpreterFromShebang,
  LANGUAGES,
  type LanguageId,
  type LanguageInfo,
  languageById,
  PLAIN_TEXT,
} from "./languages";
export { LucyTreeSitterClient, type LucyTreeSitterClientOptions } from "./lucy-tree-sitter-client";
export { configureOpenTuiDataPath } from "./opentui-data-path";
export {
  CORE_SYNTAX_TOKENS,
  type CoreSyntaxTokenName,
  EXTENDED_SYNTAX_TOKENS,
  type ExtendedSyntaxTokenName,
  groupSpecificity,
  STYLE_GROUPS,
  SYNTAX_TOKEN_ATTRIBUTES,
  SYNTAX_TOKEN_FALLBACKS,
  SYNTAX_TOKENS,
  type SyntaxTextAttributes,
  type SyntaxTokenName,
  syntaxGroupToToken,
} from "./style-groups";
export {
  DEFAULT_MAX_HIGHLIGHT_BYTES,
  DEFAULT_MAX_HIGHLIGHT_LINES,
  type HighlightOptions,
  SyntaxService,
  type SyntaxServiceOptions,
} from "./syntax-service";
export { tokenizeLines } from "./tokenize-lines";
export type { HighlightRange, LineToken } from "./types";
