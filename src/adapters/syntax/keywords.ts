/**
 * Per-language word lists, for features such as completion. Covers every language highlighted by
 * a tokenizer spec (SQL, C, Kotlin, Dockerfile, …). Languages on a Tree-sitter grammar keep their
 * keywords in the grammar's query and are not listed here.
 */
import { fallbackTokenizerFor, type LanguageKeywords } from "./fallback";
import { languageById } from "./languages";

/** Keywords, built-in types, constants and functions for a `LanguageId` or a filetype. */
export function languageKeywords(languageOrFiletype: string): LanguageKeywords | undefined {
  const filetype = languageById(languageOrFiletype)?.filetype ?? languageOrFiletype;
  return fallbackTokenizerFor(filetype)?.keywords;
}
