/**
 * The two things the viewer asks of the operating system: putting text on the clipboard and
 * opening a file with its default application. Both go through argv arrays (`run`), never a
 * shell, and both report failure instead of pretending.
 */
import { platform } from "node:os";
import { errorMessage, LucyError } from "@/core/errors";
import { run, which } from "@/core/process";

/** The renderer's OSC 52 clipboard, when a view has registered it (works over SSH too). */
export interface TerminalClipboard {
  isOsc52Supported(): boolean;
  copyToClipboardOSC52(text: string): boolean;
}

/** Holds the renderer's clipboard while a viewer is mounted; commands run outside React. */
export class ClipboardBridge {
  terminal: TerminalClipboard | null = null;
}

function clipboardCommands(env: NodeJS.ProcessEnv): string[][] {
  if (platform() === "darwin") return [["pbcopy"]];
  const commands: string[][] = [];
  if (env.WAYLAND_DISPLAY) commands.push(["wl-copy"]);
  commands.push(["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]);
  return commands;
}

/**
 * Copies `text`. The terminal's OSC 52 comes first because it reaches the user's own machine
 * even over SSH; the platform tool is the fallback. Throws `UNSUPPORTED` when neither works.
 */
export async function copyText(text: string, bridge: ClipboardBridge, env = process.env): Promise<void> {
  const terminal = bridge.terminal;
  if (terminal) {
    try {
      if (terminal.isOsc52Supported() && terminal.copyToClipboardOSC52(text)) return;
    } catch {
      // Some renderers throw instead of returning false (the test renderer does); try the OS.
    }
  }
  for (const argv of clipboardCommands(env)) {
    if (!which(argv[0] as string)) continue;
    const result = await run(argv, { stdin: text, timeoutMs: 3000 });
    if (result.code === 0) return;
  }
  throw new LucyError(
    "UNSUPPORTED",
    "No clipboard is available: the terminal does not support OSC 52 and no clipboard tool was found.",
  );
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
