/**
 * Turns `readFileForViewer` into what a viewer tab needs: content plus status-bar facts for
 * text, an information card for binary and oversized files, and an explained state for every
 * expected failure. Only cancellation and programming errors throw.
 */
import {
  readFileForViewer,
  type ViewerBinaryFile,
  type ViewerFile,
  type ViewerLimits,
  type ViewerTextFile,
  type ViewerTooLargeFile,
} from "@/adapters/filesystem";
import type { LanguageInfo } from "@/adapters/syntax/languages";
import { errorMessage, isLucyError, LucyError } from "@/core/errors";
import { sanitizeForDisplay } from "@/core/text";
import type {
  BinaryDocument,
  DocumentAction,
  DocumentFailureReason,
  DocumentNotice,
  HighlightState,
  TextDocument,
  TooLargeDocument,
  UnavailableDocument,
  ViewerDocument,
} from "./document-types";
import { describeMime, encodingLabel, formatFileSize, lineEndingLabel } from "./format";
import { isMarkdownLanguage } from "./markdown";

/**
 * The part of `SyntaxService` the loader needs. Structural, so the model never loads the
 * highlighter (and OpenTUI) itself; pass the app's `SyntaxService`.
 */
export interface SyntaxFacts {
  languageFor(path: string, firstLine?: string): LanguageInfo;
  filetypeFor(path: string, firstLine?: string): string | undefined;
  exceedsSizeLimit(content: string): boolean;
}

export interface LoadDocumentOptions {
  readonly syntax: SyntaxFacts;
  /** `editor.max_file_size_mb`. Files above it become a `too-large` card. Default 5. */
  readonly maxFileSizeMb?: number;
  /** Lower-level overrides (tests); `maxFileSizeMb` wins for the text limit when both are set. */
  readonly limits?: Partial<ViewerLimits>;
  /** Set when the tab already showed this file: a missing file then reads as "deleted". */
  readonly wasLoaded?: boolean;
  readonly signal?: AbortSignal;
}

const DEFAULT_MAX_FILE_SIZE_MB = 5;
/** Shebangs and modelines live in the first line; never hand a megabyte-long line to detection. */
const FIRST_LINE_LIMIT = 512;

const OUTSIDE_NOTICE: DocumentNotice = {
  kind: "outside-workspace",
  message: "This file lies outside the workspace; it was reached through a symbolic link.",
};
const SIZE_LIMIT_NOTICE: DocumentNotice = {
  kind: "highlighting-off",
  message: "Syntax highlighting is off for a file this large.",
};

function nameOf(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return sanitizeForDisplay(parts[parts.length - 1] ?? path);
}

function firstLineOf(content: string): string {
  const end = content.indexOf("\n");
  const line = content.slice(0, end === -1 ? FIRST_LINE_LIMIT : Math.min(end, FIRST_LINE_LIMIT));
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function baseFacts(file: ViewerFile) {
  return {
    path: file.path,
    name: nameOf(file.path),
    stamp: { size: file.size, mtimeMs: file.mtimeMs },
    size: file.size,
    sizeLabel: formatFileSize(file.size),
    isSymlink: file.isSymlink,
    outsideWorkspace: file.outsideWorkspace,
  };
}

function textDocument(file: ViewerTextFile, syntax: SyntaxFacts): TextDocument {
  const firstLine = firstLineOf(file.content);
  const language = syntax.languageFor(file.path, firstLine);
  const filetype = syntax.filetypeFor(file.path, firstLine);
  let highlight: HighlightState;
  if (filetype === undefined) highlight = { enabled: false, reason: "plain-text" };
  else if (syntax.exceedsSizeLimit(file.content)) highlight = { enabled: false, reason: "size-limit" };
  else highlight = { enabled: true, filetype };

  const notices: DocumentNotice[] = [];
  if (file.outsideWorkspace) notices.push(OUTSIDE_NOTICE);
  if (!highlight.enabled && highlight.reason === "size-limit") notices.push(SIZE_LIMIT_NOTICE);

  // Editing a file outside the workspace needs the caller's explicit consent (see the editor
  // adapter), so the default action list does not offer it.
  const actions: DocumentAction[] = file.outsideWorkspace
    ? ["reveal-in-explorer"]
    : ["edit-in-terminal-editor", "reveal-in-explorer"];

  return {
    kind: "text",
    ...baseFacts(file),
    content: file.content,
    lineCount: Math.max(1, file.lineCount),
    language: { id: language.id, displayName: language.displayName },
    highlight,
    encoding: file.encoding,
    bom: file.bom,
    encodingLabel: encodingLabel(file.encoding, file.bom),
    lineEnding: file.lineEnding,
    lineEndingLabel: lineEndingLabel(file.lineEnding),
    finalNewline: file.finalNewline,
    isMarkdown: isMarkdownLanguage(language.id),
    notices,
    actions,
  };
}

function binaryDocument(file: ViewerBinaryFile): BinaryDocument {
  const image = file.image
    ? { format: file.image.format, width: file.image.width, height: file.image.height }
    : null;
  return {
    kind: "binary",
    ...baseFacts(file),
    mime: file.mime,
    typeLabel: describeMime(file.mime),
    image,
    dimensionsLabel: image ? `${image.width} × ${image.height}` : null,
    notices: file.outsideWorkspace ? [OUTSIDE_NOTICE] : [],
    actions: ["open-externally", "reveal-in-explorer"],
  };
}

function tooLargeDocument(file: ViewerTooLargeFile): TooLargeDocument {
  return {
    kind: "too-large",
    ...baseFacts(file),
    limit: file.limit,
    limitLabel: formatFileSize(file.limit),
    notices: file.outsideWorkspace ? [OUTSIDE_NOTICE] : [],
    actions: file.outsideWorkspace
      ? ["open-externally", "reveal-in-explorer"]
      : ["edit-in-terminal-editor", "open-externally", "reveal-in-explorer"],
  };
}

const FAILURE_TITLES: Record<DocumentFailureReason, string> = {
  "not-found": "File not found",
  deleted: "File was deleted",
  "permission-denied": "Permission denied",
  "not-a-regular-file": "Cannot show this item",
  "invalid-path": "Invalid path",
  "io-error": "Could not read the file",
};

/** Builds the calm failure state for `path`. Exported for views that fail before loading. */
export function unavailableDocument(
  path: string,
  reason: DocumentFailureReason,
  detail?: string,
): UnavailableDocument {
  const name = nameOf(path);
  const quoted = `"${name}"`;
  let message: string;
  let actions: DocumentAction[];
  switch (reason) {
    case "not-found":
      message = `${quoted} does not exist. It may have been moved or renamed.`;
      actions = ["retry", "close"];
      break;
    case "deleted":
      message = `${quoted} was deleted or moved. The tab reloads it if the file comes back.`;
      actions = ["close"];
      break;
    case "permission-denied":
      message = `Lucy is not allowed to read ${quoted}. Check the file's permissions.`;
      actions = ["retry", "close"];
      break;
    case "not-a-regular-file":
      message = detail ? sanitizeForDisplay(detail) : `${quoted} is not a regular file.`;
      actions = ["reveal-in-explorer", "close"];
      break;
    case "invalid-path":
      message = detail ? sanitizeForDisplay(detail) : `${quoted} is not a valid path in this workspace.`;
      actions = ["close"];
      break;
    default:
      message = detail
        ? `${quoted} could not be read: ${sanitizeForDisplay(detail)}`
        : `${quoted} could not be read.`;
      actions = ["retry", "close"];
  }
  return { kind: "unavailable", path, name, reason, title: FAILURE_TITLES[reason], message, actions };
}

function failureReason(error: LucyError, wasLoaded: boolean): DocumentFailureReason {
  switch (error.code) {
    case "NOT_FOUND":
      return wasLoaded ? "deleted" : "not-found";
    case "PERMISSION_DENIED":
      return "permission-denied";
    case "UNSUPPORTED":
      return "not-a-regular-file";
    case "INVALID_ARGUMENT":
      // `readFileForViewer` reports folders as INVALID_ARGUMENT with a clear message.
      return /is a folder/.test(error.message) ? "not-a-regular-file" : "invalid-path";
    case "OUTSIDE_WORKSPACE":
      return "invalid-path";
    default:
      return "io-error";
  }
}

/** Plain detail text for the failure card: the adapter's message without the "(path)" suffix. */
function failureDetail(error: LucyError): string {
  return error.message.replace(/\s*\([^()]*\)$/, "");
}

export async function loadDocument(
  root: string,
  path: string,
  options: LoadDocumentOptions,
): Promise<ViewerDocument> {
  const maxMb = options.maxFileSizeMb ?? DEFAULT_MAX_FILE_SIZE_MB;
  const useMb = options.maxFileSizeMb !== undefined || options.limits?.maxTextBytes === undefined;
  const limits: Partial<ViewerLimits> = useMb
    ? { ...options.limits, maxTextBytes: Math.max(1, Math.round(maxMb * 1024 * 1024)) }
    : { ...options.limits };
  let file: ViewerFile;
  try {
    file = await readFileForViewer(root, path, { limits, signal: options.signal });
  } catch (error) {
    if (isLucyError(error, "CANCELLED")) throw error;
    if (options.signal?.aborted) throw new LucyError("CANCELLED", "Loading was cancelled", { cause: error });
    if (error instanceof LucyError) {
      return unavailableDocument(
        path,
        failureReason(error, options.wasLoaded ?? false),
        failureDetail(error),
      );
    }
    return unavailableDocument(path, "io-error", errorMessage(error));
  }
  if (options.signal?.aborted) throw new LucyError("CANCELLED", "Loading was cancelled");
  switch (file.kind) {
    case "text":
      return textDocument(file, options.syntax);
    case "binary":
      return binaryDocument(file);
    default:
      return tooLargeDocument(file);
  }
}
