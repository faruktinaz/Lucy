/**
 * What terminals can actually deliver. A chord that looks fine in a config file may never
 * reach the app: legacy terminal input encodes Ctrl+letter as a single control byte, has no
 * way to report Shift together with Ctrl, sends Ctrl+M as Enter, and so on. The kitty
 * keyboard protocol fixes most of this, but not everywhere, and not over every SSH hop.
 *
 * `chordSupport` explains, per chord, whether it can work and why not. The remap UI uses it
 * to warn, the docs list it, and `commandsWithoutLegacySafeBinding` checks that every default
 * command has at least one chord that works in a plain legacy terminal on macOS without
 * "Option as Alt", the most restrictive common setup.
 */
import { type Chord, type KeySequence, parseKeySequence } from "./chord";

export type SupportSeverity =
  /** Works at the byte level but has an established meaning users rely on. Do not bind. */
  | "reserved"
  /** Cannot be distinguished or delivered in this setup. */
  | "unsupported"
  /** Works only with particular terminal settings. */
  | "conditional";

export type ChordSupport =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly severity: SupportSeverity;
      readonly code: string;
      readonly reason: string;
    };

export interface ChordSupportOptions {
  /** The terminal speaks the kitty keyboard protocol (and the app enabled it). */
  kittyKeyboard: boolean;
  /** Platform the terminal runs on. Defaults to the current one. */
  platform?: string;
  /** macOS terminal is set to send Option as Alt/Meta. Default false. */
  optionAsAlt?: boolean;
}

/** The strictest common setup, used to decide whether a chord is "legacy-safe". */
export const LEGACY_SAFE_OPTIONS: ChordSupportOptions = {
  kittyKeyboard: false,
  platform: "darwin",
  optionAsAlt: false,
};

const OK: ChordSupport = { ok: true };

function issue(severity: SupportSeverity, code: string, reason: string): ChordSupport {
  return { ok: false, severity, code, reason };
}

const LEGACY_CONTROL_ALIASES: Readonly<Record<string, string>> = {
  m: "Enter",
  i: "Tab",
  "[": "Escape",
  h: "Backspace",
  j: "Enter (line feed)",
};

/** Ctrl+punctuation that legacy terminals encode as a distinct control byte. */
const LEGACY_CTRL_PUNCTUATION = new Set(["]", "\\", "^", "_", "@", "/"]);

const ONLY_PLAIN_OR_ALT = new Set(["enter", "tab", "backspace", "escape", "space"]);

function isAsciiLetter(key: string): boolean {
  return /^[a-z]$/.test(key);
}

function isDigit(key: string): boolean {
  return /^[0-9]$/.test(key);
}

function isPrintable(key: string): boolean {
  return [...key].length === 1 || key === "plus";
}

/** Whether a single chord can be delivered, and if not, why. */
export function chordSupport(input: Chord | string, options: ChordSupportOptions): ChordSupport {
  const chord: Chord = typeof input === "string" ? (parseKeySequence(input)[0] as Chord) : input;
  const kitty = options.kittyKeyboard;
  const platform = options.platform ?? process.platform;
  const { ctrl, alt, shift, key } = chord;
  const onlyCtrl = ctrl && !alt && !shift && !chord.super;

  if (chord.super) {
    return kitty
      ? issue(
          "conditional",
          "super-terminal-shortcut",
          "Cmd/Super shortcuts are usually taken by the terminal application (copy, paste, new tab) before Lucy sees them.",
        )
      : issue(
          "unsupported",
          "super-legacy",
          "Terminals only report Cmd/Super to programs with the kitty keyboard protocol.",
        );
  }

  if (onlyCtrl && key === "c") {
    return issue(
      "reserved",
      "interrupt",
      "Ctrl+C is the interrupt key; users expect it to cancel and stop programs.",
    );
  }
  if (onlyCtrl && key === "z") {
    return issue("reserved", "suspend", "Ctrl+Z suspends the running program in a shell.");
  }
  if (onlyCtrl && (key === "s" || key === "q")) {
    return issue(
      "conditional",
      "flow-control",
      `Ctrl+${key.toUpperCase()} is terminal flow control (XOFF/XON); with flow control enabled it freezes or resumes output instead of reaching Lucy.`,
    );
  }
  if (onlyCtrl && key === "\\") {
    return issue("conditional", "quit-signal", "Ctrl+\\ sends SIGQUIT to programs in a shell.");
  }

  if (!kitty && ctrl && !alt && !shift) {
    const alias = LEGACY_CONTROL_ALIASES[key];
    if (alias) {
      return issue(
        "unsupported",
        "legacy-alias",
        `Without the kitty keyboard protocol Ctrl+${key.toUpperCase()} sends the same code as ${alias}.`,
      );
    }
  }

  if (!kitty && ctrl && shift && isAsciiLetter(key)) {
    return issue(
      "unsupported",
      "ctrl-shift-letter",
      `Without the kitty keyboard protocol Ctrl+Shift+${key.toUpperCase()} is indistinguishable from Ctrl+${key.toUpperCase()}.`,
    );
  }

  if (!kitty && ctrl && isDigit(key)) {
    return issue(
      "unsupported",
      "ctrl-digit",
      "Without the kitty keyboard protocol Ctrl+digit sends nothing or another control code in most terminals, and numpad digits differ from the top row.",
    );
  }

  if (!kitty && ctrl && isPrintable(key) && !isAsciiLetter(key) && !isDigit(key)) {
    if (/^[\x20-\x7e]$/.test(key) || key === "plus") {
      if (!LEGACY_CTRL_PUNCTUATION.has(key) && key !== "[") {
        return issue(
          "unsupported",
          "ctrl-punctuation",
          `Without the kitty keyboard protocol there is no control code for Ctrl+${key === "plus" ? "+" : key}; most terminals send the plain character or nothing.`,
        );
      }
    } else {
      return issue(
        "unsupported",
        "ctrl-non-ascii",
        `Without the kitty keyboard protocol control combinations exist only for ASCII keys, not "${key}".`,
      );
    }
  }

  if (!kitty && shift && !ctrl && !alt && isPrintable(key) && !/^\p{L}$/u.test(key)) {
    return issue(
      "unsupported",
      "shift-punctuation",
      `Legacy terminals send only the resulting character for Shift+${key}; bind the character itself (for example "?" instead of "shift+/").`,
    );
  }

  if (!kitty && ONLY_PLAIN_OR_ALT.has(key) && (ctrl || shift)) {
    const legacyOk = (key === "tab" && shift && !ctrl) || (key === "space" && ctrl && !shift);
    if (!legacyOk) {
      return issue(
        "unsupported",
        "modified-special-key",
        "Without the kitty keyboard protocol this modifier combination with Enter, Tab, Backspace, Escape or Space is not reported.",
      );
    }
  }

  if (alt && platform === "darwin" && !options.optionAsAlt) {
    return issue(
      "conditional",
      "mac-option",
      'On macOS, Option types characters unless the terminal is set to use Option as Alt/Meta (on a Turkish Q layout Option+Q types "@").',
    );
  }

  return OK;
}

/** Support for a whole sequence: the first chord that cannot work, or ok. */
export function sequenceSupport(input: KeySequence | string, options: ChordSupportOptions): ChordSupport {
  const sequence = typeof input === "string" ? parseKeySequence(input) : input;
  for (const chord of sequence) {
    const support = chordSupport(chord, options);
    if (!support.ok) return support;
  }
  return OK;
}

/** True when the sequence works in a plain legacy terminal on macOS without Option as Alt. */
export function isLegacySafe(input: KeySequence | string): boolean {
  return sequenceSupport(input, LEGACY_SAFE_OPTIONS).ok;
}

/**
 * Commands among `bindings` that have no legacy-safe chord. An empty result means every
 * command stays reachable from the keyboard in any terminal. `commands` restricts the check
 * (for example to the "important" set).
 */
export function commandsWithoutLegacySafeBinding(
  bindings: readonly { command: string; keys: readonly string[] }[],
  commands?: readonly string[],
): string[] {
  const safe = new Set<string>();
  const all = new Set<string>();
  for (const binding of bindings) {
    all.add(binding.command);
    if (binding.keys.some((key) => isLegacySafe(key))) safe.add(binding.command);
  }
  return [...(commands ?? all)].filter((command) => !safe.has(command));
}
