/**
 * An honest overview of what Lucy integrates with on this machine: external tools (found or
 * not, version, what Lucy uses them for), terminal capabilities and built-in modules. It
 * backs the "Extensions" entry of the activity bar until a real plugin system exists.
 *
 * Lucy never installs anything; a missing tool only gets a one-line hint.
 */
import { stat } from "node:fs/promises";
import { errorMessage } from "@/core/errors";
import type { Disposable } from "@/core/events";
import { type RunOptions, type RunResult, run, which } from "@/core/process";
import { Store } from "@/core/store";

export interface ToolSpec {
  readonly id: string;
  /** Executable name looked up on PATH. */
  readonly bin: string;
  readonly title: string;
  /** What Lucy uses it for. */
  readonly purpose: string;
  readonly required: boolean;
  /** One line shown when it is missing. Text only. */
  readonly missingHint: string;
  /** Arguments that print the version. Most tools use `--version`. */
  readonly versionArgs: readonly string[];
}

const version = ["--version"] as const;

export const INTEGRATION_TOOLS: readonly ToolSpec[] = [
  {
    id: "git",
    bin: "git",
    title: "Git",
    purpose: "Source Control: status, diffs, staging, commits, branches.",
    required: true,
    missingHint: "Source Control is unavailable without Git. Install it with your system's package manager.",
    versionArgs: version,
  },
  {
    id: "ripgrep",
    bin: "rg",
    title: "ripgrep",
    purpose: "Fast project search.",
    required: false,
    missingHint: "Search falls back to git grep or the built-in search. ripgrep is faster on large projects.",
    versionArgs: version,
  },
  {
    id: "claude",
    bin: "claude",
    title: "Claude Code",
    purpose: "The AI panel.",
    required: false,
    missingHint: "The AI panel needs Claude Code. Everything else works without it.",
    versionArgs: version,
  },
  {
    id: "micro",
    bin: "micro",
    title: "micro",
    purpose: "External editor for editing files.",
    required: false,
    missingHint: "Optional. Lucy uses whichever of micro, hx, nvim or vim is available.",
    versionArgs: version,
  },
  {
    id: "hx",
    bin: "hx",
    title: "Helix",
    purpose: "External editor for editing files.",
    required: false,
    missingHint: "Optional. Lucy uses whichever of micro, hx, nvim or vim is available.",
    versionArgs: version,
  },
  {
    id: "nvim",
    bin: "nvim",
    title: "Neovim",
    purpose: "External editor for editing files.",
    required: false,
    missingHint: "Optional. Lucy uses whichever of micro, hx, nvim or vim is available.",
    versionArgs: version,
  },
  {
    id: "vim",
    bin: "vim",
    title: "Vim",
    purpose: "External editor for editing files.",
    required: false,
    missingHint: "Optional. Lucy uses whichever of micro, hx, nvim or vim is available.",
    versionArgs: version,
  },
  {
    id: "lazygit",
    bin: "lazygit",
    title: "lazygit",
    purpose: "Optional full-screen Git UI you can open from Source Control.",
    required: false,
    missingHint: "Optional. Lucy's own Source Control view does not need it.",
    versionArgs: version,
  },
  {
    id: "tmux",
    bin: "tmux",
    title: "tmux",
    purpose: "Lucy runs inside or outside tmux; nothing is configured for you.",
    required: false,
    missingHint: "Optional. Not needed by Lucy.",
    versionArgs: ["-V"],
  },
  {
    id: "fzf",
    bin: "fzf",
    title: "fzf",
    purpose: "Keeps working in the embedded terminal through your own shell setup.",
    required: false,
    missingHint: "Optional. Lucy has its own fuzzy finders.",
    versionArgs: version,
  },
  {
    id: "atuin",
    bin: "atuin",
    title: "Atuin",
    purpose: "Your shell history search keeps working in the embedded terminal (Ctrl+R reaches the shell).",
    required: false,
    missingHint: "Optional. Not needed by Lucy.",
    versionArgs: version,
  },
  {
    id: "zoxide",
    bin: "zoxide",
    title: "zoxide",
    purpose: "Keeps working in the embedded terminal through your own shell setup.",
    required: false,
    missingHint: "Optional. Not needed by Lucy.",
    versionArgs: version,
  },
];

export type ToolStatus = "checking" | "found" | "missing" | "error";
export type VersionStatus = "pending" | "ok" | "unknown" | "timeout" | "cancelled" | "error";

export interface ToolRow {
  readonly id: string;
  readonly title: string;
  readonly bin: string;
  readonly purpose: string;
  readonly required: boolean;
  readonly status: ToolStatus;
  readonly path: string | null;
  readonly version: string | null;
  readonly versionStatus: VersionStatus;
  /** Present for missing tools (the hint) and failures (what went wrong). */
  readonly note: string | null;
}

export interface TerminalCapabilities {
  readonly name: string;
  readonly truecolor: boolean;
  readonly kittyKeyboard: boolean;
  readonly mouse: boolean;
  readonly hyperlinks: boolean;
}

export interface CapabilityRow {
  readonly id: "truecolor" | "kittyKeyboard" | "mouse" | "hyperlinks";
  readonly title: string;
  readonly supported: boolean;
  /** What it means for Lucy either way. */
  readonly note: string;
}

export interface FeatureModule {
  readonly id: string;
  readonly title: string;
}

export interface IntegrationsState {
  readonly tools: readonly ToolRow[];
  readonly terminalName: string;
  readonly capabilities: readonly CapabilityRow[];
  readonly features: readonly FeatureModule[];
  readonly loading: boolean;
  readonly checkedAt: string | null;
}

export type ToolRunner = (argv: readonly string[], options: RunOptions) => Promise<RunResult>;

export interface IntegrationsModelOptions {
  terminal: TerminalCapabilities;
  features: readonly FeatureModule[];
  tools?: readonly ToolSpec[];
  /** Environment for the PATH lookup and the version commands. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Per-tool limit for printing a version. Default 2000 ms. */
  timeoutMs?: number;
  /** Process runner (the kernel's `run` by default). */
  runner?: ToolRunner;
  now?: () => Date;
}

/** Picks a version out of whatever a tool prints ("git version 2.43.0", "NVIM v0.10.0", "version=0.40.2"). */
export function parseVersion(output: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escape sequences.
  const text = output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  const labelled = /\bversion[=:\s]+v?(\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.]+)?)/i.exec(text);
  if (labelled?.[1]) return labelled[1];
  const generic = /(?:^|[^\w.])v?(\d+\.\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.]+)?)/.exec(text);
  return generic?.[1] ?? null;
}

function capabilityRows(terminal: TerminalCapabilities): CapabilityRow[] {
  return [
    {
      id: "truecolor",
      title: "24-bit color",
      supported: terminal.truecolor,
      note: terminal.truecolor
        ? "Themes show their exact colors."
        : "Themes are mapped to the 256 or 16 colors the terminal offers.",
    },
    {
      id: "kittyKeyboard",
      title: "Kitty keyboard protocol",
      supported: terminal.kittyKeyboard,
      note: terminal.kittyKeyboard
        ? "Shortcuts such as Ctrl+Shift+P work as written."
        : "Ctrl+Shift shortcuts use their fallbacks (F1, Ctrl+K and a letter).",
    },
    {
      id: "mouse",
      title: "Mouse",
      supported: terminal.mouse,
      note: terminal.mouse
        ? "Click, scroll and drag to resize panels."
        : "Everything is reachable from the keyboard.",
    },
    {
      id: "hyperlinks",
      title: "Hyperlinks",
      supported: terminal.hyperlinks,
      note: terminal.hyperlinks
        ? "Links in output can be opened directly."
        : "Links are shown as plain text.",
    },
  ];
}

function initialRow(spec: ToolSpec): ToolRow {
  return {
    id: spec.id,
    title: spec.title,
    bin: spec.bin,
    purpose: spec.purpose,
    required: spec.required,
    status: "checking",
    path: null,
    version: null,
    versionStatus: "pending",
    note: null,
  };
}

interface CachedVersion {
  stamp: string;
  version: string | null;
  versionStatus: VersionStatus;
}

export class IntegrationsModel implements Disposable {
  readonly store: Store<IntegrationsState>;
  private readonly tools: readonly ToolSpec[];
  private readonly env: Record<string, string | undefined>;
  private readonly timeoutMs: number;
  private readonly runner: ToolRunner;
  private readonly now: () => Date;
  /** Version results by executable path; reused while the file's size and mtime are unchanged. */
  private readonly cache = new Map<string, CachedVersion>();
  private controller: AbortController | undefined;
  private generation = 0;

  constructor(options: IntegrationsModelOptions) {
    this.tools = options.tools ?? INTEGRATION_TOOLS;
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? 2000;
    this.runner = options.runner ?? run;
    this.now = options.now ?? (() => new Date());
    this.store = new Store<IntegrationsState>({
      tools: this.tools.map(initialRow),
      terminalName: options.terminal.name,
      capabilities: capabilityRows(options.terminal),
      features: options.features,
      loading: false,
      checkedAt: null,
    });
  }

  get state(): IntegrationsState {
    return this.store.get();
  }

  /** Updates terminal capabilities reported later by the renderer. */
  setTerminal(terminal: TerminalCapabilities): void {
    this.store.set({
      ...this.store.get(),
      terminalName: terminal.name,
      capabilities: capabilityRows(terminal),
    });
  }

  private updateRow(id: string, partial: Partial<ToolRow>, generation: number): void {
    if (generation !== this.generation) return;
    const state = this.store.get();
    this.store.set({
      ...state,
      tools: state.tools.map((row) => (row.id === id ? { ...row, ...partial } : row)),
    });
  }

  /**
   * Looks every tool up on PATH and reads versions in parallel. Unchanged executables reuse
   * the cached version unless `force` is set. A new refresh cancels one still running.
   */
  async refresh(options: { force?: boolean } = {}): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const generation = ++this.generation;
    if (options.force) this.cache.clear();
    this.store.set({ ...this.store.get(), loading: true, tools: this.tools.map(initialRow) });
    await Promise.all(this.tools.map((spec) => this.check(spec, controller.signal, generation)));
    if (generation !== this.generation) return;
    this.store.set({ ...this.store.get(), loading: false, checkedAt: this.now().toISOString() });
    if (this.controller === controller) this.controller = undefined;
  }

  /** Stops a running refresh; rows still waiting for a version say so. */
  cancel(): void {
    if (!this.controller) return;
    this.controller.abort();
    this.controller = undefined;
    // Late results from the cancelled run are ignored from here on.
    this.generation++;
    const state = this.store.get();
    this.store.set({
      ...state,
      loading: false,
      tools: state.tools.map((row) =>
        row.status === "checking"
          ? { ...row, status: "error", note: "Check cancelled." }
          : row.versionStatus === "pending"
            ? { ...row, versionStatus: "cancelled" }
            : row,
      ),
    });
  }

  private async check(spec: ToolSpec, signal: AbortSignal, generation: number): Promise<void> {
    let path: string | null;
    try {
      path = which(spec.bin, this.env);
    } catch (error) {
      this.updateRow(spec.id, { status: "error", note: errorMessage(error) }, generation);
      return;
    }
    if (!path) {
      this.updateRow(
        spec.id,
        { status: "missing", versionStatus: "unknown", note: spec.missingHint },
        generation,
      );
      return;
    }
    this.updateRow(spec.id, { status: "found", path }, generation);

    let stamp = "";
    try {
      const info = await stat(path);
      stamp = `${info.size}:${info.mtimeMs}`;
    } catch {
      // Unreadable metadata only disables caching for this tool.
    }
    const cached = this.cache.get(path);
    if (cached && stamp !== "" && cached.stamp === stamp) {
      this.updateRow(spec.id, { version: cached.version, versionStatus: cached.versionStatus }, generation);
      return;
    }

    try {
      const result = await this.runner([path, ...spec.versionArgs], {
        timeoutMs: this.timeoutMs,
        signal,
        env: this.env,
        maxOutputBytes: 64 * 1024,
      });
      if (result.aborted) {
        this.updateRow(spec.id, { versionStatus: "cancelled" }, generation);
        return;
      }
      if (result.timedOut) {
        this.updateRow(
          spec.id,
          { versionStatus: "timeout", note: "The version check took too long." },
          generation,
        );
        return;
      }
      // Some tools print their version to stderr or exit non-zero; read whatever is there.
      const parsed = parseVersion(result.stdout) ?? parseVersion(result.stderr);
      const versionStatus: VersionStatus = parsed ? "ok" : "unknown";
      if (stamp !== "") this.cache.set(path, { stamp, version: parsed, versionStatus });
      this.updateRow(spec.id, { version: parsed, versionStatus }, generation);
    } catch (error) {
      this.updateRow(
        spec.id,
        { versionStatus: "error", note: `Could not run ${spec.bin}: ${errorMessage(error)}` },
        generation,
      );
    }
  }

  dispose(): void {
    this.controller?.abort();
    this.controller = undefined;
    this.generation++;
  }
}
