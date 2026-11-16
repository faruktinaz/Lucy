/**
 * Shared setup for Source Control model tests: fixture repositories with adapters, registered
 * for cleanup, and a deterministic fake syntax provider.
 */
import { afterEach, setDefaultTimeout } from "bun:test";
import { type GitCliAdapter, openGitRepository } from "@/adapters/git";
import { detectLanguage, type LanguageInfo } from "@/adapters/syntax/languages";
import { tokenizeLines } from "@/adapters/syntax/tokenize-lines";
import type { HighlightRange, LineToken } from "@/adapters/syntax/types";
import { LucyError } from "@/core/errors";
import type { DiffSyntax } from "@/features/source-control/model";
import { createFixtureRepo, type FixtureOptions, type FixtureRepo } from "../helpers/git-fixture";

const cleanups: (() => void)[] = [];

/** Registers cleanup after each test and a timeout suited to tests that spawn Git. */
export function registerCleanup(): void {
  setDefaultTimeout(30_000);
  afterEach(() => {
    while (cleanups.length > 0) {
      try {
        cleanups.pop()?.();
      } catch {
        // Keep cleaning up the rest.
      }
    }
  });
}

export function deferCleanup(fn: () => void): void {
  cleanups.push(fn);
}

export async function repo(options: FixtureOptions = {}): Promise<{ fx: FixtureRepo; git: GitCliAdapter }> {
  const fx = await createFixtureRepo(options);
  cleanups.push(() => fx.dispose());
  const git = await openGitRepository(fx.root, { env: fx.env });
  cleanups.push(() => git.dispose());
  return { fx, git };
}

/** A repository left mid-merge with `f.txt` modified on both sides ("ours" vs "theirs"). */
export async function createConflictRepo(): Promise<{ fx: FixtureRepo; git: GitCliAdapter }> {
  const context = await repo({ files: { "f.txt": "base\n" }, commit: "base" });
  const { fx } = context;
  await fx.git("switch", "-q", "-c", "other");
  await fx.write("f.txt", "theirs\n");
  await fx.commitAll("theirs");
  await fx.git("switch", "-q", "main");
  await fx.write("f.txt", "ours\n");
  await fx.commitAll("ours");
  const merge = await fx.gitRaw(["merge", "other"]);
  if (merge.code === 0) throw new Error("expected a merge conflict");
  return context;
}

/**
 * Deterministic highlighter: the first word of every line is a `keyword`, the rest is plain.
 * Optionally waits on `gate` (to test cancellation) and records every highlighted content.
 */
export class FakeSyntax implements DiffSyntax {
  readonly highlighted: string[] = [];
  gate: Promise<void> | null = null;

  languageFor(path: string, firstLine?: string): LanguageInfo {
    return detectLanguage(path, firstLine);
  }

  async highlight(
    content: string,
    _languageId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<HighlightRange[]> {
    this.highlighted.push(content);
    if (this.gate) {
      const gate = this.gate;
      await new Promise<void>((resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new LucyError("CANCELLED", "cancelled")), {
          once: true,
        });
        void gate.then(resolve);
      });
    }
    const ranges: HighlightRange[] = [];
    let offset = 0;
    for (const line of content.split("\n")) {
      const word = /^\s*([\p{L}\p{N}_]+)/u.exec(line);
      if (word?.[1]) {
        const start = offset + line.indexOf(word[1]);
        ranges.push({ start, end: start + word[1].length, group: "keyword" });
      }
      offset += line.length + 1;
    }
    return ranges;
  }

  tokenizeLines(content: string, ranges: readonly HighlightRange[]): LineToken[][] {
    return tokenizeLines(content, ranges);
  }
}
