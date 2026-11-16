/**
 * Entry point: `lucy [path] [options]` (see `bin/lucy`).
 *
 * Startup order: parse arguments, resolve the workspace and Lucy's directories, configure the
 * file log, load the configuration, point OpenTUI's data path into Lucy's cache, create the
 * renderer, build the app (`createApp`), mount React, wait for the first frame, then start
 * Git status and the file watcher. Every phase is timed (`LUCY_PROFILE=1` prints the timings
 * after exit). Failures before the renderer exists are plain messages on stderr.
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliRenderEvents, type CliRenderer, createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { installPtyShutdownHooks } from "@/adapters/pty";
import { configureOpenTuiDataPath } from "@/adapters/syntax";
import { helpText, parseArgs } from "@/app/cli";
import { type CreatedApp, createApp, createTimings } from "@/app/create-app";
import { buildDemoWorkspace, type DemoWorkspace, isolatedGitEnv } from "@/app/demo";
import { LOG_FILE_MAX_BYTES, logFilePath } from "@/app/log-file";
import { ShutdownController } from "@/app/shutdown";
import { ConfigService } from "@/core/config";
import { errorMessage, isLucyError } from "@/core/errors";
import { setListenerErrorSink } from "@/core/events";
import { configureLogger, flushLogs, log, redact } from "@/core/log";
import { type AppDirs, resolveAppDirs } from "@/core/paths";
import { type ResolvedWorkspace, resolveWorkspace } from "@/core/workspace";
import { resolveColorMode, resolveTheme, themeFromSettings } from "@/themes";
import packageJson from "../package.json" with { type: "json" };

export const VERSION: string = packageJson.version;

const SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];
const SIGNAL_CODES: Readonly<Record<string, number>> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGTERM: 15 };

function fail(message: string, code = 1): number {
  process.stderr.write(`${message}\n`);
  return code;
}

/** A calm sentence for a workspace that cannot be opened. */
export function describeWorkspaceError(error: unknown, path: string): string {
  if (isLucyError(error)) {
    switch (error.code) {
      case "NOT_FOUND":
        return `lucy: "${path}" does not exist.`;
      case "PERMISSION_DENIED":
        return `lucy: you do not have permission to open "${path}".`;
      case "INVALID_ARGUMENT":
        return `lucy: ${error.message}`;
      default:
        return `lucy: cannot open "${path}": ${error.message}`;
    }
  }
  return `lucy: cannot open "${path}": ${errorMessage(error)}`;
}

/** Keeps the log small: one previous generation (`lucy.log.1`) is kept. */
function rotateLog(file: string): void {
  try {
    if (statSync(file).size > LOG_FILE_MAX_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // No log yet.
  }
}

/** Resolves once the renderer painted a frame (or after a second, whatever happens first). */
function nextFrame(renderer: CliRenderer): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 1000);
    renderer.once(CliRenderEvents.FRAME, () => {
      clearTimeout(timer);
      resolve();
    });
    renderer.requestRender();
  });
}

export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const timings = createTimings();
  timings.mark("start");
  const parsed = parseArgs(argv);
  if (parsed.kind === "help") {
    process.stdout.write(helpText(VERSION));
    return 0;
  }
  if (parsed.kind === "version") {
    process.stdout.write(`lucy ${VERSION}\n`);
    return 0;
  }
  if (parsed.kind === "error") return fail(parsed.message, parsed.exitCode);
  const options = parsed.options;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return fail(
      "lucy is an interactive app and needs a terminal. Run it directly in a terminal window (not through a pipe or redirect).",
    );
  }

  // Demo mode: a throwaway project plus isolated config, state and cache.
  let demo: DemoWorkspace | null = null;
  let demoHome: string | null = null;
  let dirs: AppDirs;
  let workspace: ResolvedWorkspace;
  try {
    if (options.demo) {
      demo = await buildDemoWorkspace({ withConflict: options.conflict });
      demoHome = mkdtempSync(join(tmpdir(), "lucy-demo-home-"));
      dirs = {
        config: join(demoHome, "config"),
        state: join(demoHome, "state"),
        cache: join(demoHome, "cache"),
      };
      for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
      workspace = await resolveWorkspace(demo.root, demo.root);
    } else {
      dirs = resolveAppDirs();
      workspace = await resolveWorkspace(options.path, process.cwd());
    }
  } catch (error) {
    demo?.dispose();
    if (demoHome) rmSync(demoHome, { recursive: true, force: true });
    return fail(
      options.demo
        ? `lucy: could not build the demo workspace: ${errorMessage(error)}`
        : describeWorkspaceError(error, options.path),
    );
  }
  timings.mark("workspace");

  const cleanupDemo = () => {
    demo?.dispose();
    demo = null;
    if (demoHome) rmSync(demoHome, { recursive: true, force: true });
    demoHome = null;
  };

  const logFile = logFilePath(dirs);
  rotateLog(logFile);
  configureLogger({ file: logFile, level: options.debug ? "debug" : "info" });
  setListenerErrorSink((error, context) => log.error(`${context} failed`, { error }));
  log.info("Starting", { version: VERSION, workspace: workspace.workspace.root, demo: options.demo });

  let config: ConfigService;
  try {
    config = await ConfigService.load(dirs);
  } catch (error) {
    cleanupDemo();
    return fail(`lucy: could not read the configuration in ${dirs.config}: ${errorMessage(error)}`);
  }
  timings.mark("config");

  // OpenTUI's Tree-sitter client must never write to ~/.local/share/opentui.
  configureOpenTuiDataPath(join(dirs.cache, "opentui"));
  const colorMode = resolveColorMode(config.get("ui.colorMode"));
  const initialTheme = resolveTheme(
    themeFromSettings(config.get("ui.theme"), config.get("ui.accent")),
    colorMode,
  );

  let renderer: CliRenderer;
  try {
    renderer = await createCliRenderer({
      exitOnCtrlC: false,
      // Lucy owns signals so that every exit goes through the shutdown path.
      exitSignals: [],
      targetFps: 60,
      consoleMode: "console-overlay",
      openConsoleOnError: options.debug,
      backgroundColor: initialTheme.tokens.bg.base,
    });
  } catch (error) {
    cleanupDemo();
    return fail(`lucy: could not start the terminal UI: ${errorMessage(error)}`);
  }
  timings.mark("renderer");

  let app: CreatedApp | null = null;
  const shutdown = new ShutdownController({
    disposeApp: async () => {
      await app?.dispose();
    },
    killTerminals: () => app?.context.services.killAllTerminals(),
    destroyRenderer: async () => {
      if (!renderer.isDestroyed) renderer.destroy();
      await renderer.closed;
    },
    cleanup: cleanupDemo,
    flushLogs: async () => {
      log.info("Stopped");
      await flushLogs();
    },
    exit: (code) => {
      if (process.env.LUCY_PROFILE === "1") {
        const lines = timings.marks().map((m) => `  ${m.phase.padEnd(20)} ${m.ms.toFixed(1)} ms`);
        process.stderr.write(`lucy startup timings (since process start):\n${lines.join("\n")}\n`);
      }
      process.exit(code);
    },
    onStepError: (step, error) => log.error(`Shutdown step "${step}" failed`, { error }),
  });

  for (const signal of SIGNALS) {
    process.on(signal, () => void shutdown.run(128 + (SIGNAL_CODES[signal] ?? 0)));
  }
  // Nothing fails silently, and nothing takes the app down: log it, tell the user calmly.
  const reportUnexpected = (kind: string) => (error: unknown) => {
    log.error(`Unexpected ${kind}`, { error: redact(error) });
    app?.context.notifications.show({
      key: "unexpected-error",
      severity: "error",
      title: "Something went wrong",
      message: `Lucy keeps running. Details are in ${logFile}.`,
    });
  };
  process.on("uncaughtException", reportUnexpected("error"));
  process.on("unhandledRejection", reportUnexpected("rejection"));

  try {
    app = await createApp({
      renderer,
      workspace,
      dirs,
      config,
      env: { version: VERSION, demo: options.demo, debug: options.debug },
      restore: options.restore,
      overrides: demo ? { toolEnv: isolatedGitEnv(demo.containerDir) } : undefined,
      timings,
      log: log.child("app"),
      onQuit: () => shutdown.run(0),
      onSuspend: async () => {
        // Job control (OPENTUI_NOTES §1): restore the terminal, stop, and repaint on `fg`.
        await renderer.suspend();
        process.once("SIGCONT", () => void renderer.resume());
        process.kill(process.pid, "SIGSTOP");
      },
      toggleConsole: () => renderer.console.toggle(),
    });
  } catch (error) {
    log.error("Startup failed", { error });
    renderer.destroy();
    await renderer.closed;
    cleanupDemo();
    await flushLogs();
    return fail(`lucy: startup failed: ${errorMessage(error)}. Details are in ${logFile}.`);
  }
  // The registry kills PTY trees on process exit too, as a last line of defence.
  installPtyShutdownHooks(app.context.services.pty, { signals: [] });

  createRoot(renderer).render(app.element);
  timings.mark("mounted");
  await nextFrame(renderer);
  app.markFirstPaint();
  log.info("Startup timings", { marks: timings.marks() });
  return -1;
}

// There is deliberately no `import.meta.main` self-run here. This module statically imports
// `@opentui/react`, whose evaluation opens a React DevTools websocket when `DEV=true`; only a
// launcher that loads it through `importWithoutReactDevTools` can prevent that. Start the app
// with `bin/lucy` (the `dev` and `demo` scripts do).
