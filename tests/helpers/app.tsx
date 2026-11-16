/**
 * `mountApp`: the whole app (`createApp` + the workbench) in a test renderer, with safe
 * defaults: a fresh temporary workspace, private config/state/cache directories, a mock Git
 * adapter, no real PTY (spawning throws), truecolor, background services off.
 *
 *   const { tui, ctx } = await mountApp({ files: { "src/main.ts": "export {}" } });
 *   await tui.press("ctrl+p");
 *   await tui.waitForText("main.ts");
 *
 *   // The demo workspace with its isolated Git environment:
 *   const demo = await mountApp({ workspace: "demo", git: "real", startBackground: true });
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ReactNode, useSyncExternalStore } from "react";
import type { AgentProvider } from "@/adapters/agents";
import {
  createGitAdapterFactory,
  type GitAdapterFactory,
  MockGitAdapter,
  type MockGitAdapterOptions,
} from "@/adapters/git";
import type { PtyProcess, PtySpawnOptions } from "@/adapters/pty";
import type { AppContext } from "@/app/app-context";
import { type CreatedApp, createApp } from "@/app/create-app";
import { buildDemoWorkspace, type DemoWorkspace, isolatedGitEnv } from "@/app/demo";
import type { FeatureModule } from "@/app/feature";
import type { Clock } from "@/app/workbench/readable";
import { ConfigService, type SettingPath, type SettingValue } from "@/core/config";
import { LucyError } from "@/core/errors";
import type { AppDirs } from "@/core/paths";
import { Store } from "@/core/store";
import { type ResolvedWorkspace, resolveWorkspace } from "@/core/workspace";
import { type MountOptions, mountTui, type Tui } from "./tui";

export type SettingOverrides = { [P in SettingPath]?: SettingValue<P> };

export interface MountAppOptions extends Omit<MountOptions, "renderer"> {
  /** `temp` (default): an empty temporary folder plus `files`; `demo`: the demo project; or a path. */
  workspace?: "temp" | "demo" | { root: string };
  /** Leave a merge conflict in the demo workspace. */
  demoConflict?: boolean;
  /** Reuse an already built demo workspace (it is not disposed with the app). */
  demoWorkspace?: DemoWorkspace;
  /** Files to create in a temp workspace (relative path to content). */
  files?: Readonly<Record<string, string>>;
  /**
   * `mock` (default for temp workspaces): a `MockGitAdapter`, optionally configured.
   * `real`: the Git CLI (with the demo's isolated environment for the demo workspace).
   */
  git?: "mock" | "real" | MockGitAdapterOptions;
  /** Settings applied in memory after loading (nothing is written). */
  settings?: SettingOverrides;
  features?: readonly FeatureModule[];
  /** Restore layout and tabs from a previous mount with the same `dirs`. Default true. */
  restore?: boolean;
  /** Start Git status and the watcher after mounting. Default false. */
  startBackground?: boolean;
  /** Reuse Lucy directories (e.g. to test restore across two mounts). Default: fresh temp dirs. */
  dirs?: AppDirs;
  /** PTY spawner. Default: throws, so no test can start a real shell by accident. */
  ptySpawn?: (options: PtySpawnOptions) => PtyProcess;
  agentProviders?: readonly AgentProvider[];
  clock?: Clock;
  /** Terminal environment for color/icon detection. Default truecolor UTF-8. */
  terminalEnv?: Record<string, string | undefined>;
  /** Called instead of disposing when the app quits (`app.quit`). */
  onQuit?: () => void | Promise<void>;
  onSuspend?: () => void | Promise<void>;
}

export interface MountedApp {
  tui: Tui;
  app: CreatedApp;
  ctx: AppContext;
  /** Workspace root on disk. */
  root: string;
  dirs: AppDirs;
  /** The mock Git adapter, when `git` is mock. */
  git?: MockGitAdapter;
  demo?: DemoWorkspace;
  dispose(): Promise<void>;
}

/** Fresh, private Lucy directories under the test root. */
export function createTestDirs(): AppDirs {
  const base = mkdtempSync(join(process.env.LUCY_TEST_ROOT ?? tmpdir(), "app-"));
  const dirs = { config: join(base, "config"), state: join(base, "state"), cache: join(base, "cache") };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  return dirs;
}

const noPty = (): PtyProcess => {
  throw new LucyError("UNSUPPORTED", "PTYs are disabled in tests; pass `ptySpawn` to mountApp to opt in");
};

/** Shared with `tests/setup.ts` and `tests/helpers/tui.tsx`. */
const LIVE_KEY = Symbol.for("lucy.tests.liveTuis");

function liveDisposers(): Set<() => Promise<void>> {
  const holder = globalThis as unknown as Record<symbol, Set<() => Promise<void>> | undefined>;
  let set = holder[LIVE_KEY];
  if (!set) {
    set = new Set();
    holder[LIVE_KEY] = set;
  }
  return set;
}

/** Renders whatever node the store holds: lets the app mount after the renderer exists. */
function Slot({ source }: { source: Store<ReactNode> }) {
  return useSyncExternalStore(source.subscribe, source.get, source.get);
}

export async function mountApp(options: MountAppOptions = {}): Promise<MountedApp> {
  const dirs = options.dirs ?? createTestDirs();
  const cleanups: (() => void)[] = [];

  let demo: DemoWorkspace | undefined;
  let root: string;
  if (options.demoWorkspace) {
    demo = options.demoWorkspace;
    root = demo.root;
  } else if (options.workspace === "demo") {
    demo = await buildDemoWorkspace({ withConflict: options.demoConflict ?? false });
    root = demo.root;
    const built = demo;
    cleanups.push(() => built.dispose());
  } else if (typeof options.workspace === "object") {
    root = options.workspace.root;
  } else {
    root = mkdtempSync(join(process.env.LUCY_TEST_ROOT ?? tmpdir(), "workspace-"));
    const created = root;
    cleanups.push(() => rmSync(created, { recursive: true, force: true }));
  }
  for (const [path, content] of Object.entries(options.files ?? {})) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  const resolved: ResolvedWorkspace = await resolveWorkspace(root, root);
  const config = await ConfigService.load(dirs);
  for (const [path, value] of Object.entries(options.settings ?? {})) {
    await config.set(path as SettingPath, value as never, { persist: false });
  }

  let mockGit: MockGitAdapter | undefined;
  let gitAdapterFactory: GitAdapterFactory | undefined;
  const toolEnv = demo ? isolatedGitEnv(demo.containerDir) : undefined;
  const gitMode = options.git ?? (demo ? "real" : "mock");
  if (gitMode === "real") {
    gitAdapterFactory = createGitAdapterFactory(resolved.workspace.root, { env: toolEnv });
  } else {
    mockGit = new MockGitAdapter({
      repository: { root: resolved.workspace.root, workspaceRoot: resolved.workspace.root },
      ...(gitMode === "mock" ? {} : gitMode),
    });
    const adapter = mockGit;
    gitAdapterFactory = async () => adapter;
  }

  const slot = new Store<ReactNode>(null);
  const tui = await mountTui(<Slot source={slot} />, {
    width: options.width,
    height: options.height,
    kittyKeyboard: options.kittyKeyboard,
    // As in main.ts: Ctrl+C belongs to terminals and never destroys the renderer.
    renderer: { exitOnCtrlC: false },
  });

  const app = await createApp({
    renderer: tui.renderer,
    workspace: resolved,
    dirs,
    config,
    env: { version: "0.0.0-test", demo: demo !== undefined },
    features: options.features,
    restore: options.restore ?? true,
    terminalEnv: options.terminalEnv ?? {
      COLORTERM: "truecolor",
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
    },
    stateSaveDelayMs: 20,
    clock: options.clock,
    overrides: {
      gitAdapterFactory,
      toolEnv,
      ptySpawn: options.ptySpawn ?? noPty,
      agentProviders: options.agentProviders ?? [],
    },
    onQuit: options.onQuit,
    onSuspend: options.onSuspend,
  });

  await tui.act(() => slot.set(app.element));
  app.markFirstPaint({ startBackground: options.startBackground ?? false });
  await tui.settle();

  let disposed = false;
  const live = liveDisposers();
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    live.delete(dispose);
    try {
      await tui.act(() => app.dispose());
    } finally {
      await tui.dispose();
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup();
        } catch {
          // Temporary files are best-effort; the test root is removed on exit.
        }
      }
    }
  };
  // The test preload disposes everything in this set after each test, even when it fails.
  live.add(dispose);
  return { tui, app, ctx: app.context, root: resolved.workspace.root, dirs, git: mockGit, demo, dispose };
}
