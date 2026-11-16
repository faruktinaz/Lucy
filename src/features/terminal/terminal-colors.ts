/**
 * Theme and memory settings for embedded terminals.
 *
 * The emulator (libghostty-vt) starts with white-on-black defaults and its own 16-colour
 * palette. Writing OSC colour commands into the emulator itself (never into the PTY) makes the
 * terminal follow the Lucy theme, and makes programs that ask for the background (OSC 11, used
 * for light/dark detection) see the theme's colour (docs/dev/PTY_NOTES.md §5.1).
 */
import type { TerminalPalette } from "@/ui/theme/ui-theme";

const ST = "\x1b\\";

/** `#rrggbb` -> `rgb:rr/gg/bb`, the X11 form OSC colour commands accept. */
function x11Color(hex: string): string | null {
  const match = /^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})/.exec(hex.trim());
  if (!match) return null;
  return `rgb:${match[1]}/${match[2]}/${match[3]}`.toLowerCase();
}

/**
 * Escape sequences that set the emulator's default foreground (OSC 10), background (OSC 11),
 * cursor (OSC 12) and the 16 ANSI colours (OSC 4). Invalid values are skipped.
 */
export function terminalColorPrelude(palette: TerminalPalette): string {
  let out = "";
  const set = (code: string, hex: string) => {
    const color = x11Color(hex);
    if (color) out += `\x1b]${code};${color}${ST}`;
  };
  set("10", palette.foreground);
  set("11", palette.background);
  set("12", palette.cursor);
  palette.ansi.slice(0, 16).forEach((hex, index) => {
    set(`4;${index}`, hex);
  });
  return out;
}

/**
 * `terminal.scrollback` is in lines; the emulator limits scrollback in bytes of page memory
 * (measured ~1.5 KB per 160-column row, PTY_NOTES §5.7). Sized for rows up to 160 columns, so
 * wider terminals keep somewhat fewer lines. Memory is used only as history grows.
 */
export function scrollbackBytes(lines: number): number {
  const safeLines = Number.isFinite(lines) ? Math.max(100, Math.floor(lines)) : 5000;
  return Math.min(256 * 1024 * 1024, Math.max(512 * 1024, safeLines * 1600));
}

/** What to do with a paste the terminal received from the outer terminal. */
export type PastePlan =
  /** Let the emulator encode it as usual (bracketed, or text without line breaks). */
  | { kind: "default" }
  /** One line plus a trailing line break: paste it without the break, so it does not run. */
  | { kind: "paste"; text: string }
  /** Several lines into a program without bracketed paste: confirm first. */
  | { kind: "confirm"; text: string; lines: number };

/**
 * Without bracketed paste every line break acts as Enter as soon as it arrives, so a pasted
 * line would run without the user pressing Enter, and several lines run one after another.
 * Single lines are pasted without their trailing break; multi-line text needs a confirmation.
 */
export function planPaste(bytes: Uint8Array, bracketedPaste: boolean): PastePlan {
  if (bracketedPaste) return { kind: "default" };
  if (!bytes.includes(0x0a) && !bytes.includes(0x0d)) return { kind: "default" };
  const text = new TextDecoder().decode(bytes);
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n").length;
  return lines > 1 ? { kind: "confirm", text, lines } : { kind: "paste", text };
}
