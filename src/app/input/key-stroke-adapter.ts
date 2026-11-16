/**
 * OpenTUI key event -> `KeyStroke`, following the contract at the top of
 * `src/core/keybindings/key-stroke.ts`.
 *
 * What OpenTUI 0.9.1 reports (verified, see docs/dev/OPENTUI_NOTES.md §4):
 * - `name` is the unshifted key for letters (`a` with `shift` for "A"), the character itself
 *   for punctuation and non-Latin letters (`?`, `ş`, `İ`), or a key name (`return`, `f5`,
 *   `kp1`, `space`).
 * - `sequence` is the produced text for printable keys (kitty "associated"/shifted key, or the
 *   legacy byte), and the raw escape sequence or control byte otherwise.
 * - `meta` and `option` both mean Alt. `baseCode` is kitty's base-layout key, when reported.
 */
import type { KeyEvent } from "@opentui/core";
import { isNamedKey, normalizeKey } from "@/core/keybindings";
import type { KeyStroke } from "@/core/keybindings/key-stroke";

/** Key names OpenTUI uses that differ from the canonical chord names. */
const NAME_MAP: Readonly<Record<string, string>> = {
  return: "enter",
  linefeed: "enter",
  kpenter: "enter",
  esc: "escape",
  kpdecimal: ".",
  kpdivide: "/",
  kpmultiply: "*",
  kpsubtract: "-",
  kpadd: "plus",
  kpequal: "=",
  kpseparator: ",",
  kpup: "up",
  kpdown: "down",
  kpleft: "left",
  kpright: "right",
  kphome: "home",
  kpend: "end",
  kppageup: "pageup",
  kppagedown: "pagedown",
  kpinsert: "insert",
  kpdelete: "delete",
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: control bytes are exactly what must be excluded.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

let segmenter: Intl.Segmenter | undefined;

function isSinglePrintable(text: string): boolean {
  if (text.length === 0 || CONTROL.test(text)) return false;
  if (text.length === 1) return true;
  // One grapheme: a letter with a combining mark still counts.
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let count = 0;
  for (const _ of segmenter.segment(text)) if (++count > 1) return false;
  return count === 1;
}

function canonicalName(name: string): string | undefined {
  const lower = name.toLowerCase();
  const mapped = NAME_MAP[lower];
  if (mapped) return mapped;
  const digit = /^kp([0-9])$/.exec(lower);
  if (digit) return digit[1];
  const normalized = normalizeKey(lower);
  if (normalized !== undefined && isNamedKey(normalized)) return normalized;
  return undefined;
}

/**
 * Converts a key event. Returns null for events that are not key presses we can name
 * (releases, modifier-only presses, unknown functional keys beyond F12).
 */
export function toKeyStroke(
  event: Pick<
    KeyEvent,
    "name" | "ctrl" | "meta" | "option" | "shift" | "super" | "sequence" | "eventType" | "baseCode"
  >,
): KeyStroke | null {
  if (event.eventType === "release") return null;
  const name = event.name ?? "";
  const modifiers = {
    ctrl: event.ctrl === true,
    alt: event.meta === true || event.option === true,
    shift: event.shift === true,
    super: event.super === true,
  };
  const baseKey =
    event.baseCode !== undefined && event.baseCode > 0x20 && event.baseCode < 0x110000
      ? String.fromCodePoint(event.baseCode)
      : undefined;

  const named = canonicalName(name);
  if (named !== undefined && named !== "space" && named.length > 1) {
    return { key: named, ...modifiers, baseKey: baseKey ? (normalizeKey(baseKey) ?? baseKey) : undefined };
  }
  if (named === "space" || name === " ") {
    return { key: "space", ...modifiers };
  }

  // Printable: prefer the produced text (`sequence`) when it is one printable grapheme.
  const sequence = event.sequence ?? "";
  const produced = isSinglePrintable(sequence) ? sequence : undefined;
  // Legacy terminals report Shift+letter as the uppercase character; the contract expects the
  // produced character there and lets the registry make shift explicit.
  const key = produced ?? (named !== undefined ? named : name);
  // Unknown multi-character names (modifier keys, media keys) are not bindable.
  if (!isSinglePrintable(key)) return null;
  const stroke: KeyStroke = { key, ...modifiers };
  if (produced !== undefined) stroke.text = produced;
  if (baseKey !== undefined) stroke.baseKey = normalizeKey(baseKey) ?? baseKey;
  return stroke;
}
