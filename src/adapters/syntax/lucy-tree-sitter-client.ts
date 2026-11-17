/**
 * Lucy's Tree-sitter client: OpenTUI's `TreeSitterClient` with three additions that every
 * consumer gets for free, including `<code>` and `<markdown>` when this client is passed as their
 * `treeSitterClient` prop:
 *
 * - Lucy's extra grammars are registered after every (re)initialization. The base client starts
 *   a fresh worker after a worker failure and would otherwise forget them.
 * - Only absolute local grammar sources are accepted (no http(s): the worker would fetch them).
 * - `highlightOnce` serves the fallback tokenizers (JSON, SQL, C, dotenv, logs, … see `fallback/`),
 *   composes HTML, Vue, Svelte and PHP files from the HTML grammar plus their embedded blocks, and
 *   applies the size guard before anything reaches the worker.
 */
import { type FiletypeParserOptions, type SimpleHighlight, TreeSitterClient } from "@opentui/core";
import { COMPOSITE_FILETYPES, highlightComposite } from "./embedded";
import { fallbackTokenizerFor } from "./fallback";
import { assertLocalParser } from "./grammars";

export interface LucyTreeSitterClientOptions {
  /** Absolute directory; the worker creates `<dataPath>/tree-sitter/{languages,queries}`. */
  readonly dataPath: string;
  readonly parsers: readonly FiletypeParserOptions[];
  /** True when content is too large to highlight; it then renders as plain text. */
  readonly isTooLarge: (content: string) => boolean;
}

export interface HighlightOnceResult {
  highlights?: SimpleHighlight[];
  warning?: string;
  error?: string;
}

export class LucyTreeSitterClient extends TreeSitterClient {
  readonly #parsers: readonly FiletypeParserOptions[];
  readonly #isTooLarge: (content: string) => boolean;
  #baseInitialization: Promise<void> | undefined;
  #ready: Promise<void> | undefined;

  constructor(options: LucyTreeSitterClientOptions) {
    for (const parser of options.parsers) assertLocalParser(parser);
    super({ dataPath: options.dataPath });
    this.#parsers = options.parsers;
    this.#isTooLarge = options.isTooLarge;
  }

  override addFiletypeParser(filetypeParser: FiletypeParserOptions): void {
    assertLocalParser(filetypeParser);
    super.addFiletypeParser(filetypeParser);
  }

  override initialize(): Promise<void> {
    const base = super.initialize();
    if (base !== this.#baseInitialization) {
      // A new base promise means a new worker: register again before any request is sent.
      // Requests await this promise, so registration always precedes the first highlight.
      this.#baseInitialization = base;
      this.#ready = base.then(() => {
        for (const parser of this.#parsers) super.addFiletypeParser(parser);
      });
    }
    return this.#ready ?? base;
  }

  override async highlightOnce(content: string, filetype: string): Promise<HighlightOnceResult> {
    if (this.#isTooLarge(content)) return { highlights: [] };
    if (COMPOSITE_FILETYPES.has(filetype)) {
      const kind = filetype === "htm" || filetype === "xhtml" ? "html" : filetype;
      return highlightComposite(
        content,
        kind,
        (markup, markupFiletype) => super.highlightOnce(markup, markupFiletype),
        (block, blockFiletype) => this.highlightOnce(block, blockFiletype),
      );
    }
    const fallback = fallbackTokenizerFor(filetype);
    if (fallback) {
      return {
        highlights: fallback
          .tokenize(content)
          .map((range): SimpleHighlight => [range.start, range.end, range.group]),
      };
    }
    return super.highlightOnce(content, filetype);
  }
}
