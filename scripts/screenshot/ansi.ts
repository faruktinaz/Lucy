/**
 * CapturedFrame -> ANSI text with truecolor escapes, for a quick look with `cat` in a terminal.
 *
 * It reproduces the SGR stream OpenTUI itself writes: transparent and `default` colors map to the
 * terminal's own defaults (39/49), indexed colors stay indexed (so they follow the viewer's
 * palette), and attributes are passed through, inverse included.
 */
import { Attr, type Frame, type FrameColor } from "./types";
import { REPLACEMENT_CHARACTER } from "./xml";

const ESC = "\x1b[";

/** Control characters in cell text must never reach the viewer's terminal as commands. */
function neutralize(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? REPLACEMENT_CHARACTER : char;
  }
  return out;
}

function colorCode(color: FrameColor, role: "fg" | "bg"): string {
  if (color.intent === "default" || (color.intent !== "indexed" && color.a <= 0)) {
    return role === "fg" ? "39" : "49";
  }
  if (color.intent === "indexed" && color.slot !== undefined) {
    return `${role === "fg" ? 38 : 48};5;${color.slot}`;
  }
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return `${role === "fg" ? 38 : 48};2;${byte(color.r)};${byte(color.g)};${byte(color.b)}`;
}

const ATTRIBUTE_CODES: [number, string][] = [
  [Attr.BOLD, "1"],
  [Attr.DIM, "2"],
  [Attr.ITALIC, "3"],
  [Attr.UNDERLINE, "4"],
  [Attr.BLINK, "5"],
  [Attr.INVERSE, "7"],
  [Attr.HIDDEN, "8"],
  [Attr.STRIKETHROUGH, "9"],
];

export function frameToAnsi(frame: Frame): string {
  const rows = frame.lines.map((line) => {
    let out = "";
    for (const span of line.spans) {
      const codes = ["0"];
      for (const [bit, code] of ATTRIBUTE_CODES) if (span.attributes & bit) codes.push(code);
      codes.push(colorCode(span.fg, "fg"), colorCode(span.bg, "bg"));
      out += `${ESC}${codes.join(";")}m${neutralize(span.text)}`;
    }
    return `${out}${ESC}0m`;
  });
  return `${rows.join("\n")}\n`;
}
