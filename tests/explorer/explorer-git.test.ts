import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGitAdapterFactory, GitService } from "@/adapters/git";
import type { ExplorerEntryRow } from "@/features/explorer/model";
import { commitAll, GIT_TEST_ENV, initRepo, writeTree } from "../filesystem/helpers";
import { allRows, setupExplorer, tempDir } from "./helpers";

function entry(rows: ReturnType<typeof allRows>, path: string): ExplorerEntryRow {
  const row = rows.find((candidate) => candidate.type === "entry" && candidate.path === path);
  if (row?.type !== "entry") throw new Error(`no entry row ${path}`);
  return row;
}

test("Git decorations from a real repository: letters, folder markers, ignored files", async () => {
  const root = await tempDir();
  await writeTree(root, { ".gitignore": "*.log\n", "src/a.ts": "a", "src/b.ts": "b", "README.md": "" });
  await initRepo(root);
  await commitAll(root);
  await writeFile(join(root, "src/a.ts"), "changed");
  await writeFile(join(root, "src/new.ts"), "");
  await writeFile(join(root, "debug.log"), "");

  const git = new GitService(createGitAdapterFactory(root, { env: GIT_TEST_ENV }));
  await git.refresh();
  expect(git.store.get().error).toBeNull();
  const { model } = await setupExplorer(
    {},
    {
      root,
      decorations: (path) => git.decorationFor(path),
      tree: { detectIgnored: true, gitEnv: GIT_TEST_ENV },
    },
  );
  await model.reveal("src/a.ts");
  const rows = allRows(model);

  expect(entry(rows, "src")).toMatchObject({
    nameColor: "git.modified",
    git: { text: "*", color: "git.modified", quiet: true, count: 2 },
  });
  expect(entry(rows, "src/a.ts").git).toEqual({ text: "M", color: "git.modified", quiet: false, count: 1 });
  expect(entry(rows, "src/new.ts")).toMatchObject({
    nameColor: "git.untracked",
    git: { text: "?", color: "git.untracked" },
  });
  expect(entry(rows, "src/b.ts").git).toBeNull();
  expect(entry(rows, "debug.log")).toMatchObject({ dimmed: true, nameColor: "git.ignored", git: null });
  expect(entry(rows, "README.md")).toMatchObject({ dimmed: false, nameColor: "fg.default", git: null });

  // The model works without a repository: no lookup, no badges.
  model.setDecorationLookup(null);
  expect(entry(allRows(model), "src/a.ts").git).toBeNull();
  model.setIconTier("unicode");
  model.setDecorationLookup((path) => git.decorationFor(path));
  expect(entry(allRows(model), "src").git?.text).toBe("◉");
  git.dispose();
  model.dispose();
});
