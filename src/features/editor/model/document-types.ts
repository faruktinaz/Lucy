/**
 * What a viewer tab shows, as plain data. Every variant carries enough facts for the view to
 * render without further IO, and failures are states with a calm explanation, not exceptions.
 */
import type { ImageFormat, LineEnding } from "@/adapters/filesystem";
import type { LanguageId } from "@/adapters/syntax/languages";

/** Actions a view may offer as buttons; the UI maps them to commands. */
export type DocumentAction =
  /** Hand the file to the OS default application (`open` / `xdg-open`). */
  | "open-externally"
  /** Suspend Lucy and edit in the configured terminal editor. */
  | "edit-in-terminal-editor"
  | "reveal-in-explorer"
  | "retry"
  | "close";

export interface DocumentNotice {
  readonly kind: "outside-workspace" | "highlighting-off";
  /** One quiet sentence for a thin banner. */
  readonly message: string;
}

/** Size and modification time at load: the basis for change detection. */
export interface FileStamp {
  readonly size: number;
  readonly mtimeMs: number;
}

interface DocumentBase {
  /** Workspace-relative POSIX path, as requested (not display-safe; see `breadcrumbSegments`). */
  readonly path: string;
  /** Last path segment, display-safe. */
  readonly name: string;
}

interface LoadedDocumentBase extends DocumentBase {
  readonly stamp: FileStamp;
  readonly size: number;
  /** `12 KB`. */
  readonly sizeLabel: string;
  readonly isSymlink: boolean;
  /** The real file lies outside the workspace (reached through a symlink). */
  readonly outsideWorkspace: boolean;
  readonly notices: readonly DocumentNotice[];
  readonly actions: readonly DocumentAction[];
}

export type HighlightState =
  | { readonly enabled: true; readonly filetype: string }
  | {
      readonly enabled: false;
      /** `plain-text`: no grammar for this language. `size-limit`: over the highlighter's guard. */
      readonly reason: "plain-text" | "size-limit";
    };

export interface TextDocument extends LoadedDocumentBase {
  readonly kind: "text";
  readonly content: string;
  /**
   * Rows the viewer shows: at least 1 (an empty file shows one empty line), and the empty line
   * after a final newline does not count. Valid active lines are `0 .. lineCount - 1`.
   */
  readonly lineCount: number;
  readonly language: { readonly id: LanguageId; readonly displayName: string };
  readonly highlight: HighlightState;
  readonly encoding: "utf-8" | "utf-16le" | "utf-16be";
  readonly bom: boolean;
  /** `UTF-8`, `UTF-8 with BOM`, ... */
  readonly encodingLabel: string;
  readonly lineEnding: LineEnding;
  /** `LF`, `CRLF`, `Mixed`. */
  readonly lineEndingLabel: string;
  readonly finalNewline: boolean;
  /** Source/preview toggle applies (see `markdown.ts`). */
  readonly isMarkdown: boolean;
}

export interface BinaryDocument extends LoadedDocumentBase {
  readonly kind: "binary";
  readonly mime: string;
  /** `PNG image`, `PDF document`, `Binary file`. */
  readonly typeLabel: string;
  readonly image: { readonly format: ImageFormat; readonly width: number; readonly height: number } | null;
  /** `640 × 480` when the dimensions are known. */
  readonly dimensionsLabel: string | null;
}

export interface TooLargeDocument extends LoadedDocumentBase {
  readonly kind: "too-large";
  /** The configured limit in bytes (`editor.max_file_size_mb`). */
  readonly limit: number;
  readonly limitLabel: string;
}

export type DocumentFailureReason =
  /** The file did not exist when the tab was opened. */
  | "not-found"
  /** The file existed (the tab showed it) and is gone now. */
  | "deleted"
  | "permission-denied"
  /** A folder, FIFO, socket or device. */
  | "not-a-regular-file"
  /** The path itself is malformed or escapes the workspace. */
  | "invalid-path"
  | "io-error";

export interface UnavailableDocument extends DocumentBase {
  readonly kind: "unavailable";
  readonly reason: DocumentFailureReason;
  /** Short headline, e.g. "File was deleted". */
  readonly title: string;
  /** One or two calm sentences, display-safe. */
  readonly message: string;
  readonly actions: readonly DocumentAction[];
}

export type ViewerDocument = TextDocument | BinaryDocument | TooLargeDocument | UnavailableDocument;

export type LoadedDocument = TextDocument | BinaryDocument | TooLargeDocument;

export function isLoadedDocument(document: ViewerDocument | null | undefined): document is LoadedDocument {
  return document !== null && document !== undefined && document.kind !== "unavailable";
}
