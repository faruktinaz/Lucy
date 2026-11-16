/**
 * A loading indicator that appears only after a short delay (default 300 ms), so fast
 * operations never flash a spinner. With `ui.animations` off it shows a static glyph.
 */
import { useEffect, useState } from "react";
import { useTheme } from "../theme/theme-context";
import { Span, type TextTone } from "./text";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATIC = "⠿";
const INTERVAL_MS = 80;
export const SPINNER_DELAY_MS = 300;

export function useDelayedFlag(active: boolean, delayMs = SPINNER_DELAY_MS): boolean {
  const [shown, setShown] = useState(active && delayMs <= 0);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    if (delayMs <= 0) {
      setShown(true);
      return;
    }
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return shown;
}

/** Inside a `<text>`: the spinner glyph followed by a space and the label. */
export function Spinner({
  label,
  active = true,
  delayMs = SPINNER_DELAY_MS,
  tone = "subtle",
}: {
  label?: string;
  active?: boolean;
  delayMs?: number;
  tone?: TextTone;
}) {
  const theme = useTheme();
  const shown = useDelayedFlag(active, delayMs);
  const [frame, setFrame] = useState(0);
  const animate = shown && theme.animations;
  useEffect(() => {
    if (!animate) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), INTERVAL_MS);
    return () => clearInterval(timer);
  }, [animate]);
  if (!shown) return null;
  return (
    <Span tone={tone}>
      {animate ? FRAMES[frame] : STATIC}
      {label ? ` ${label}` : ""}
    </Span>
  );
}
