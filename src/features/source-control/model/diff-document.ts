/**
 * A diff ready to render: the parsed patch, its row models, both sides of the file for syntax
 * colors, and the flags the view needs (binary, too large, empty, mode change).
 *
 * Both sides are highlighted as whole files rather than hunk fragments, so a hunk that starts
 * inside a string or comment is still colored correctly. A row asks for its tokens by side and
 * line number; the lookup also checks that the file line matches the patch line, so a file that
 * changed between reading the patch and reading the file never gets misplaced colors.
 */
import type {
  GitDiff,
  GitDiffMode,
  GitDiffOptions,
  GitDiffTarget,
  GitFileContent,
  GitReadOptions,
  GitRevision,
} from "@/adapters/git";
import { detectLanguage, type LanguageInfo } from "@/adapters/syntax/languages";
import type { HighlightRange, LineToken } from "@/adapters/syntax/types";
import { isLucyError, LucyError } from "@/core/errors";
import {
  DiffModel,
  type DiffModelOptions,
  type SplitCell,
  type SplitRow,
  type UnifiedLineRow,
  type UnifiedRow,
} from "./diff-model";
import { type ParsedDiff, parseUnifiedDiff } from "./patch-parser";

/** What the document needs from Git. Both `GitService` and any `GitAdapter` satisfy it. */
export interface DiffSource {
  diff(target: GitDiffTarget, options?: GitDiffOptions): Promise<GitDiff>;
  fileAtRevision(path: string, revision: GitRevision, options?: GitReadOptions): Promise<GitFileContent>;
}

/** What the document needs for colors. `SyntaxService` satisfies it. */
export interface DiffSyntax {
  languageFor(path: string, firstLine?: string): LanguageInfo;
  highlight(
    content: string,
    languageId: string,
    options?: { signal?: AbortSignal },
  ): Promise<HighlightRange[]>;
  tokenizeLines(content: string, ranges: readonly HighlightRange[]): LineToken[][];
}

export type DiffSideName = "old" | "new";

export interface DiffSideInfo {
  /** Revision the side was read from; `null` when the side does not exist for this diff. */
  readonly revision: GitRevision | null;
  readonly path: string | null;
  readonly exists: boolean;
  readonly isBinary: boolean;
  readonly isTooLarge: boolean;
  /** Syntax tokens are available for this side. */
  readonly highlighted: boolean;
}

export interface DiffSideInput {
  readonly revision: GitRevision | null;
  readonly path: string | null;
  readonly content: GitFileContent | null;
  /** Per-line tokens for `content` (from `tokenizeLines`), if highlighted. */
  readonly tokens?: readonly (readonly LineToken[])[] | null;
}

export interface DiffDocumentInput {
  readonly target: GitDiffTarget;
  readonly mode: GitDiffMode;
  readonly patch: string;
  readonly isBinary: boolean;
  readonly isTooLarge: boolean;
  readonly language: LanguageInfo;
  readonly old?: DiffSideInput;
  readonly new?: DiffSideInput;
  readonly model?: DiffModelOptions;
}

const NO_TOKENS: readonly LineToken[] = Object.freeze([]);

function emptySide(): DiffSideInput {
  return { revision: null, path: null, content: null, tokens: null };
}

class SideLines {
  readonly info: DiffSideInfo;
  private lines: string[] | null = null;

  constructor(
    private readonly input: DiffSideInput,
    private readonly tokens: readonly (readonly LineToken[])[] | null,
  ) {
    const content = input.content;
    this.info = {
      revision: input.revision,
      path: input.path,
      exists: content?.exists ?? false,
      isBinary: content?.isBinary ?? false,
      isTooLarge: content?.isTooLarge ?? false,
      highlighted: tokens !== null && tokens.length > 0,
    };
  }

  /** The file's line `lineNumber` (1-based) without its terminator, or `undefined`. */
  text(lineNumber: number): string | undefined {
    if (this.lines === null) {
      const content = this.input.content?.content ?? null;
      this.lines =
        content === null
          ? []
          : content.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
    }
    return this.lines[lineNumber - 1];
  }

  tokensFor(lineNumber: number, expectedText?: string): readonly LineToken[] {
    if (!this.tokens) return NO_TOKENS;
    if (expectedText !== undefined && this.text(lineNumber) !== expectedText) return NO_TOKENS;
    return this.tokens[lineNumber - 1] ?? NO_TOKENS;
  }
}

export class DiffDocument {
  readonly target: GitDiffTarget;
  readonly mode: GitDiffMode;
  readonly diff: ParsedDiff;
  readonly model: DiffModel;
  readonly language: LanguageInfo;
  /** Binary on either side, as reported by Git. No rows, no tokens. */
  readonly isBinary: boolean;
  /** The patch exceeded the size cap. No rows, no tokens. */
  readonly isTooLarge: boolean;
  /** No textual change (and not binary or too large). A mode-only change is still `isEmpty`. */
  readonly isEmpty: boolean;
  /** `{ oldMode, newMode }` when the file mode changed (e.g. made executable). */
  readonly modeChange: { readonly oldMode: string; readonly newMode: string } | null;
  readonly old: DiffSideInfo;
  readonly new: DiffSideInfo;
  private readonly sides: Record<DiffSideName, SideLines>;

  constructor(input: DiffDocumentInput) {
    this.target = input.target;
    this.mode = input.mode;
    this.language = input.language;
    this.diff = parseUnifiedDiff(input.patch);
    this.model = new DiffModel(this.diff, input.model);
    this.isBinary = input.isBinary || this.diff.isBinary;
    this.isTooLarge = input.isTooLarge;
    this.isEmpty = !this.isBinary && !this.isTooLarge && this.diff.hunks.length === 0;
    const { oldMode, newMode } = this.diff;
    this.modeChange = oldMode && newMode && oldMode !== newMode ? { oldMode, newMode } : null;
    const oldSide = input.old ?? emptySide();
    const newSide = input.new ?? emptySide();
    this.sides = {
      old: new SideLines(oldSide, oldSide.tokens ?? null),
      new: new SideLines(newSide, newSide.tokens ?? null),
    };
    this.old = this.sides.old.info;
    this.new = this.sides.new.info;
  }

  get path(): string {
    return this.target.path;
  }

  get unified(): readonly UnifiedRow[] {
    return this.model.unified;
  }

  /** Built on first access. */
  get split(): readonly SplitRow[] {
    return this.model.split;
  }

  get truncated(): boolean {
    return this.model.truncated;
  }

  /**
   * Tokens for line `lineNumber` (1-based) of one side. With `expectedText`, returns no tokens
   * unless the file line equals it (protects against a file that changed after the patch).
   */
  tokensFor(side: DiffSideName, lineNumber: number, expectedText?: string): readonly LineToken[] {
    return this.sides[side].tokensFor(lineNumber, expectedText);
  }

  /** Tokens for a unified line row: removed lines from the old side, others from the new side. */
  tokensForUnifiedRow(row: UnifiedLineRow): readonly LineToken[] {
    if (row.type === "removed")
      return row.oldLine === null ? NO_TOKENS : this.tokensFor("old", row.oldLine, row.text);
    return row.newLine === null ? NO_TOKENS : this.tokensFor("new", row.newLine, row.text);
  }

  /** Tokens for a split cell: the left cell reads the old side, the right cell the new side. */
  tokensForCell(side: DiffSideName, cell: SplitCell): readonly LineToken[] {
    return this.tokensFor(side, cell.lineNumber, cell.text);
  }
}

export interface LoadDiffDocumentDeps {
  git: DiffSource;
  syntax?: DiffSyntax;
}

export interface LoadDiffDocumentOptions {
  signal?: AbortSignal;
  /** Context lines (`-U`). Default 3. */
  context?: number;
  /** Byte cap for each side of the file. Defaults to the adapter limit. */
  maxFileBytes?: number;
  model?: DiffModelOptions;
}

interface SidePlan {
  path: string;
  revision: GitRevision;
}

/**
 * Which revisions the two sides come from, matching what the adapter diffed:
 * staged = HEAD → INDEX, unstaged = INDEX → WORKTREE, untracked = nothing → WORKTREE,
 * conflict = OURS → WORKTREE. Added files have no old side and deleted files no new side.
 */
export function sidesForDiff(
  target: GitDiffTarget,
  mode: GitDiffMode,
  parsed: ParsedDiff,
): { old: SidePlan | null; new: SidePlan | null } {
  const path = target.path;
  let plan: { old: SidePlan | null; new: SidePlan | null };
  switch (mode) {
    case "staged":
      plan = {
        old: { path: parsed.oldPath ?? target.origPath ?? path, revision: "HEAD" },
        new: { path, revision: "INDEX" },
      };
      break;
    case "unstaged":
      plan = { old: { path, revision: "INDEX" }, new: { path, revision: "WORKTREE" } };
      break;
    case "untracked":
      plan = { old: null, new: { path, revision: "WORKTREE" } };
      break;
    case "conflict":
      plan = { old: { path, revision: "OURS" }, new: { path, revision: "WORKTREE" } };
      break;
  }
  if (parsed.status === "added") plan.old = null;
  if (parsed.status === "deleted") plan.new = null;
  return plan;
}

function cancelled(): LucyError {
  return new LucyError("CANCELLED", "Loading the diff was cancelled.");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelled();
}

function firstLine(content: string | null | undefined): string | undefined {
  if (!content) return undefined;
  const newline = content.indexOf("\n");
  return newline === -1 ? content : content.slice(0, newline);
}

async function highlightSide(
  syntax: DiffSyntax | undefined,
  language: LanguageInfo,
  content: GitFileContent | null,
  signal: AbortSignal | undefined,
): Promise<LineToken[][] | null> {
  if (!syntax || !content?.content || content.isBinary || content.isTooLarge || !language.filetype)
    return null;
  const ranges = await syntax.highlight(content.content, language.id, { signal });
  throwIfAborted(signal);
  return ranges.length > 0 ? syntax.tokenizeLines(content.content, ranges) : null;
}

/**
 * Loads the patch and both sides of the file, highlights them and builds the document.
 * Rejects with `LucyError("CANCELLED")` when `signal` aborts (also mid-highlight).
 */
export async function loadDiffDocument(
  target: GitDiffTarget,
  deps: LoadDiffDocumentDeps,
  options: LoadDiffDocumentOptions = {},
): Promise<DiffDocument> {
  const { signal } = options;
  try {
    throwIfAborted(signal);
    const patch = await deps.git.diff(target, { signal, context: options.context });
    throwIfAborted(signal);
    const parsed = parseUnifiedDiff(patch.patch);
    const plan = sidesForDiff(target, patch.mode, parsed);
    const skipContent = patch.isBinary || patch.isTooLarge || parsed.isBinary;

    const read = (side: SidePlan | null): Promise<GitFileContent | null> =>
      side && !skipContent
        ? deps.git.fileAtRevision(side.path, side.revision, { signal, maxBytes: options.maxFileBytes })
        : Promise.resolve(null);
    const [oldContent, newContent] = await Promise.all([read(plan.old), read(plan.new)]);
    throwIfAborted(signal);

    const languagePath = parsed.newPath ?? target.path;
    const language = deps.syntax
      ? deps.syntax.languageFor(languagePath, firstLine(newContent?.content ?? oldContent?.content))
      : detectLanguage(languagePath, firstLine(newContent?.content ?? oldContent?.content));
    const [oldTokens, newTokens] = await Promise.all([
      highlightSide(deps.syntax, language, oldContent, signal),
      highlightSide(deps.syntax, language, newContent, signal),
    ]);
    throwIfAborted(signal);

    return new DiffDocument({
      target,
      mode: patch.mode,
      patch: patch.patch,
      isBinary: patch.isBinary,
      isTooLarge: patch.isTooLarge,
      language,
      old: {
        revision: plan.old?.revision ?? null,
        path: plan.old?.path ?? null,
        content: oldContent,
        tokens: oldTokens,
      },
      new: {
        revision: plan.new?.revision ?? null,
        path: plan.new?.path ?? null,
        content: newContent,
        tokens: newTokens,
      },
      model: options.model,
    });
  } catch (error) {
    // Adapter calls aborted by the signal surface as CANCELLED (or as a Git `cancelled` kind).
    if (signal?.aborted && !isLucyError(error, "CANCELLED")) throw cancelled();
    throw error;
  }
}
