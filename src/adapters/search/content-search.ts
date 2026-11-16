/**
 * Project-wide content search (Ctrl+Shift+F) with automatic engine selection:
 * ripgrep when a real `rg` is on PATH, else `git grep` inside a repository, else the builtin
 * JavaScript scanner over `FileIndex`. All engines produce the same `SearchMatch` shape.
 *
 * `search()` streams batches through `onMatches` and resolves to a summary. Aborting the
 * signal kills child processes and rejects with a `CANCELLED` LucyError; no batch is
 * delivered after the promise settles. An invalid regex rejects with `InvalidPatternError`.
 */
import { cancelledError } from "@/adapters/filesystem/async-util";
import { type GitEnv, isInsideGitWorkTree } from "@/adapters/filesystem/git-probe";
import { isLucyError, LucyError } from "@/core/errors";
import { which } from "@/core/process";
import { type BuiltinLimits, searchBuiltin } from "./builtin-engine";
import { compileQuery } from "./compile-query";
import { FileIndex } from "./file-index";
import { type GitGrepCapabilities, searchWithGitGrep } from "./git-grep-engine";
import { MatchSink } from "./match-sink";
import { searchWithRipgrep } from "./ripgrep-engine";
import {
  type ContentSearchQuery,
  DEFAULT_SEARCH_LIMITS,
  type SearchCallbacks,
  type SearchEngineName,
  type SearchLimits,
  type SearchSummary,
} from "./search-types";

export interface ContentSearchOptions {
  /** Absolute workspace root. */
  root: string;
  /** File source for the builtin engine. Default: a private `FileIndex` on the same root. */
  fileIndex?: FileIndex;
  /** Force an engine (tests). Default "auto". */
  engine?: SearchEngineName | "auto";
  /** Extra environment for Git and ripgrep. */
  env?: GitEnv;
  /** Path of `rg`; `null` disables ripgrep; default: looked up on PATH once. */
  ripgrepPath?: string | null;
  builtinLimits?: Partial<BuiltinLimits>;
  /** File-size and line-length limits for ripgrep and git grep. */
  limits?: Partial<SearchLimits>;
}

export class ContentSearch {
  readonly root: string;
  private readonly options: ContentSearchOptions;
  private fileIndex: FileIndex | null;
  private ripgrep: string | null | undefined;
  private autoEngine: Promise<SearchEngineName> | null = null;
  private readonly gitCapabilities: GitGrepCapabilities = {};

  constructor(options: ContentSearchOptions) {
    this.root = options.root;
    this.options = options;
    this.fileIndex = options.fileIndex ?? null;
    this.ripgrep = options.ripgrepPath;
  }

  /** `rg` that would be used, or `null`. */
  ripgrepPath(): string | null {
    if (this.ripgrep === undefined) this.ripgrep = which("rg", this.options.env);
    return this.ripgrep;
  }

  /** The engine `search()` will use. Auto-detection is cached; see `resetEngine()`. */
  resolveEngine(): Promise<SearchEngineName> {
    const forced = this.options.engine;
    if (forced && forced !== "auto") return Promise.resolve(forced);
    this.autoEngine ??= (async (): Promise<SearchEngineName> => {
      if (this.ripgrepPath()) return "ripgrep";
      if (await isInsideGitWorkTree(this.root, this.options.env)) return "git-grep";
      return "builtin";
    })();
    return this.autoEngine;
  }

  /** Forget the detected engine (for example after `git init` in the workspace). */
  resetEngine(): void {
    this.autoEngine = null;
    this.ripgrep = this.options.ripgrepPath;
  }

  async search(
    query: ContentSearchQuery,
    callbacks: SearchCallbacks,
    signal?: AbortSignal,
  ): Promise<SearchSummary> {
    const started = performance.now();
    if (signal?.aborted) throw cancelledError();
    const compiled = compileQuery(query);
    const engine = await this.resolveEngine();
    const controller = new AbortController();
    const forward = (): void => controller.abort();
    signal?.addEventListener("abort", forward, { once: true });
    const sink = new MatchSink(
      compiled.maxResults,
      (matches) => callbacks.onMatches(matches),
      controller.signal,
    );
    try {
      if (compiled.pattern !== "") {
        if (engine === "ripgrep") {
          const rg = this.ripgrepPath();
          if (!rg) throw new LucyError("UNSUPPORTED", "ripgrep (rg) is not installed");
          await searchWithRipgrep(
            rg,
            this.root,
            compiled,
            sink,
            controller.signal,
            this.options.env,
            this.limits,
          );
        } else if (engine === "git-grep") {
          if (!(await isInsideGitWorkTree(this.root, this.options.env, controller.signal))) {
            throw new LucyError("NOT_A_REPOSITORY", "The workspace is not a Git repository");
          }
          await searchWithGitGrep(
            this.root,
            compiled,
            sink,
            controller.signal,
            this.options.env,
            this.gitCapabilities,
            this.limits,
          );
        } else {
          const index = this.ensureFileIndex();
          const listing = await index.list(controller.signal);
          if (listing.truncated) sink.markTruncated("file-list");
          await searchBuiltin(
            this.root,
            listing.files,
            compiled,
            sink,
            controller.signal,
            this.options.builtinLimits,
          );
        }
      }
      if (signal?.aborted) throw cancelledError();
      return {
        engine,
        matchCount: sink.matchCount,
        fileCount: sink.fileCount,
        truncated: sink.truncated,
        limitsHit: sink.limitsHit,
        durationMs: performance.now() - started,
      };
    } catch (error) {
      if (signal?.aborted || isLucyError(error, "CANCELLED")) throw cancelledError();
      throw error;
    } finally {
      sink.close();
      signal?.removeEventListener("abort", forward);
      controller.abort();
    }
  }

  private get limits(): SearchLimits {
    return { ...DEFAULT_SEARCH_LIMITS, ...this.options.limits };
  }

  private ensureFileIndex(): FileIndex {
    this.fileIndex ??= new FileIndex({
      root: this.root,
      env: this.options.env,
      ripgrepPath: this.options.ripgrepPath,
    });
    return this.fileIndex;
  }
}
