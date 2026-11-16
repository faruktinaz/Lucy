/**
 * Opening config.toml. It lives outside the workspace, so it is opened in the external
 * editor with the adapter's explicit allow-outside flag (the user asked for exactly this
 * file). When no editor can run, the path is shown with a Copy Path action instead. After
 * the editor exits, a changed file is reloaded and the result reported.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type ExternalEditorResult,
  type OpenInExternalEditorOptions,
  openInExternalEditor,
  resolveEditor,
} from "@/adapters/editor";
import type { AppContext } from "@/app/app-context";
import { errorMessage } from "@/core/errors";
import { tildify } from "@/core/paths";
import type { SettingsServices } from "./services";

export type ExternalEditorRunner = (options: OpenInExternalEditorOptions) => Promise<ExternalEditorResult>;

export interface ConfigFilePosition {
  readonly line?: number;
  readonly column?: number;
}

/** Shows where config.toml is, with a copy action, when it cannot be opened here. */
export function showConfigPath(ctx: AppContext, services: SettingsServices, reason: string): void {
  const path = ctx.config.path;
  ctx.notifications.show({
    key: "settings.configPath",
    severity: "info",
    title: `Settings file: ${tildify(path)}`,
    message: reason,
    actions: [
      {
        label: "Copy Path",
        run: () => {
          const copied = services.renderer.current?.copyToClipboardOSC52(path) ?? false;
          ctx.hints.flash(
            copied
              ? { text: "Path copied", tone: "muted" }
              : { text: "This terminal does not allow copying from Lucy", tone: "muted" },
          );
        },
      },
    ],
  });
}

export async function openConfigFile(
  ctx: AppContext,
  services: SettingsServices,
  position: ConfigFilePosition = {},
): Promise<void> {
  const run = services.environment.openExternalEditor ?? openInExternalEditor;
  const path = ctx.config.path;
  const renderer = services.renderer.current;
  const resolution = resolveEditor(ctx.config.get("editor.external"), services.environment.env);
  if (!resolution.ok) {
    showConfigPath(
      ctx,
      services,
      `${resolution.message} Open it in any editor; Lucy reloads it on the next start.`,
    );
    return;
  }
  if (!renderer) {
    showConfigPath(ctx, services, "The editor cannot be started from here. Open the file in any editor.");
    return;
  }
  try {
    // Lucy's own directory: creating it lets the editor save a brand-new config.toml.
    await mkdir(dirname(path), { recursive: true });
    const result = await run({
      editor: resolution.editor,
      file: path,
      line: position.line,
      column: position.column,
      cwd: dirname(path),
      workspaceRoot: dirname(path),
      allowOutsideWorkspace: true,
      terminal: { suspend: () => renderer.suspend(), resume: () => renderer.resume() },
      env: services.environment.env,
    });
    if (!result.changed) return;
    const loaded = await ctx.config.reload();
    if (loaded.problems.length === 0) {
      ctx.notifications.success("Settings reloaded", "config.toml was changed and applied.");
    } else {
      ctx.notifications.show({
        key: "config-problems",
        severity: "warning",
        title:
          loaded.problems.length === 1
            ? "Settings reloaded with 1 problem"
            : `Settings reloaded with ${loaded.problems.length} problems`,
        message: loaded.problems[0]?.message,
        actions: [{ label: "Show in Settings", run: () => void ctx.run("settings.open") }],
      });
    }
  } catch (error) {
    ctx.notifications.error(
      `Could not open config.toml in ${resolution.editor.displayName}`,
      errorMessage(error),
    );
    showConfigPath(ctx, services, "Open it in any editor instead.");
  }
}
