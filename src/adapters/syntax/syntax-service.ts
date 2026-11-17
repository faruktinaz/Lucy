/**
 * The syntax service: one private Tree-sitter client per app, created lazily, with Lucy's
 * offline grammars and fallback tokenizers.
 *
 * Two consumers:
 * - Views built on OpenTUI's `<code>`/`<markdown>` pass `service.client` as `treeSitterClient`
 *   and `service.filetypeFor(path)` as `filetype`.
 * - Views that draw their own rows (the diff view) call `highlight()` and `tokenizeLines()`.
 *
 * Offsets: the worker reports web-tree-sitter `startIndex`/`endIndex`, which are UTF-16 code
 * units for JavaScript strings (verified with Turkish text and emoji, see tests). They are used
 * as-is after validation; no byte conversion is needed.
 */
import { isAbsolute } from "node:path";
import type { FiletypeParserOptions, SimpleHighlight, TreeSitterClient } from "@opentui/core";
import { isLucyError, LucyError } from "@/core/errors";
import type { Disposable } from "@/core/events";
import { log } from "@/core/log";
import { COMPOSITE_FILETYPES } from "./embedded";
import { fallbackTokenizerFor } from "./fallback";
import { BUNDLED_FILETYPES, resolveGrammars } from "./grammars";
import { detectLanguage, type LanguageInfo, languageById } from "./languages";
import { LucyTreeSitterClient } from "./lucy-tree-sitter-client";
import { tokenizeLines } from "./tokenize-lines";
import type { HighlightRange, LineToken } from "./types";

const logger = log.child("syntax");

export const DEFAULT_MAX_HIGHLIGHT_BYTES = 1024 * 1024;
export const DEFAULT_MAX_HIGHLIGHT_LINES = 20_000;

export interface SyntaxServiceOptions {
  /** Absolute directory for the client's Tree-sitter cache (Lucy's cache dir; a temp dir in tests). */
  readonly dataPath: string;
  /** Content above this many UTF-8 bytes is not highlighted. Default 1 MiB. */
  readonly maxBytes?: number;
  /** Content with more lines than this is not highlighted. Default 20,000. */
  readonly maxLines?: number;
}

export interface HighlightOptions {
  readonly signal?: AbortSignal;
}

function cancelled(): LucyError {
  return new LucyError("CANCELLED", "Highlighting was cancelled");
}

/** Resolves with `promise`, or rejects with CANCELLED as soon as `signal` aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelled());
      return;
    }
    const onAbort = (): void => reject(cancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Converts worker highlights to ranges. Drops malformed entries and clamps to the content (the
 * worker parses Markdown that ends in a fence with an extra newline). Also drops a Markdown
 * `markup.raw.block` that contains an injected language: OpenTUI suppresses exactly that group
 * so the fenced code shows its own colors, and the diff view must match.
 */
function toRanges(highlights: readonly SimpleHighlight[], length: number): HighlightRange[] {
  const ranges: HighlightRange[] = [];
  for (const [rawStart, rawEnd, group, meta] of highlights) {
    if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) continue;
    const start = Math.max(0, rawStart);
    const end = Math.min(length, rawEnd);
    if (start >= end) continue;
    if (group === "markup.raw.block" && meta?.containsInjection && !meta.isInjection) continue;
    ranges.push({ start, end, group });
  }
  return ranges;
}

function countLinesUpTo(content: string, limit: number): number {
  let lines = 1;
  for (let i = content.indexOf("\n"); i !== -1; i = content.indexOf("\n", i + 1)) {
    lines++;
    if (lines > limit) break;
  }
  return lines;
}

export class SyntaxService implements Disposable {
  readonly #dataPath: string;
  readonly #maxBytes: number;
  readonly #maxLines: number;
  #client: LucyTreeSitterClient | undefined;
  #parsers: readonly FiletypeParserOptions[] | undefined;
  #highlightable: Set<string> | undefined;
  #destroying: Promise<void> | undefined;
  #disposed = false;

  constructor(options: SyntaxServiceOptions) {
    if (!isAbsolute(options.dataPath)) {
      throw new LucyError("INVALID_ARGUMENT", `Syntax data path must be absolute: ${options.dataPath}`);
    }
    this.#dataPath = options.dataPath;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_HIGHLIGHT_BYTES;
    this.#maxLines = options.maxLines ?? DEFAULT_MAX_HIGHLIGHT_LINES;
  }

  /**
   * The private client, created (and its worker started) on first access. Pass it as the
   * `treeSitterClient` prop of `<code>` and `<markdown>`.
   */
  get client(): TreeSitterClient {
    return this.#ensureClient();
  }

  /** Whether the client (and its worker) has been created yet. */
  get isStarted(): boolean {
    return this.#client !== undefined;
  }

  /** The extra grammars registered on the client, with their absolute local paths. */
  registeredParsers(): readonly FiletypeParserOptions[] {
    return this.#resolveParsers();
  }

  languageFor(path: string, firstLine?: string): LanguageInfo {
    return detectLanguage(path, firstLine);
  }

  /** The `filetype` prop for `<code>`, or `undefined` for plain text. */
  filetypeFor(path: string, firstLine?: string): string | undefined {
    const filetype = detectLanguage(path, firstLine).filetype;
    return filetype !== undefined && this.#isHighlightable(filetype) ? filetype : undefined;
  }

  /** True when `content` is above the size guard and will not be highlighted. */
  exceedsSizeLimit(content: string): boolean {
    // Cheap checks first: a UTF-16 length above the byte limit is always above it in UTF-8.
    if (content.length > this.#maxBytes) return true;
    if (Buffer.byteLength(content, "utf8") > this.#maxBytes) return true;
    return countLinesUpTo(content, this.#maxLines) > this.#maxLines;
  }

  /**
   * Highlight ranges for `content`, in UTF-16 offsets of the whole document. `languageId` is a
   * `LanguageId` (or a highlighter filetype such as `bash`). Unknown languages, plain text, and
   * content above the size guard resolve to `[]`. Rejects with `CANCELLED` when `signal` aborts.
   */
  async highlight(
    content: string,
    languageId: string,
    options: HighlightOptions = {},
  ): Promise<HighlightRange[]> {
    const { signal } = options;
    if (signal?.aborted) throw cancelled();
    if (this.#disposed) return [];
    const filetype = this.#filetypeForLanguage(languageId);
    if (filetype === undefined || content.length === 0 || this.exceedsSizeLimit(content)) return [];

    // Composite files (HTML, Vue, Svelte, PHP) need the grammar for their markup: client path.
    const fallback = COMPOSITE_FILETYPES.has(filetype) ? undefined : fallbackTokenizerFor(filetype);
    if (fallback) {
      const ranges = fallback.tokenize(content);
      if (signal?.aborted) throw cancelled();
      return ranges;
    }

    let result: Awaited<ReturnType<TreeSitterClient["highlightOnce"]>>;
    try {
      result = await abortable(this.#ensureClient().highlightOnce(content, filetype), signal);
    } catch (error) {
      if (isLucyError(error, "CANCELLED")) throw error;
      // Highlighting is cosmetic: a dead worker or a dispose mid-request means plain text.
      if (!this.#disposed) logger.warn("Highlighting failed", { filetype, error });
      return [];
    }
    if (result.error) {
      logger.warn("Highlighting failed", { filetype, error: result.error });
      return [];
    }
    if (result.warning) logger.debug("Highlighting skipped", { filetype, warning: result.warning });
    return toRanges(result.highlights ?? [], content.length);
  }

  /** Per-line tokens for custom-rendered rows. See `tokenizeLines` in `./tokenize-lines`. */
  tokenizeLines(content: string, ranges: readonly HighlightRange[]): LineToken[][] {
    return tokenizeLines(content, ranges);
  }

  /** Starts tearing down the worker. Use `disposeAsync()` to wait for it (tests, shutdown). */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const client = this.#client;
    this.#client = undefined;
    if (client) {
      this.#destroying = client.destroy().catch((error: unknown) => {
        logger.warn("Tree-sitter client did not shut down cleanly", { error });
      });
    }
  }

  async disposeAsync(): Promise<void> {
    this.dispose();
    await this.#destroying;
  }

  #filetypeForLanguage(languageId: string): string | undefined {
    const language = languageById(languageId);
    const filetype = language ? language.filetype : languageId;
    return filetype !== undefined && this.#isHighlightable(filetype) ? filetype : undefined;
  }

  #isHighlightable(filetype: string): boolean {
    if (!this.#highlightable) {
      const names = new Set<string>(BUNDLED_FILETYPES);
      for (const parser of this.#resolveParsers()) {
        names.add(parser.filetype);
        for (const alias of parser.aliases ?? []) names.add(alias);
      }
      this.#highlightable = names;
    }
    return (
      this.#highlightable.has(filetype) ||
      COMPOSITE_FILETYPES.has(filetype) ||
      fallbackTokenizerFor(filetype) !== undefined
    );
  }

  #resolveParsers(): readonly FiletypeParserOptions[] {
    if (!this.#parsers) {
      const { parsers, missing } = resolveGrammars();
      for (const entry of missing) logger.error("Grammar unavailable; rendering as plain text", entry);
      this.#parsers = parsers;
    }
    return this.#parsers;
  }

  #ensureClient(): LucyTreeSitterClient {
    if (this.#disposed) throw new LucyError("INTERNAL", "SyntaxService is disposed");
    if (this.#client) return this.#client;
    const client = new LucyTreeSitterClient({
      dataPath: this.#dataPath,
      parsers: this.#resolveParsers(),
      isTooLarge: (content) => this.exceedsSizeLimit(content),
    });
    client.on("worker:log", (type, message) => {
      if (type === "log") logger.debug(message);
      else logger.warn(`Tree-sitter worker: ${message}`);
    });
    client.on("error", (error) => logger.warn(`Tree-sitter: ${error}`));
    this.#client = client;
    return client;
  }
}
