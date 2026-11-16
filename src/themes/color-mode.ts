/**
 * Terminal color capability detection.
 *
 * Only the standard environment variables are consulted (`NO_COLOR`, `COLORTERM`, `TERM`);
 * there are deliberately no per-application special cases (`TERM_PROGRAM` and friends),
 * because those go stale and break inside multiplexers and over SSH. Terminals that support
 * truecolor advertise it with `COLORTERM=truecolor`; users of terminals that do not can set
 * `ui.color_mode` explicitly.
 */
import type { ColorMode } from "./ids";

export type ColorModeSetting = "auto" | ColorMode;

type Env = Record<string, string | undefined>;

/**
 * Detects the color capability from the environment.
 *
 * `NO_COLOR` (any non-empty value, per no-color.org) selects the 16-color mode: Lucy then
 * draws only with the terminal's own 16 ANSI colors, so the user's terminal theme decides
 * every color on screen. A full-screen UI cannot drop color entirely without losing
 * selection, focus and diff states, so this is the closest faithful reading of the request.
 * An explicit `ui.color_mode` in the config file takes precedence over `NO_COLOR`, as the
 * convention recommends.
 */
export function detectColorMode(env: Env = process.env): ColorMode {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "16";
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  const term = (env.TERM ?? "").toLowerCase();
  if (term === "" || term === "dumb") return "16";
  if (term.endsWith("-direct") || term.includes("truecolor") || term.includes("24bit")) return "truecolor";
  if (term.includes("256color")) return "256";
  return "16";
}

/** Applies the `ui.color_mode` setting: explicit values win, `auto` detects. */
export function resolveColorMode(setting: ColorModeSetting, env: Env = process.env): ColorMode {
  return setting === "auto" ? detectColorMode(env) : setting;
}
