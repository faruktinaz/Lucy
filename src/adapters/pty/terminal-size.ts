/**
 * Terminal window sizes. A PTY must never be sized 0x0 (Bun rejects it and some programs divide
 * by the width), and Bun throws for values outside the 16-bit `winsize` range.
 */

export const MIN_TERMINAL_DIMENSION = 1;
export const MAX_TERMINAL_DIMENSION = 65_535;
export const DEFAULT_TERMINAL_SIZE: TerminalSize = { cols: 80, rows: 24 };

export interface TerminalSize {
  cols: number;
  rows: number;
}

function clampDimension(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_TERMINAL_DIMENSION, Math.max(MIN_TERMINAL_DIMENSION, Math.floor(value)));
}

/** Clamps to at least 1x1 and at most the `winsize` range; non-finite values use the fallback. */
export function clampTerminalSize(
  cols: number | undefined,
  rows: number | undefined,
  fallback: TerminalSize = DEFAULT_TERMINAL_SIZE,
): TerminalSize {
  return { cols: clampDimension(cols, fallback.cols), rows: clampDimension(rows, fallback.rows) };
}
