/**
 * Keybinding labels. Always formatted from the registry through `formatChord`, so what the
 * UI shows is what the user's terminal can actually send (`Ctrl+K E` in a legacy terminal,
 * `Ctrl+Shift+E` with the kitty protocol) and follows their overrides.
 */

import { useKeybindingLabel } from "@/app/react";
import { formatChord } from "@/core/keybindings";
import { Span, type TextTone } from "./text";

/** `ctrl+k e` -> `Ctrl+K E`. Invalid input is shown as is. */
export function formatKeys(keys: string): string {
  try {
    return formatChord(keys, "text");
  } catch {
    return keys;
  }
}

/**
 * A keybinding label as a span (inside a `<text>`). Give either `keys` (a sequence) or
 * `command` (its current binding is looked up); nothing renders when there is none.
 */
export function KeyHint({
  keys,
  command,
  tone = "subtle",
  bold,
}: {
  keys?: string;
  command?: string;
  tone?: TextTone;
  bold?: boolean;
}) {
  const label = useKeybindingLabel(keys ? undefined : command);
  const text = keys ? formatKeys(keys) : label;
  if (!text) return null;
  return (
    <Span tone={tone} bold={bold}>
      {text}
    </Span>
  );
}
