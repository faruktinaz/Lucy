/**
 * Builds the throwaway workspace behind `lucy --demo`: a copy of the fixture project with a
 * crafted Git history, a local `origin`, a stash and a working tree that shows every
 * Source Control situation at once.
 *
 * Layout of a build:
 *
 *   <container>/                 created by us, holds the ownership marker
 *     .lucy-demo-owner
 *     orbit/                     the workspace root (`root`)
 *     origin.git/                bare repository acting as `origin`
 */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { LucyError } from "../../core/errors";
import type { Disposable } from "../../core/events";
import { realpathWithin } from "../../core/paths";
import { copyFixture, DEFAULT_FIXTURE_DIR, listFixtureFiles } from "./fixture";
import { DemoRepository } from "./git";
import { realTempDir, removeOwnedDirectory, writeOwnerMarker } from "./ownership";
import {
  CONFLICT_BRANCH_COMMIT,
  CONFLICT_MERGE,
  type CommitStep,
  DEMO_CONFLICT_BRANCH,
  DEMO_DEFAULT_BRANCH,
  DEMO_FEATURE_BRANCH,
  DEMO_PROJECT_NAME,
  DEMO_REMOTE,
  type DemoWorkspaceDescription,
  describeDemoWorkspace,
  FEATURE_COMMITS,
  type FileVersion,
  identityFor,
  MAIN_COMMITS,
  STAGED_EDITS,
  STAGED_NEW_FILE,
  STAGED_RENAME,
  STAGED_THEN_MODIFIED,
  STASH,
  type TextEdit,
  UNSTAGED_DELETION,
  UNSTAGED_EDITS,
  UNTRACKED_FILES,
} from "./scenario";

export interface BuildDemoWorkspaceOptions {
  /**
   * Directory that will hold the demo (`<targetDir>/orbit` and `<targetDir>/origin.git`).
   * It must not exist yet or be empty, and must lie inside the system temporary directory.
   * Default: a new directory under `os.tmpdir()`.
   */
  targetDir?: string;
  /** Also leave an unresolved merge conflict (a merge in progress). Default `false`. */
  withConflict?: boolean;
  /** Source of the fixture. Default: `examples/demo-project` in this checkout. */
  fixtureDir?: string;
}

export interface DemoWorkspace extends Disposable {
  /** Workspace root to open (real path, named `orbit`). */
  root: string;
  /** Bare repository configured as `origin`. */
  originDir: string;
  /** The directory holding both; removed by `dispose()`. */
  containerDir: string;
  /** Expected Source Control state, for assertions. */
  description: DemoWorkspaceDescription;
  /**
   * Removes everything the build created. Synchronous so it can run during process exit.
   * Throws a `LucyError` (`PERMISSION_DENIED`) instead of deleting anything it cannot prove it owns.
   */
  dispose(): void;
}

const MARKER_TOKEN_PREFIX = "lucy-demo-";

function applyEdits(text: string, edits: readonly TextEdit[], path: string): string {
  let result = text;
  for (const edit of edits) {
    const count = result.split(edit.find).length - 1;
    if (count === 0 || (!edit.all && count !== 1)) {
      // The scenario and the fixture drifted apart; failing loudly beats a subtly wrong demo.
      throw new LucyError("INTERNAL", `Demo scenario edit for ${path} matched ${count} times`, {
        details: { path, find: edit.find.slice(0, 80) },
      });
    }
    result = edit.all
      ? result.split(edit.find).join(edit.replace)
      : result.replace(edit.find, () => edit.replace);
  }
  return result;
}

function fixtureText(fixtureFiles: ReadonlyMap<string, Buffer>, path: string): string {
  const content = fixtureFiles.get(path);
  if (!content) throw new LucyError("INTERNAL", `Demo scenario refers to a missing fixture file: ${path}`);
  return content.toString("utf8");
}

function editFile(root: string, path: string, edits: readonly TextEdit[]): void {
  const target = join(root, path);
  writeFileSync(target, applyEdits(readFileSync(target, "utf8"), edits, path));
}

/** Resolves and validates the container directory; returns it and whether we created it. */
async function prepareContainer(targetDir: string | undefined): Promise<{ dir: string; created: boolean }> {
  const temp = realTempDir();
  if (targetDir === undefined) {
    return { dir: mkdtempSync(join(temp, "lucy-demo-")), created: true };
  }
  if (!isAbsolute(targetDir)) {
    throw new LucyError("INVALID_ARGUMENT", "The demo target directory must be an absolute path");
  }
  // Resolving through the nearest existing ancestor stops a symlink from smuggling the demo elsewhere.
  const real = await realpathWithin(temp, resolve(targetDir));
  if (real === null || real === temp) {
    throw new LucyError(
      "OUTSIDE_WORKSPACE",
      `The demo target must be inside the temporary directory (${temp})`,
      {
        details: { targetDir },
      },
    );
  }
  if (existsSync(real)) {
    if (!lstatSync(real).isDirectory() || readdirSync(real).length > 0) {
      throw new LucyError("ALREADY_EXISTS", `The demo target exists and is not empty: ${targetDir}`, {
        details: { targetDir },
      });
    }
    return { dir: real, created: false };
  }
  mkdirSync(real, { recursive: true, mode: 0o700 });
  return { dir: real, created: true };
}

class DemoBuild {
  private readonly fixtureFiles = new Map<string, Buffer>();
  private repo!: DemoRepository;

  constructor(
    private readonly fixtureDir: string,
    private readonly root: string,
    private readonly originDir: string,
  ) {}

  async run(withConflict: boolean): Promise<void> {
    mkdirSync(this.root, { mode: 0o755 });
    copyFixture(this.fixtureDir, this.root);
    for (const path of listFixtureFiles(this.fixtureDir)) {
      this.fixtureFiles.set(path, readFileSync(join(this.root, path)));
    }

    const first = MAIN_COMMITS[0]!;
    this.repo = await DemoRepository.init(this.root, identityFor(first.author, first.date));

    for (const step of MAIN_COMMITS) await this.commit(step);

    await DemoRepository.initBare(this.originDir);
    await this.repo.git(["remote", "add", DEMO_REMOTE, this.originDir]);
    await this.repo.git(["push", "--quiet", "--set-upstream", DEMO_REMOTE, DEMO_DEFAULT_BRANCH]);

    await this.repo.git(["switch", "--quiet", "--create", DEMO_CONFLICT_BRANCH]);
    await this.commit(CONFLICT_BRANCH_COMMIT);
    await this.repo.git(["switch", "--quiet", DEMO_DEFAULT_BRANCH]);

    await this.repo.git(["switch", "--quiet", "--create", DEMO_FEATURE_BRANCH]);
    const [pushed, local] = FEATURE_COMMITS;
    await this.commit(pushed);
    await this.repo.git(["push", "--quiet", "--set-upstream", DEMO_REMOTE, DEMO_FEATURE_BRANCH]);
    await this.commit(local);

    await this.assertOnlyPlannedFilesUntracked();
    await this.createStash();
    if (withConflict) await this.startConflictingMerge();
    await this.applyWorkingChanges();
  }

  private writeVersion(file: string | FileVersion): string {
    const version: FileVersion = typeof file === "string" ? { path: file } : file;
    const target = join(this.root, version.path);
    if (version.content !== undefined) {
      writeFileSync(target, version.content);
    } else if (version.edits) {
      writeFileSync(
        target,
        applyEdits(fixtureText(this.fixtureFiles, version.path), version.edits, version.path),
      );
    } else {
      writeFileSync(
        target,
        this.fixtureFiles.get(version.path) ?? fixtureText(this.fixtureFiles, version.path),
      );
    }
    return version.path;
  }

  private async commit(step: CommitStep): Promise<void> {
    const paths = step.files.map((file) => this.writeVersion(file));
    await this.repo.git(["add", "--", ...paths]);
    const message = step.body ? `${step.subject}\n\n${step.body}` : `${step.subject}\n`;
    await this.repo.git(["commit", "--quiet", "--no-verify", "--cleanup=strip", "--file=-"], {
      identity: identityFor(step.author, step.date),
      stdin: message,
    });
  }

  /**
   * After the history is written, the work tree must match HEAD except for the files that are
   * meant to stay uncommitted. This catches a fixture file that no commit claims.
   */
  private async assertOnlyPlannedFilesUntracked(): Promise<void> {
    const result = await this.repo.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const entries = result.stdout.split("\0").filter(Boolean);
    const expected = [STAGED_NEW_FILE, ...UNTRACKED_FILES].map((path) => `?? ${path}`).sort();
    const actual = entries.map((entry) => entry.normalize("NFC")).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected.map((entry) => entry.normalize("NFC")))) {
      throw new LucyError(
        "INTERNAL",
        "The demo fixture and scenario disagree about which files are committed",
        {
          details: { expected, actual },
        },
      );
    }
  }

  private async createStash(): Promise<void> {
    editFile(this.root, STASH.path, STASH.edits);
    await this.repo.git(["stash", "push", "--quiet", "--message", STASH.message, "--", STASH.path], {
      identity: identityFor(STASH.author, STASH.date),
    });
  }

  private async startConflictingMerge(): Promise<void> {
    // Exit code 1 is the expected outcome: the merge stops with a conflict.
    await this.repo.git(["merge", "--no-ff", "--no-edit", DEMO_CONFLICT_BRANCH], {
      identity: identityFor(CONFLICT_MERGE.author, CONFLICT_MERGE.date),
      okCodes: [1],
    });
    const unmerged = await this.repo.git(["ls-files", "--unmerged", "-z", "--", CONFLICT_MERGE.path]);
    if (unmerged.stdout === "") {
      throw new LucyError("INTERNAL", `Expected a merge conflict in ${CONFLICT_MERGE.path}`);
    }
  }

  private async applyWorkingChanges(): Promise<void> {
    for (const { path, edits } of STAGED_EDITS) editFile(this.root, path, edits);
    await this.repo.git(["add", "--", ...STAGED_EDITS.map((entry) => entry.path), STAGED_NEW_FILE]);

    editFile(this.root, STAGED_THEN_MODIFIED.path, STAGED_THEN_MODIFIED.staged);
    await this.repo.git(["add", "--", STAGED_THEN_MODIFIED.path]);
    editFile(this.root, STAGED_THEN_MODIFIED.path, STAGED_THEN_MODIFIED.unstaged);

    await this.repo.git(["mv", "--", STAGED_RENAME.from, STAGED_RENAME.to]);

    for (const { path, edits } of UNSTAGED_EDITS) editFile(this.root, path, edits);
    rmSync(join(this.root, UNSTAGED_DELETION));
  }
}

/**
 * Builds a fresh demo workspace. The same options always produce the same tree, the same
 * `git status` and the same commit hashes; only the temporary path differs.
 */
export async function buildDemoWorkspace(options: BuildDemoWorkspaceOptions = {}): Promise<DemoWorkspace> {
  const fixtureDir = options.fixtureDir ?? DEFAULT_FIXTURE_DIR;
  if (!existsSync(fixtureDir)) {
    throw new LucyError("NOT_FOUND", `Demo fixture not found: ${fixtureDir}`, { details: { fixtureDir } });
  }

  const container = await prepareContainer(options.targetDir);
  const token = `${MARKER_TOKEN_PREFIX}${randomUUID()}`;
  writeOwnerMarker(container.dir, token);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    removeOwnedDirectory(container.dir, token, !container.created);
    disposed = true;
  };

  const root = join(container.dir, DEMO_PROJECT_NAME);
  const originDir = join(container.dir, "origin.git");
  try {
    await new DemoBuild(fixtureDir, root, originDir).run(options.withConflict ?? false);
  } catch (error) {
    try {
      dispose();
    } catch {
      // Keep the original failure; a refused cleanup leaves files in the temp directory only.
    }
    throw error;
  }

  return {
    root,
    originDir,
    containerDir: container.dir,
    description: describeDemoWorkspace({ withConflict: options.withConflict }),
    dispose,
  };
}
