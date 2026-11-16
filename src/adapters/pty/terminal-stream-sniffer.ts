/**
 * Tolerant streaming scanner for the few facts Lucy needs from terminal output that OpenTUI's
 * `EmbeddedTerminalRenderable` does not expose (it has no title, bell or notification events):
 *
 * - BEL, window title (OSC 0 / OSC 2), desktop notifications (OSC 9, OSC 777;notify, OSC 99),
 *   progress (ConEmu OSC 9;4) and working directory (OSC 7);
 * - the DEC modes and keyboard modes that decide how input must be encoded (bracketed paste,
 *   application cursor keys, mouse and focus reporting, alternate screen, kitty keyboard flags,
 *   modifyOtherKeys), so a session can paste correctly and rebuild a screen's modes on replay.
 *
 * It is not an emulator. It follows just enough of the VT500 parser state machine to know whether a
 * byte is inside an escape sequence: sequences split across chunks work, and a BEL that terminates
 * an OSC is not mistaken for a bell. Bytes >= 0x80 are plain text, never C1 controls: in a UTF-8
 * stream 0x80-0x9F are continuation bytes (the "ğ" in Turkish is C4 9F). Payload storage is
 * bounded, so hostile output cannot grow memory.
 */
import { sanitizeForDisplay, truncateEnd } from "@/core/text";

export type TerminalProgressState = "none" | "normal" | "error" | "indeterminate" | "paused";

export interface TerminalProgress {
  state: TerminalProgressState;
  /** 0-100, or `null` when indeterminate or unknown. */
  value: number | null;
}

export type TerminalStreamEvent =
  | { type: "bell" }
  | { type: "title"; title: string }
  | { type: "notification"; title: string | null; body: string; source: "osc9" | "osc99" | "osc777" }
  | { type: "progress"; progress: TerminalProgress }
  | { type: "cwd"; path: string }
  | { type: "mode"; mode: number; enabled: boolean }
  | { type: "reset" };

export interface TerminalModes {
  bracketedPaste: boolean;
  altScreen: boolean;
  focusReporting: boolean;
  mouseTracking: boolean;
  applicationCursorKeys: boolean;
  applicationKeypad: boolean;
  cursorVisible: boolean;
  /** Current kitty keyboard protocol flags (0 = legacy encoding). */
  kittyKeyboardFlags: number;
  /** xterm modifyOtherKeys level (0 = off). */
  modifyOtherKeys: number;
}

/** DEC private modes that are tracked, with their power-on defaults. */
const TRACKED_DEC_MODES: ReadonlyMap<number, boolean> = new Map([
  [1, false], // DECCKM application cursor keys
  [7, true], // DECAWM autowrap
  [25, true], // DECTCEM cursor visible
  [47, false], // alternate screen (legacy)
  [1047, false], // alternate screen
  [1049, false], // alternate screen + saved cursor
  [9, false], // X10 mouse
  [1000, false], // mouse press/release
  [1002, false], // mouse button motion
  [1003, false], // mouse any motion
  [1004, false], // focus in/out reports
  [1005, false], // UTF-8 mouse encoding
  [1006, false], // SGR mouse encoding
  [1015, false], // urxvt mouse encoding
  [1016, false], // SGR pixel mouse encoding
  [2004, false], // bracketed paste
  [2031, false], // colour-scheme change reports
]);

const ALT_SCREEN_MODES = [1049, 1047, 47] as const;
const MOUSE_MODES = [9, 1000, 1002, 1003] as const;

const GROUND = 0;
const ESCAPE = 1;
const ESCAPE_INTERMEDIATE = 2;
const CSI = 3;
const OSC = 4;
const OSC_ESCAPE = 5;
const STRING = 6;
const STRING_ESCAPE = 7;

const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;

const MAX_CSI = 64;
const MAX_OSC = 8 * 1024;
const MAX_TEXT = 256;
const MAX_KITTY_STACK = 16;

const decoder = new TextDecoder("utf-8");

function cleanText(text: string): string {
  const flat = text.replace(/[\r\n\t]+/g, " ");
  return truncateEnd(sanitizeForDisplay(flat).trim(), MAX_TEXT);
}

function decodeBase64(text: string): string {
  try {
    return decoder.decode(Buffer.from(text, "base64"));
  } catch {
    return "";
  }
}

const PROGRESS_STATES: Record<string, TerminalProgressState> = {
  "0": "none",
  "1": "normal",
  "2": "error",
  "3": "indeterminate",
  "4": "paused",
};

export class TerminalStreamSniffer {
  private state = GROUND;
  private csi = "";
  private csiOverflow = false;
  private osc = new Uint8Array(256);
  private oscLength = 0;
  private oscOverflow = false;
  private decModes = new Map<number, boolean>();
  private kittyStack: number[] = [];
  private kittyFlags = 0;
  private modifyOtherKeysLevel = 0;
  private keypadApplication = false;
  private kittyNotification: { title: string; body: string } | null = null;
  private currentTitle = "";

  constructor(private readonly onEvent: (event: TerminalStreamEvent) => void = () => {}) {}

  /** The last title set with OSC 0/2 (sanitized), or "". */
  get title(): string {
    return this.currentTitle;
  }

  /** True when the parser is between sequences (the last byte did not leave one open). */
  get atSequenceBoundary(): boolean {
    return this.state === GROUND;
  }

  get modes(): TerminalModes {
    const on = (mode: number) => this.decModes.get(mode) ?? TRACKED_DEC_MODES.get(mode) ?? false;
    return {
      bracketedPaste: on(2004),
      altScreen: ALT_SCREEN_MODES.some(on),
      focusReporting: on(1004),
      mouseTracking: MOUSE_MODES.some(on),
      applicationCursorKeys: on(1),
      applicationKeypad: this.keypadApplication,
      cursorVisible: on(25),
      kittyKeyboardFlags: this.kittyFlags,
      modifyOtherKeys: this.modifyOtherKeysLevel,
    };
  }

  feed(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i] as number;
      if (this.state === GROUND) {
        // Hot path: almost every byte is text.
        if (byte === ESC) this.state = ESCAPE;
        else if (byte === BEL) this.onEvent({ type: "bell" });
        continue;
      }
      this.step(byte);
    }
  }

  /** Forgets all state (for a restarted process). Does not emit events. */
  reset(): void {
    this.state = GROUND;
    this.csi = "";
    this.csiOverflow = false;
    this.oscLength = 0;
    this.oscOverflow = false;
    this.resetModes();
    this.currentTitle = "";
  }

  /**
   * Escape sequences that put a fresh emulator into the tracked modes. Used before replaying a
   * buffer whose beginning (where the application originally set its modes) was dropped.
   */
  modePrelude(): string {
    let out = "";
    const alt = ALT_SCREEN_MODES.find((mode) => this.decModes.get(mode) === true);
    if (alt !== undefined) out += `\x1b[?${alt}h`;
    for (const [mode, initial] of TRACKED_DEC_MODES) {
      if ((ALT_SCREEN_MODES as readonly number[]).includes(mode)) continue;
      const value = this.decModes.get(mode);
      if (value !== undefined && value !== initial) out += `\x1b[?${mode}${value ? "h" : "l"}`;
    }
    if (this.keypadApplication) out += "\x1b=";
    if (this.kittyFlags > 0) out += `\x1b[>${this.kittyFlags}u`;
    if (this.modifyOtherKeysLevel > 0) out += `\x1b[>4;${this.modifyOtherKeysLevel}m`;
    return out;
  }

  private resetModes(): void {
    this.decModes.clear();
    this.kittyStack = [];
    this.kittyFlags = 0;
    this.modifyOtherKeysLevel = 0;
    this.keypadApplication = false;
    this.kittyNotification = null;
  }

  private step(byte: number): void {
    switch (this.state) {
      case ESCAPE:
        this.escape(byte);
        return;
      case ESCAPE_INTERMEDIATE:
        if (byte === ESC) this.state = ESCAPE;
        else if (byte === BEL) this.onEvent({ type: "bell" });
        else if (byte >= 0x20 && byte <= 0x2f) return;
        else this.state = GROUND;
        return;
      case CSI:
        this.csiByte(byte);
        return;
      case OSC:
        if (byte === BEL) this.endOsc();
        else if (byte === ESC) this.state = OSC_ESCAPE;
        else if (byte === CAN || byte === SUB) this.state = GROUND;
        else this.oscByte(byte);
        return;
      case OSC_ESCAPE:
        if (byte === 0x5c) {
          this.endOsc();
        } else {
          // ESC not followed by "\" aborts the OSC and starts a new escape sequence.
          this.state = ESCAPE;
          this.escape(byte);
        }
        return;
      case STRING:
        if (byte === ESC) this.state = STRING_ESCAPE;
        else if (byte === CAN || byte === SUB) this.state = GROUND;
        return;
      case STRING_ESCAPE:
        if (byte === 0x5c) {
          this.state = GROUND;
        } else {
          this.state = ESCAPE;
          this.escape(byte);
        }
        return;
      default:
        this.state = GROUND;
    }
  }

  private escape(byte: number): void {
    switch (byte) {
      case 0x5b: // [
        this.csi = "";
        this.csiOverflow = false;
        this.state = CSI;
        return;
      case 0x5d: // ]
        this.oscLength = 0;
        this.oscOverflow = false;
        this.state = OSC;
        return;
      case 0x50: // P  DCS
      case 0x58: // X  SOS
      case 0x5e: // ^  PM
      case 0x5f: // _  APC
        this.state = STRING;
        return;
      case 0x63: // c  RIS
        this.resetModes();
        this.state = GROUND;
        this.onEvent({ type: "reset" });
        return;
      case 0x3d: // =  DECKPAM
        this.keypadApplication = true;
        this.state = GROUND;
        return;
      case 0x3e: // >  DECKPNM
        this.keypadApplication = false;
        this.state = GROUND;
        return;
      case ESC:
        return;
      case BEL:
        this.onEvent({ type: "bell" });
        return;
      default:
        this.state = byte >= 0x20 && byte <= 0x2f ? ESCAPE_INTERMEDIATE : GROUND;
    }
  }

  private csiByte(byte: number): void {
    if (byte >= 0x40 && byte <= 0x7e) {
      this.state = GROUND;
      if (!this.csiOverflow) this.dispatchCsi(this.csi, byte);
      return;
    }
    if (byte >= 0x20 && byte <= 0x3f) {
      if (this.csi.length < MAX_CSI) this.csi += String.fromCharCode(byte);
      else this.csiOverflow = true;
      return;
    }
    if (byte === ESC) this.state = ESCAPE;
    else if (byte === CAN || byte === SUB || byte >= 0x80) this.state = GROUND;
    else if (byte === BEL) this.onEvent({ type: "bell" }); // C0 controls execute inside CSI
  }

  private dispatchCsi(params: string, final: number): void {
    const prefix = params[0];
    if ((final === 0x68 || final === 0x6c) && prefix === "?") {
      for (const part of params.slice(1).split(";")) {
        const mode = Number(part);
        if (Number.isInteger(mode)) this.setDecMode(mode, final === 0x68);
      }
      return;
    }
    if (final === 0x75) {
      this.kittyKeyboard(prefix, params.slice(1));
      return;
    }
    if (final === 0x6d && prefix === ">") {
      const [resource, value] = params.slice(1).split(";");
      if (resource === "4") this.modifyOtherKeysLevel = Number(value) || 0;
      return;
    }
    if (final === 0x70 && params === "!") {
      // DECSTR soft reset: the input-relevant subset.
      this.setDecMode(1, false);
      this.setDecMode(25, true);
      this.keypadApplication = false;
    }
  }

  private kittyKeyboard(prefix: string | undefined, rest: string): void {
    if (prefix === ">") {
      this.kittyStack.push(this.kittyFlags);
      if (this.kittyStack.length > MAX_KITTY_STACK) this.kittyStack.shift();
      this.kittyFlags = Number(rest) || 0;
    } else if (prefix === "<") {
      const count = Math.max(1, Number(rest) || 1);
      for (let i = 0; i < count; i++) this.kittyFlags = this.kittyStack.pop() ?? 0;
    } else if (prefix === "=") {
      const [flagsText, modeText] = rest.split(";");
      const flags = Number(flagsText) || 0;
      const mode = Number(modeText) || 1;
      if (mode === 1) this.kittyFlags = flags;
      else if (mode === 2) this.kittyFlags |= flags;
      else if (mode === 3) this.kittyFlags &= ~flags;
    }
  }

  private setDecMode(mode: number, enabled: boolean): void {
    if (!TRACKED_DEC_MODES.has(mode)) return;
    const previous = this.decModes.get(mode) ?? TRACKED_DEC_MODES.get(mode);
    this.decModes.set(mode, enabled);
    if (previous !== enabled) this.onEvent({ type: "mode", mode, enabled });
  }

  private oscByte(byte: number): void {
    if (this.oscLength >= MAX_OSC) {
      this.oscOverflow = true;
      return;
    }
    if (this.oscLength === this.osc.length) {
      const grown = new Uint8Array(Math.min(MAX_OSC, this.osc.length * 2));
      grown.set(this.osc);
      this.osc = grown;
    }
    this.osc[this.oscLength++] = byte;
  }

  private endOsc(): void {
    this.state = GROUND;
    if (this.oscOverflow) return;
    // The payload is complete and bounded, so decoding it here cannot split a character.
    const payload = decoder.decode(this.osc.subarray(0, this.oscLength));
    const separator = payload.indexOf(";");
    const code = separator === -1 ? payload : payload.slice(0, separator);
    const rest = separator === -1 ? "" : payload.slice(separator + 1);
    switch (code) {
      case "0":
      case "2": {
        const title = cleanText(rest);
        if (title !== this.currentTitle) {
          this.currentTitle = title;
          this.onEvent({ type: "title", title });
        }
        return;
      }
      case "7":
        this.reportCwd(rest);
        return;
      case "9":
        this.osc9(rest);
        return;
      case "99":
        this.osc99(rest);
        return;
      case "777": {
        const [kind, title, ...body] = rest.split(";");
        if (kind === "notify") {
          this.onEvent({
            type: "notification",
            title: cleanText(title ?? "") || null,
            body: cleanText(body.join(";")),
            source: "osc777",
          });
        }
        return;
      }
      default:
    }
  }

  private reportCwd(uri: string): void {
    try {
      const url = new URL(uri);
      if (url.protocol !== "file:") return;
      const path = decodeURIComponent(url.pathname);
      if (path) this.onEvent({ type: "cwd", path });
    } catch {
      // Malformed OSC 7: ignore.
    }
  }

  private osc9(rest: string): void {
    if (rest.startsWith("4;") || rest === "4") {
      const [, stateText = "0", valueText] = rest.split(";");
      const state = PROGRESS_STATES[stateText] ?? "none";
      const parsed = Number(valueText);
      const value =
        state === "indeterminate" || !Number.isFinite(parsed) || valueText === undefined || valueText === ""
          ? null
          : Math.min(100, Math.max(0, parsed));
      this.onEvent({ type: "progress", progress: { state, value } });
      return;
    }
    // Other ConEmu sub-commands (OSC 9;1..12) are not notifications.
    if (/^\d+(;|$)/.test(rest)) return;
    this.onEvent({ type: "notification", title: null, body: cleanText(rest), source: "osc9" });
  }

  /** kitty desktop notifications: `OSC 99 ; key=value:... ; payload`, possibly in chunks. */
  private osc99(rest: string): void {
    const separator = rest.indexOf(";");
    if (separator === -1) return;
    const meta = new Map<string, string>();
    for (const pair of rest.slice(0, separator).split(":")) {
      const eq = pair.indexOf("=");
      if (eq > 0) meta.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    let payload = rest.slice(separator + 1);
    if (meta.get("e") === "1") payload = decodeBase64(payload);
    const part = meta.get("p") ?? "title";
    if (part !== "title" && part !== "body") return;
    const pending = this.kittyNotification ?? { title: "", body: "" };
    pending[part] += payload;
    if (meta.get("d") === "0") {
      this.kittyNotification = pending;
      return;
    }
    this.kittyNotification = null;
    const title = cleanText(pending.title);
    const body = cleanText(pending.body);
    if (!title && !body) return;
    this.onEvent({ type: "notification", title: title || null, body, source: "osc99" });
  }
}
