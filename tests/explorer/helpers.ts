/** Shared setup for explorer view-model tests: a real FileTree and FileOps on a temp dir. */
import { join } from "node:path";
import { FileOps, FileTree, type FileTreeOptions } from "@/adapters/filesystem";
import {
  type DecorationLookup,
  type ExplorerOpenIntent,
  type ExplorerRow,
  ExplorerViewModel,
} from "@/features/explorer/model";
import { createTempDirs, writeTree } from "../filesystem/helpers";

export const tempDir = createTempDirs("lucy-explorer-");

export interface ExplorerFixture {
  root: string;
  tree: FileTree;
  fileOps: FileOps;
  model: ExplorerViewModel;
  opened: ExplorerOpenIntent[];
  advance(ms: number): void;
}

export async function setupExplorer(
  files: Record<string, string | Uint8Array>,
  options: { tree?: Partial<FileTreeOptions>; decorations?: DecorationLookup; root?: string } = {},
): Promise<ExplorerFixture> {
  const root = options.root ?? (await tempDir());
  await writeTree(root, files);
  const state = await tempDir();
  const tree = new FileTree({ root, detectIgnored: false, locale: "en", ...options.tree });
  const fileOps = new FileOps({ root, trashDir: join(state, "trash") });
  const opened: ExplorerOpenIntent[] = [];
  let clock = 1_000_000;
  const model = new ExplorerViewModel({
    tree,
    fileOps,
    iconTier: "ascii",
    decorations: options.decorations,
    onOpen: (intent) => opened.push(intent),
    now: () => clock,
  });
  await model.initialize();
  return {
    root,
    tree,
    fileOps,
    model,
    opened,
    advance: (ms) => {
      clock += ms;
    },
  };
}

export function allRows(model: ExplorerViewModel): ExplorerRow[] {
  return model.getRows(0, model.store.get().rowCount);
}

/** Compact picture of the rows: paths, "[more N]" and "[edit value]". */
export function rowLabels(model: ExplorerViewModel): string[] {
  return allRows(model).map((row) =>
    row.type === "entry"
      ? row.path
      : row.type === "more"
        ? `[more ${row.hiddenCount}]`
        : `[edit ${row.value}]`,
  );
}

export function selected(model: ExplorerViewModel): string | null {
  return model.store.get().selectedKey;
}
