/**
 * Environment for processes running inside Lucy's embedded terminal.
 *
 * The child inherits the user's environment unchanged (PATH, auth tokens, SSH agent, shims such
 * as cmux's `claude` wrapper), so CLIs keep their credentials and permissions. Only two kinds of
 * variables are touched:
 *
 * - Terminal capability: `TERM=xterm-256color` and `COLORTERM=truecolor` describe what the
 *   embedded emulator (libghostty-vt inside OpenTUI) actually implements.
 * - Terminal identity: variables set by the *outer* emulator or multiplexer (Ghostty, iTerm2,
 *   kitty, tmux, ...) are removed, because inside Lucy they are false. A program that sees
 *   `TERM_PROGRAM=ghostty` or `TMUX` would emit sequences for a terminal it is not talking to.
 *   Lucy identifies itself honestly with `TERM_PROGRAM=lucy`, the convention tmux follows.
 *
 * Multiplexer *integration* variables that are not about the tty (for example `CMUX_*`, which the
 * user's agent shims rely on) are kept on purpose.
 */

type Env = Record<string, string | undefined>;

/** Exact names of outer-terminal identity variables that are removed. */
export const OUTER_TERMINAL_IDENTITY_VARIABLES: readonly string[] = [
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERM_SESSION_ID",
  "LC_TERMINAL",
  "LC_TERMINAL_VERSION",
  "VTE_VERSION",
  "WT_SESSION",
  "WT_PROFILE_ID",
  "TERMINAL_EMULATOR",
  "TERMINATOR_UUID",
  "TILIX_ID",
  "GNOME_TERMINAL_SCREEN",
  "GNOME_TERMINAL_SERVICE",
  "WARP_IS_LOCAL_SHELL_SESSION",
  // Multiplexers: the child's tty is Lucy's PTY, not a tmux/screen/zellij pane.
  "TMUX",
  "TMUX_PANE",
  "STY",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ_PANE_ID",
  // Stale sizes would override the PTY's real window size in programs that read them first.
  "COLUMNS",
  "LINES",
];

/** Prefixes of emulator-specific identity variables that are removed. */
export const OUTER_TERMINAL_IDENTITY_PREFIXES: readonly string[] = [
  "GHOSTTY_",
  "ITERM_",
  "KITTY_",
  "WEZTERM_",
  "ALACRITTY_",
  "KONSOLE_",
];

export interface PtyEnvOptions {
  /** Environment to inherit. Defaults to `process.env`. */
  base?: Env;
  /** How Lucy identifies itself in `TERM_PROGRAM`. `null` leaves `TERM_PROGRAM` unset. */
  termProgram?: { name: string; version?: string } | null;
  /** Applied last, so callers can override anything. A value of `undefined` removes the variable. */
  overrides?: Env;
}

export function isOuterTerminalIdentityVariable(name: string): boolean {
  return (
    OUTER_TERMINAL_IDENTITY_VARIABLES.includes(name) ||
    OUTER_TERMINAL_IDENTITY_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/** Builds the complete environment for a PTY child. Pure: never mutates its inputs. */
export function buildPtyEnv(options: PtyEnvOptions = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.base ?? process.env)) {
    if (value === undefined || isOuterTerminalIdentityVariable(key)) continue;
    env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  const program = options.termProgram === undefined ? { name: "lucy" } : options.termProgram;
  if (program) {
    env.TERM_PROGRAM = program.name;
    if (program.version) env.TERM_PROGRAM_VERSION = program.version;
  }
  for (const [key, value] of Object.entries(options.overrides ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}
