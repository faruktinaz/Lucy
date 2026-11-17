/**
 * A workspace that is not a repository itself but holds repositories at several depths, a
 * plain folder, and a repository inside `node_modules` that discovery must skip:
 *
 *   <root>/alpha/                 repository (depth 1), one modified file
 *   <root>/group/beta/            repository (depth 2), one untracked file
 *   <root>/group/deep/gamma/      repository (depth 3), clean
 *   <root>/plain/notes.md         not a repository
 *   <root>/node_modules/lib/      repository, skipped
 *
 * Passed to `mountApp` as a `demoWorkspace` so Git runs with the demo's isolated environment.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DemoWorkspace } from "@/app/demo";
import { isolatedGitEnv } from "@/app/demo";
import { run } from "@/core/process";

export interface MultiRepoWorkspace {
  readonly root: string;
  readonly containerDir: string;
  /** For `mountApp({ demoWorkspace })`; disposing it is left to `dispose()`. */
  readonly demo: DemoWorkspace;
  git(repo: string, ...args: string[]): Promise<string>;
  write(path: string, content: string): void;
  dispose(): void;
}

export async function createRepository(
  containerDir: string,
  path: string,
  files: Record<string, string>,
): Promise<void> {
  const env = isolatedGitEnv(containerDir);
  mkdirSync(path, { recursive: true });
  const git = async (...args: string[]) => {
    const result = await run(["git", ...args], { cwd: path, env });
    if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  };
  await git("init", "-q", "--template=", "--initial-branch=main");
  await git("config", "user.name", "Lucy Test");
  await git("config", "user.email", "lucy-test@example.invalid");
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(path, file)), { recursive: true });
    writeFileSync(join(path, file), content);
  }
  await git("add", "-A");
  await git("commit", "-q", "-m", "Initial commit");
}

export async function createMultiRepoWorkspace(): Promise<MultiRepoWorkspace> {
  const containerDir = realpathSync(mkdtempSync(join(process.env.LUCY_TEST_ROOT ?? tmpdir(), "multi-repo-")));
  const root = join(containerDir, "projects");
  mkdirSync(root);
  await createRepository(containerDir, join(root, "alpha"), { "a.txt": "alpha\n" });
  await createRepository(containerDir, join(root, "group", "beta"), { "b.txt": "beta\n" });
  await createRepository(containerDir, join(root, "group", "deep", "gamma"), { "g.txt": "gamma\n" });
  await createRepository(containerDir, join(root, "node_modules", "lib"), { "index.js": "\n" });
  mkdirSync(join(root, "plain"));
  writeFileSync(join(root, "plain", "notes.md"), "# Notes\n");
  writeFileSync(join(root, "alpha", "a.txt"), "alpha changed\n");
  writeFileSync(join(root, "group", "beta", "new.txt"), "new\n");

  const env = isolatedGitEnv(containerDir);
  const dispose = () => rmSync(containerDir, { recursive: true, force: true });
  const demo = {
    root,
    containerDir,
    originDir: "",
    description: {},
    dispose: () => {},
  } as unknown as DemoWorkspace;
  return {
    root,
    containerDir,
    demo,
    async git(repo, ...args) {
      const result = await run(["git", ...args], { cwd: join(root, repo), env });
      if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
      return result.stdout;
    },
    write(path, content) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    },
    dispose,
  };
}
