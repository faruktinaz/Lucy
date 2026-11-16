/**
 * Chords and key sequences.
 *
 * Canonical chord string: modifiers in the fixed order `ctrl+alt+shift+super+<key>`, then
 * the key. Named keys are lowercase words (`enter`, `pageup`, `f5`, `plus` for "+",
 * `space`); any other key is the single character it types (`p`, `/`, `?`, `ş`).
 *
 * Letters are case-insensitive and shift is always written explicitly: `Ctrl+P` is `ctrl+p`
 * and Shift+P is `shift+p`, as in VS Code. Shifted punctuation can be written either as the
 * character (`?`) or as the base key with shift (`shift+/`); see `key-stroke.ts` for how
 * each form is matched. A sequence is up to two chords separated by a space: `ctrl+k ctrl+s`.
 */
import { LucyError } from "../errors";

export interface Chord {
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly super: boolean;
  /** Canonical key: a named key or a single (lowercase, for letters) character. */
  readonly key: string;
}

export type KeySequence = readonly Chord[];

export const MAX_SEQUENCE_LENGTH = 2;

const FUNCTION_KEYS = Array.from({ length: 12 }, (_, i) => `f${i + 1}`);

export const NAMED_KEYS: readonly string[] = [
  "enter",
  "escape",
  "tab",
  "space",
  "backspace",
  "delete",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "insert",
  "plus",
  ...FUNCTION_KEYS,
];

const NAMED = new Set(NAMED_KEYS);

const KEY_ALIASES: Readonly<Record<string, string>> = {
  return: "enter",
  esc: "escape",
  del: "delete",
  ins: "insert",
  pgup: "pageup",
  pgdn: "pagedown",
  pagedn: "pagedown",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  spacebar: "space",
  " ": "space",
  "+": "plus",
};

type Modifier = "ctrl" | "alt" | "shift" | "super";

const MODIFIER_ALIASES: Readonly<Record<string, Modifier>> = {
  ctrl: "ctrl",
  control: "ctrl",
  ctl: "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  meta: "alt",
  shift: "shift",
  super: "super",
  cmd: "super",
  command: "super",
  win: "super",
  windows: "super",
};

export type ChordParseErrorReason =
  | "empty"
  | "missing-key"
  | "unknown-modifier"
  | "duplicate-modifier"
  | "invalid-key"
  | "too-many-chords";

export class ChordParseError extends LucyError {
  readonly reason: ChordParseErrorReason;
  readonly input: string;

  constructor(reason: ChordParseErrorReason, input: string, message: string) {
    super("INVALID_ARGUMENT", message, { details: { reason, input } });
    this.name = "ChordParseError";
    this.reason = reason;
    this.input = input;
  }
}

let segmenter: Intl.Segmenter | undefined;

function graphemeCount(text: string): number {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let count = 0;
  for (const _ of segmenter.segment(text)) count++;
  return count;
}

/** True for letters that have distinct upper and lower case forms. */
export function isCasedLetter(char: string): boolean {
  return /^\p{L}$/u.test(char) && (char.toLowerCase() !== char || char.toUpperCase() !== char);
}

/**
 * Lowercases a key character without locale surprises: `İ` (Turkish capital dotted I)
 * becomes `i`, not `i̇` (i plus a combining dot), and `I` becomes `i`.
 */
export function lowerKey(char: string): string {
  if (char === "İ" || char === "I") return "i";
  return char.toLowerCase();
}

/** True when `char` is an uppercase or titlecase letter. */
export function isUpperLetter(char: string): boolean {
  return isCasedLetter(char) && lowerKey(char) !== char;
}

/**
 * Canonicalizes a key name or character. Returns `undefined` if it is neither a named key
 * nor a single printable character.
 */
export function normalizeKey(token: string): string | undefined {
  const lower = token.toLowerCase();
  const alias = KEY_ALIASES[token] ?? KEY_ALIASES[lower];
  if (alias) return alias;
  if (NAMED.has(lower)) return lower;
  if (token.length === 0 || graphemeCount(token) !== 1) return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
  if (/^[\s\u0000-\u001f\u007f-\u009f]$/u.test(token)) return undefined;
  return isCasedLetter(token) ? lowerKey(token) : token;
}

export function isNamedKey(key: string): boolean {
  return NAMED.has(key);
}

/** Parses one chord such as `Ctrl+Shift+P`, `cmd+plus` or `?`. */
export function parseChord(input: string): Chord {
  const text = input.trim();
  if (text === "") throw new ChordParseError("empty", input, "Empty shortcut");

  let keyToken: string;
  let modifierTokens: string[];
  if (text === "+") {
    keyToken = "+";
    modifierTokens = [];
  } else if (text.endsWith("++")) {
    keyToken = "+";
    modifierTokens = text.slice(0, -2).split("+");
  } else {
    const parts = text.split("+");
    keyToken = parts.pop() ?? "";
    modifierTokens = parts;
  }
  if (keyToken.trim() === "") {
    throw new ChordParseError("missing-key", input, `Shortcut "${input}" has no key after the modifiers`);
  }

  const mods: Record<Modifier, boolean> = { ctrl: false, alt: false, shift: false, super: false };
  for (const token of modifierTokens) {
    const modifier = MODIFIER_ALIASES[token.trim().toLowerCase()];
    if (!modifier) {
      throw new ChordParseError("unknown-modifier", input, `Unknown modifier "${token}" in "${input}"`);
    }
    if (mods[modifier]) {
      throw new ChordParseError(
        "duplicate-modifier",
        input,
        `Modifier "${modifier}" appears twice in "${input}"`,
      );
    }
    mods[modifier] = true;
  }

  const key = normalizeKey(keyToken.trim());
  if (!key) throw new ChordParseError("invalid-key", input, `Unknown key "${keyToken}" in "${input}"`);
  return { ...mods, key };
}

/** Parses `ctrl+k ctrl+s` (one or two chords separated by whitespace). */
export function parseKeySequence(input: string): KeySequence {
  const parts = input.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new ChordParseError("empty", input, "Empty shortcut");
  if (parts.length > MAX_SEQUENCE_LENGTH) {
    throw new ChordParseError(
      "too-many-chords",
      input,
      `"${input}" has more than ${MAX_SEQUENCE_LENGTH} steps`,
    );
  }
  return parts.map(parseChord);
}

/** Non-throwing variant for user input. */
export function tryParseKeySequence(
  input: string,
): { ok: true; sequence: KeySequence } | { ok: false; error: ChordParseError } {
  try {
    return { ok: true, sequence: parseKeySequence(input) };
  } catch (error) {
    if (error instanceof ChordParseError) return { ok: false, error };
    throw error;
  }
}

export function chordToString(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push("ctrl");
  if (chord.alt) parts.push("alt");
  if (chord.shift) parts.push("shift");
  if (chord.super) parts.push("super");
  parts.push(chord.key);
  return parts.join("+");
}

export function sequenceToString(sequence: KeySequence): string {
  return sequence.map(chordToString).join(" ");
}

/** Canonical spelling of a user-written shortcut: `Cmd+Shift+P` becomes `shift+super+p`. */
export function normalizeKeySequence(input: string): string {
  return sequenceToString(parseKeySequence(input));
}

export function chordsEqual(a: Chord, b: Chord): boolean {
  return (
    a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.super === b.super && a.key === b.key
  );
}

export type ChordFormatStyle = "mac" | "text";

const MAC_KEYS: Readonly<Record<string, string>> = {
  enter: "↩",
  escape: "⎋",
  tab: "⇥",
  space: "Space",
  backspace: "⌫",
  delete: "⌦",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  home: "Home",
  end: "End",
  pageup: "PgUp",
  pagedown: "PgDn",
  insert: "Ins",
  plus: "+",
};

const TEXT_KEYS: Readonly<Record<string, string>> = {
  enter: "Enter",
  escape: "Esc",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  insert: "Insert",
  plus: "Plus",
};

function keyLabel(key: string, table: Readonly<Record<string, string>>): string {
  const named = table[key];
  if (named) return named;
  if (/^f\d{1,2}$/.test(key)) return key.toUpperCase();
  // Keycaps show capitals; dotless ı stays as is so it is not mistaken for i.
  if (key === "ı") return key;
  return isCasedLetter(key) ? key.toUpperCase() : key;
}

export interface FormatOptions {
  /** Text style names Option and Cmd on macOS. Defaults to the current platform. */
  platform?: string;
}

/**
 * Display form of a chord or sequence. `mac` uses the macOS symbols in their conventional
 * order (`⌃⌥⇧⌘`): `⌃⇧P`, `⌃K ⌃S`. `text` uses words: `Ctrl+Shift+P`, `Ctrl+K Ctrl+S`.
 */
export function formatChord(
  input: Chord | KeySequence | string,
  style: ChordFormatStyle,
  options: FormatOptions = {},
): string {
  const sequence: KeySequence =
    typeof input === "string"
      ? parseKeySequence(input)
      : "key" in input
        ? [input as Chord]
        : (input as KeySequence);
  const mac = (options.platform ?? process.platform) === "darwin";
  return sequence
    .map((chord) => {
      if (style === "mac") {
        return `${chord.ctrl ? "⌃" : ""}${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${chord.super ? "⌘" : ""}${keyLabel(chord.key, MAC_KEYS)}`;
      }
      const parts: string[] = [];
      if (chord.ctrl) parts.push("Ctrl");
      if (chord.alt) parts.push(mac ? "Option" : "Alt");
      if (chord.shift) parts.push("Shift");
      if (chord.super) parts.push(mac ? "Cmd" : "Super");
      parts.push(keyLabel(chord.key, TEXT_KEYS));
      return parts.join("+");
    })
    .join(" ");
}
