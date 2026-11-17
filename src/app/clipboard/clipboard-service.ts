/**
 * The clipboard: one place that puts text on the user's clipboard and says honestly what
 * happened, so callers can tell "copied" from "sent to the terminal" from "failed".
 *
 * Strategy (`SystemClipboardBackend`):
 * - Local machine: the platform tool, with the text on stdin. `pbcopy` on macOS; `clip.exe`
 *   under WSL; on Linux `wl-copy` under Wayland and `xclip` or `xsel` under X11. A tool that
 *   exits 0 has the text, so this is the reliable path.
 * - SSH session (or no tool, or every tool failed): OSC 52 through the renderer. The terminal
 *   may silently ignore it (Terminal.app, tmux without `set-clipboard`), so a successful write
 *   is reported as `osc52`, not as a confirmed copy. Over SSH a local tool would fill the
 *   remote machine's clipboard, which is never what the user means.
 *
 * Why tools are not run with captured output: `xclip`, `xsel` and `wl-copy` fork a daemon that
 * keeps serving the selection. Captured stdout/stderr stay open in that daemon, so waiting for
 * end-of-output waits until the timeout, which then kills the daemon and loses the copy. The
 * tools run with stdio ignored, in their own session so the daemon outlives Lucy's terminal.
 */
import { platform as osPlatform } from "node:os";
import { errorMessage } from "@/core/errors";
import { resolveCommand } from "@/core/process";

/** What a copy did. `ok` means the text reached a clipboard (or, for `osc52`, the terminal). */
export type CopyResult =
  | { readonly ok: true; readonly method: "tool"; readonly tool: string }
  | { readonly ok: true; readonly method: "osc52" }
  | { readonly ok: true; readonly method: "memory" }
  | { readonly ok: false; readonly reason: string };

export interface ClipboardBackend {
  copy(text: string): Promise<CopyResult>;
}

/** The renderer's OSC 52 writer (OpenTUI `CliRenderer`); the test renderer throws. */
export interface Osc52Writer {
  isOsc52Supported(): boolean;
  copyToClipboardOSC52(text: string): boolean;
}

/** Runs a clipboard tool with `input` on stdin; resolves to its exit code (null: no exit). */
export type ToolRunner = (
  program: string,
  args: readonly string[],
  input: Uint8Array,
) => Promise<number | null>;

export interface SystemClipboardOptions {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Read at copy time: the renderer may be created or destroyed after the service. */
  osc52?: () => Osc52Writer | null;
  runTool?: ToolRunner;
  /** How long a tool may take before the copy counts as failed. Default 3000 ms. */
  toolTimeoutMs?: number;
}

export interface ClipboardTool {
  readonly argv: readonly string[];
  /** clip.exe reads the console code page; UTF-16LE with a BOM keeps non-ASCII text intact. */
  readonly encoding: "utf8" | "utf16le";
}

export function isSshSession(env: Record<string, string | undefined>): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
}

export function isWsl(env: Record<string, string | undefined>, platform: NodeJS.Platform): boolean {
  return platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}

/** The tools to try, in order, for this environment (whether installed or not). */
export function clipboardTools(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): ClipboardTool[] {
  if (platform === "darwin") return [{ argv: ["pbcopy"], encoding: "utf8" }];
  const tools: ClipboardTool[] = [];
  if (isWsl(env, platform)) tools.push({ argv: ["clip.exe"], encoding: "utf16le" });
  // Without a display server these tools only print "cannot open display"; skip them.
  if (env.WAYLAND_DISPLAY) tools.push({ argv: ["wl-copy"], encoding: "utf8" });
  if (env.DISPLAY) {
    tools.push({ argv: ["xclip", "-selection", "clipboard"], encoding: "utf8" });
    tools.push({ argv: ["xsel", "--clipboard", "--input"], encoding: "utf8" });
  }
  return tools;
}

function encode(text: string, encoding: ClipboardTool["encoding"]): Uint8Array {
  if (encoding === "utf8") return new TextEncoder().encode(text);
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    bytes[2 + i * 2] = unit & 0xff;
    bytes[3 + i * 2] = unit >> 8;
  }
  return bytes;
}

function spawnTool(env: Record<string, string | undefined>, timeoutMs: number): ToolRunner {
  return async (program, args, input) => {
    const child = Bun.spawn([program, ...args], {
      env,
      stdin: input,
      // See the module comment: captured stdio would wait for the selection daemon.
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      const code = await Promise.race([child.exited, timeout]);
      if (code === null) child.kill("SIGKILL");
      return code;
    } finally {
      clearTimeout(timer);
    }
  };
}

export class SystemClipboardBackend implements ClipboardBackend {
  private readonly env: Record<string, string | undefined>;
  private readonly platform: NodeJS.Platform;
  private readonly runTool: ToolRunner;

  constructor(private readonly options: SystemClipboardOptions = {}) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? osPlatform();
    this.runTool = options.runTool ?? spawnTool(this.env, options.toolTimeoutMs ?? 3000);
  }

  /** A short description of the strategy for this environment (logs, the report command). */
  describe(): string {
    const ssh = isSshSession(this.env);
    const tools = clipboardTools(this.env, this.platform).filter((tool) => this.resolve(tool) !== null);
    if (ssh) return "SSH session: OSC 52 through the terminal";
    if (tools.length === 0) return "No clipboard tool found: OSC 52 through the terminal";
    return `Clipboard tool: ${tools.map((tool) => tool.argv[0]).join(", then ")}; OSC 52 as fallback`;
  }

  async copy(text: string): Promise<CopyResult> {
    const failures: string[] = [];
    if (!isSshSession(this.env)) {
      for (const tool of clipboardTools(this.env, this.platform)) {
        const program = this.resolve(tool);
        if (program === null) continue;
        const name = tool.argv[0] as string;
        try {
          const code = await this.runTool(program, tool.argv.slice(1), encode(text, tool.encoding));
          if (code === 0) return { ok: true, method: "tool", tool: name };
          failures.push(code === null ? `${name} did not finish` : `${name} exited with code ${code}`);
        } catch (error) {
          failures.push(`${name} could not start (${errorMessage(error)})`);
        }
      }
    }
    const osc52 = this.tryOsc52(text);
    if (osc52 === true) return { ok: true, method: "osc52" };
    failures.push(osc52);
    return { ok: false, reason: failures.join("; ") };
  }

  private resolve(tool: ClipboardTool): string | null {
    return resolveCommand(tool.argv[0] as string, this.env);
  }

  /** True when the escape sequence was written; otherwise why not. */
  private tryOsc52(text: string): true | string {
    const writer = this.options.osc52?.() ?? null;
    if (!writer) return "the terminal clipboard (OSC 52) is not available";
    try {
      if (!writer.isOsc52Supported()) return "the terminal does not support OSC 52";
      return writer.copyToClipboardOSC52(text) ? true : "the terminal refused the OSC 52 copy";
    } catch (error) {
      // OpenTUI's test renderer throws instead of returning false.
      return `OSC 52 failed (${errorMessage(error)})`;
    }
  }
}

/** An in-memory clipboard: tests, and anything that must never touch the real one. */
export class MemoryClipboardBackend implements ClipboardBackend {
  readonly copies: string[] = [];
  /** Set to make the next copies fail with this reason. */
  failWith: string | null = null;

  get text(): string | undefined {
    return this.copies.at(-1);
  }

  async copy(text: string): Promise<CopyResult> {
    if (this.failWith !== null) return { ok: false, reason: this.failWith };
    this.copies.push(text);
    return { ok: true, method: "memory" };
  }
}

/** `ctx.clipboard`: copies text and reports what happened. Never throws. */
export class ClipboardService {
  constructor(private readonly backend: ClipboardBackend) {}

  async copy(text: string): Promise<CopyResult> {
    if (text.length === 0) return { ok: false, reason: "There is nothing to copy." };
    try {
      return await this.backend.copy(text);
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  }
}

/** A short status-bar text for a successful copy. */
export function copiedLabel(result: CopyResult & { ok: true }, what = "Copied"): string {
  return result.method === "osc52" ? `${what} (sent to the terminal clipboard)` : what;
}
