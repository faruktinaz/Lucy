/**
 * Markdown source/preview toggle.
 *
 * Only `markdown` qualifies. MDX is detected as its own language and stays source-only: its
 * JSX blocks would render as raw text in a Markdown preview, which reads like a broken file.
 */
import type { LanguageId } from "@/adapters/syntax/languages";
import type { ViewerDocument } from "./document-types";
import type { ViewerState } from "./viewer-state";

export function isMarkdownLanguage(id: LanguageId | string): boolean {
  return id === "markdown";
}

/** True when the document can switch between source and a rendered preview. */
export function canPreviewMarkdown(document: ViewerDocument | null | undefined): boolean {
  return document?.kind === "text" && document.isMarkdown;
}

/** Flips the preview flag; a no-op (same reference) for documents that cannot be previewed. */
export function toggleMarkdownPreview(state: ViewerState, document: ViewerDocument | null): ViewerState {
  if (!canPreviewMarkdown(document)) return state;
  return { ...state, markdownPreview: !state.markdownPreview };
}

/** Whether the view should render the preview right now (the flag alone is not enough). */
export function showsMarkdownPreview(state: ViewerState, document: ViewerDocument | null): boolean {
  return state.markdownPreview && canPreviewMarkdown(document);
}
