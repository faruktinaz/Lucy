/**
 * Mouse selections and the clipboard. Lucy turns on mouse reporting, so the terminal's own
 * selection (and its Cmd+C / Ctrl+Shift+C) never sees text selected in Lucy: that is OpenTUI's
 * selection, and it reaches the clipboard only through here.
 *
 * - Copy on select (`ui.copyOnSelect`): when a drag selection ends (OpenTUI's `selection`
 *   event, also for embedded terminals, whose renderable takes part in the same selection),
 *   the text is copied and the status bar says so quietly.
 * - `copySelection()` (Ctrl+C outside a terminal, Ctrl+Shift+C anywhere, "Copy Selection").
 *
 * Why the text is remembered: a selection keeps references to the renderables it covers, not
 * their text. When a view re-renders (a new frame of a streaming terminal, a list that
 * re-keys its rows, a file reloaded from disk) those renderables are destroyed or emptied and
 * the live selection returns "" although it is still on screen. The text read when the drag
 * ended is kept with the selection object and used when the live text is gone.
 */
import type { Disposable } from "@/core/events";
import { toDisposable } from "@/core/events";
import type { ClipboardService, CopyResult } from "./clipboard-service";
import { copiedLabel } from "./clipboard-service";

/** The slice of OpenTUI's `Selection` this module uses. */
export interface SelectionLike {
  getSelectedText(): string;
}

/** The slice of OpenTUI's `CliRenderer` this module uses. */
export interface SelectionRenderer {
  getSelection(): SelectionLike | null;
  on(event: "selection", listener: (selection: SelectionLike) => void): unknown;
  off(event: "selection", listener: (selection: SelectionLike) => void): unknown;
}

export interface SelectionCopyOptions {
  renderer: SelectionRenderer;
  clipboard: ClipboardService;
  copyOnSelect: () => boolean;
  /** A quiet status-bar message. */
  flash: (text: string) => void;
  /** A failure the user should see (a toast). */
  report: (reason: string) => void;
}

/** Selected text worth copying: not empty and not only whitespace (a stray click). */
export function meaningful(text: string): boolean {
  return /\S/.test(text);
}

export class SelectionCopy implements Disposable {
  private remembered: { selection: SelectionLike; text: string } | null = null;
  private readonly listener = (selection: SelectionLike) => this.onSelectionFinished(selection);
  private readonly subscription: Disposable;

  constructor(private readonly options: SelectionCopyOptions) {
    options.renderer.on("selection", this.listener);
    this.subscription = toDisposable(() => options.renderer.off("selection", this.listener));
  }

  /** The text of the selection on screen now, or null when nothing is selected. */
  currentText(): string | null {
    const selection = this.options.renderer.getSelection();
    if (!selection) return null;
    const live = selection.getSelectedText();
    if (meaningful(live)) return live;
    // Re-rendered under the selection: the text from when the drag ended is still what the
    // user selected. A different selection object means the user selected again.
    if (this.remembered?.selection === selection) return this.remembered.text;
    return null;
  }

  /** Copies the current selection. Returns false when nothing is selected (nothing done). */
  copySelection(): boolean {
    const text = this.currentText();
    if (text === null) return false;
    void this.copy(text);
    return true;
  }

  private onSelectionFinished(selection: SelectionLike): void {
    const text = selection.getSelectedText();
    if (!meaningful(text)) return;
    this.remembered = { selection, text };
    if (this.options.copyOnSelect()) void this.copy(text);
  }

  private async copy(text: string): Promise<CopyResult> {
    const result = await this.options.clipboard.copy(text);
    if (result.ok) this.options.flash(copiedLabel(result));
    else this.options.report(result.reason);
    return result;
  }

  dispose(): void {
    this.subscription.dispose();
    this.remembered = null;
  }
}
