/**
 * What the editor asks of the operating system beyond `ctx.clipboard`: reading the clipboard
 * for Ctrl+V and opening a file with its default application. Both go through argv arrays (`run`), never a
 * shell, and both report failure instead of pretending.
 */
import { platform } from "node:os";
import { errorMessage, LucyError } from "@/core/errors";
import { run, which } from "@/core/process";

function pasteCommands(env: NodeJS.ProcessEnv): string[][] {
  if (platform() === "darwin") return [["pbpaste"]];
  const commands: string[][] = [];
  if (env.WAYLAND_DISPLAY) commands.push(["wl-paste", "--no-newline"]);
  commands.push(["xclip", "-selection", "clipboard", "-o"], ["xsel", "--clipboard", "--output"]);
  return commands;
}

/**
 * Reads the system clipboard for Ctrl+V. Returns null when no tool is available (over SSH, a
 * headless Linux): the terminal's own paste key still works there through bracketed paste.
 */
export async function readClipboard(env = process.env): Promise<string | null> {
  for (const argv of pasteCommands(env)) {
    if (!which(argv[0] as string)) continue;
    const result = await run(argv, { timeoutMs: 3000 });
    if (result.code === 0) return result.stdout;
  }
  return null;
}

/** Opens a file with the system's default application (`open` on macOS, `xdg-open` elsewhere). */
export async function openWithDefaultApp(absolutePath: string): Promise<void> {
  const opener = platform() === "darwin" ? "open" : "xdg-open";
  if (!which(opener)) {
    throw new LucyError(
      "UNSUPPORTED",
      `"${opener}" is not available, so the file cannot be opened outside Lucy.`,
    );
  }
  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run([opener, absolutePath], { timeoutMs: 10_000 });
  } catch (cause) {
    throw new LucyError("SPAWN_FAILED", `Could not start ${opener}: ${errorMessage(cause)}`, { cause });
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim().split("\n")[0] ?? "";
    throw new LucyError("PROCESS_FAILED", detail || `${opener} exited with code ${result.code}`);
  }
}
