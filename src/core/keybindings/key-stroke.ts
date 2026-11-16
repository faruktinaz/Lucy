/**
 * The input side of keybindings: what one key press looks like, and which canonical chords
 * it can match.
 *
 * ## Contract for the UI adapter (terminal key event -> KeyStroke)
 *
 * - `key`: for named keys, the canonical name (`enter`, `escape`, `tab`, `backspace`,
 *   `delete`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`, `insert`,
 *   `f1`..`f12`, `space`); common aliases (`return`, `esc`, `pgup`) are accepted too. For a
 *   printable key, the character the key PRODUCED, after shift and keyboard layout, when the
 *   terminal reports it: `?` for Shift+/, `A` for Shift+A, `Ş` for Shift+ş, `@` for Option+Q
 *   on a Turkish Q layout when Option is not Alt. Legacy terminals only ever report this.
 *   With the kitty protocol, use the "shifted key" (alternate keys flag) or the associated
 *   text. Only if neither is available may `key` be the unshifted character with
 *   `shift: true`; letters are then still matched correctly, punctuation may not be.
 * - `ctrl`, `alt`, `shift`, `super`: modifiers as reported. Legacy terminals cannot report
 *   shift with ctrl+letter, and report Alt as an ESC prefix (map it to `alt`). OpenTUI's
 *   `meta`/`option` flags mean `alt`.
 * - `text`: the text the key inserts, if the terminal reports it (kitty "associated text").
 *   When present and a single printable character, it is preferred over `key` as the
 *   produced character.
 * - `baseKey`: the key in the standard (US) layout position, unshifted, when the terminal
 *   reports it (kitty "base layout key"): `/` for the key that types `?` with shift, `c`
 *   for the key that types Cyrillic `с`. Leave it undefined otherwise; never guess it.
 *
 * ## Matching rule for shifted printable characters
 *
 * Letters are matched case-insensitively with shift made explicit, so `shift+a` matches
 * both legacy `A` and kitty `a`+shift (caps lock is indistinguishable from shift in legacy
 * terminals). For punctuation, a binding written as the character (`?`) matches whatever
 * produced that character; shift is implied by the character and ignored. A binding written
 * as base key plus shift (`shift+/`) matches only when the terminal reports the base key
 * (`baseKey`), because the shifted character of a key depends on the layout. Turkish
 * letters follow the same rule; `I` is ambiguous between Shift+i (US) and Shift+ı
 * (Turkish), so it matches `shift+i` first and then `shift+ı`, and `İ` matches `shift+i`.
 */
import { type Chord, isCasedLetter, isNamedKey, isUpperLetter, lowerKey, normalizeKey } from "./chord";

export interface KeyStroke {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  super: boolean;
  text?: string;
  baseKey?: string;
}

/**
 * `character`: match the character a key types on the active layout (default).
 * `physical`: match the key's US-layout position via `baseKey` when the terminal reports it,
 * falling back to the character otherwise. Useful on non-Latin layouts.
 */
export type KeybindingMode = "character" | "physical";

/** Builds a stroke with all modifiers off unless given. Convenient for tests and adapters. */
export function keyStroke(key: string, modifiers: Partial<Omit<KeyStroke, "key">> = {}): KeyStroke {
  return { key, ctrl: false, alt: false, shift: false, super: false, ...modifiers };
}

/** `plus` is spelled as a name only because "+" separates modifiers; it types a character. */
function isPrintableNamed(key: string): boolean {
  return key === "plus";
}

function isSinglePrintable(text: string | undefined): text is string {
  if (text === undefined || text.length === 0 || text === " ") return false;
  const key = normalizeKey(text);
  return key !== undefined && (!isNamedKey(key) || isPrintableNamed(key));
}

/** Variants of a produced letter: `I` is Shift+i on US layouts but Shift+ı on Turkish ones. */
function letterKeys(char: string): string[] {
  return char === "I" ? ["i", "ı"] : [lowerKey(char)];
}

function characterCandidates(stroke: KeyStroke): Chord[] {
  const mods = { ctrl: stroke.ctrl, alt: stroke.alt, super: stroke.super };
  const named = normalizeKey(stroke.key);
  if (named !== undefined && isNamedKey(named) && !isPrintableNamed(named)) {
    return [{ ...mods, shift: stroke.shift, key: named }];
  }

  const produced = isSinglePrintable(stroke.text) ? stroke.text : stroke.key;
  if (isCasedLetter(produced)) {
    const shift = stroke.shift || isUpperLetter(produced);
    return letterKeys(produced).map((key) => ({ ...mods, shift, key }));
  }
  const key = normalizeKey(produced) ?? produced;
  const out: Chord[] = [];
  // When `key` may be the unshifted character (no text reported), an explicit shift+<key>
  // binding is the more specific reading and is tried first.
  if (stroke.shift && !isSinglePrintable(stroke.text)) out.push({ ...mods, shift: true, key });
  // The produced character implies shift: `?` matches however it was typed.
  out.push({ ...mods, shift: false, key });
  return out;
}

function baseKeyCandidate(stroke: KeyStroke): Chord | undefined {
  if (stroke.baseKey === undefined) return undefined;
  const key = normalizeKey(stroke.baseKey);
  if (key === undefined) return undefined;
  return { ctrl: stroke.ctrl, alt: stroke.alt, super: stroke.super, shift: stroke.shift, key };
}

/**
 * The canonical chords a stroke can match, most specific first. The registry takes the
 * first candidate that has a binding.
 */
export function strokeCandidates(stroke: KeyStroke, mode: KeybindingMode = "character"): Chord[] {
  const base = baseKeyCandidate(stroke);
  const ordered: Chord[] = [];
  if (mode === "physical" && base) ordered.push(base);
  ordered.push(...characterCandidates(stroke));
  // `shift+/` style bindings need the base key; only meaningful with shift held.
  if (mode === "character" && base && stroke.shift) ordered.push(base);
  const seen = new Set<string>();
  return ordered.filter((chord) => {
    const id = `${chord.ctrl}${chord.alt}${chord.shift}${chord.super}${chord.key}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * True when the stroke types text: a printable key without ctrl, alt or super. While an
 * input has focus such strokes never trigger bindings.
 */
export function isTypingStroke(stroke: KeyStroke): boolean {
  if (stroke.ctrl || stroke.alt || stroke.super) return false;
  const named = normalizeKey(stroke.key);
  if (named === "space" || (named !== undefined && isPrintableNamed(named))) return true;
  if (named !== undefined && isNamedKey(named)) return false;
  return true;
}
