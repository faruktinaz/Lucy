/**
 * In-place editing of one text file.
 *
 * The buffer is OpenTUI's `TextareaRenderable` (cursor, selection, undo/redo, word moves,
 * bracketed paste) inside a `LineNumberRenderable`. Both are created imperatively and owned by
 * this session, not by React: only the active tab's view is mounted, and re-parenting the live
 * renderables on every tab switch keeps the text, cursor and undo history (verified).
 *
 * Saving writes the buffer back in the file's own format (`save-file.ts`). The session never
 * overwrites newer disk content silently: a dirty buffer whose file changed on disk enters a
 * conflict that only the user resolves (reload from disk, or keep mine), and auto save waits.
 */

import type { KeyBinding } from "@opentui/core";
import {
  type CliRenderer,
  LineNumberRenderable,
  type RGBA,
  type SyntaxStyle,
  TextareaRenderable,
} from "@opentui/core";
import { joinRelative } from "@/adapters/filesystem/workspace-path";
import type { SyntaxService } from "@/adapters/syntax";
import { errorMessage } from "@/core/errors";
import type { Disposable } from "@/core/events";
import { Store } from "@/core/store";
import { sanitizeForDisplay } from "@/core/text";
import { BufferCells } from "./buffer-cells";
import { detectIndent, type IndentStyle } from "./indent";
import { type FileStamp, observeFile, splitLines, type TextDocument, type ViewerDocument } from "./model";
import { encodeFileText, prefersCrlf, type TextFormat, toBufferText, writeFileAtomic } from "./save-file";

/** Above this many lines or UTF-8 bytes a file opens read-only (the viewer), see the report. */
export const EDIT_MAX_LINES = 20_000;
export const EDIT_MAX_BYTES = 1024 * 1024;
/** Pause after typing before syntax colors and find matches are recomputed. */
export const REHIGHLIGHT_DELAY_MS = 200;

const SYNTAX_REF = 1;
const FIND_REF = 2;

export type SaveStatus = "saved" | "unsaved" | "saving" | "failed";

export interface EditState {
  readonly status: SaveStatus;
  readonly dirty: boolean;
  /** Why the last save failed (display-safe). */
  readonly error: string | null;
  /** The file changed (or vanished) on disk while the buffer had unsaved changes. */
  readonly conflict: "changed" | "deleted" | null;
}

/** Why a text document cannot be edited, or null when it can. */
export function readOnlyReason(document: TextDocument): string | null {
  if (document.outsideWorkspace) return "Read-only: the file lies outside the workspace";
  if (document.encoding !== "utf-8") return "Read-only: UTF-16 files are not edited in Lucy";
  if (document.lineCount > EDIT_MAX_LINES || document.size > EDIT_MAX_BYTES) {
    return "Read-only: too large to edit smoothly";
  }
  return null;
}

/** Keys the textarea handles itself, adjusted to editor conventions (Home/End stay on the line). */
const EDITOR_KEY_BINDINGS: KeyBinding[] = [
  { name: "home", action: "line-home" },
  { name: "end", action: "line-end" },
  { name: "home", shift: true, action: "select-line-home" },
  { name: "end", shift: true, action: "select-line-end" },
  { name: "home", ctrl: true, action: "buffer-home" },
  { name: "end", ctrl: true, action: "buffer-end" },
  { name: "home", ctrl: true, shift: true, action: "select-buffer-home" },
  { name: "end", ctrl: true, shift: true, action: "select-buffer-end" },
  { name: "a", ctrl: true, action: "select-all" },
  { name: "y", ctrl: true, action: "redo" },
];

export interface EditSessionOptions {
  readonly root: string;
  readonly path: string;
  readonly syntax: SyntaxService;
  readonly document: TextDocument;
  readonly tabWidth: () => number;
  readonly autosave: () => { mode: "afterDelay" | "onFocusChange" | "off"; delayMs: number };
}

export interface EditColors {
  readonly text: RGBA;
  readonly bg: RGBA;
  readonly lineNumber: RGBA;
  readonly activeLineBg: RGBA;
  readonly selectionBg: RGBA;
  readonly cursor: RGBA;
  readonly findMatchBg: RGBA;
  readonly findMatchActiveBg: RGBA;
}

export class EditSession implements Disposable {
  readonly state = new Store<EditState>({ status: "saved", dirty: false, error: null, conflict: null });
  readonly path: string;
  /** Text as last loaded or saved ("\n" breaks, no final newline). */
  savedText: string;
  #format: TextFormat;
  #stamp: FileStamp;
  #languageId: string;
  #indent: IndentStyle;
  #textarea: TextareaRenderable | null = null;
  #gutter: LineNumberRenderable | null = null;
  #style: SyntaxStyle | null = null;
  #styleIds = new Map<string, number | null>();
  #findStyles: { match: number; active: number } | null = null;
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  #highlightTimer: ReturnType<typeof setTimeout> | undefined;
  #highlightAbort: AbortController | null = null;
  #saving: Promise<boolean> | null = null;
  #disposed = false;
  /** Called after edits settle, with the buffer's lines (find follows the edited text). */
  onTextSettled: ((lines: readonly string[]) => void) | null = null;
  /** Cursor moves, for the status bar and the active line. */
  onCursor: ((line: number, column: number) => void) | null = null;

  constructor(private readonly options: EditSessionOptions) {
    this.path = options.path;
    const document = options.document;
    this.savedText = toBufferText(document.content, document.finalNewline);
    this.#format = formatOf(document);
    this.#stamp = document.stamp;
    this.#languageId = document.language.id;
    this.#indent = detectIndent(splitLines(document.content), options.tabWidth());
  }

  get indent(): IndentStyle {
    return this.#indent;
  }

  get textarea(): TextareaRenderable | null {
    return this.#textarea;
  }

  get gutter(): LineNumberRenderable | null {
    return this.#gutter;
  }

  /** The buffer's current text. */
  text(): string {
    return this.#textarea?.plainText ?? this.savedText;
  }

  /** Creates the renderables on first use (they need the renderer) and returns the gutter to mount. */
  ensureRenderables(renderer: CliRenderer, style: SyntaxStyle, colors: EditColors): LineNumberRenderable {
    if (!this.#textarea || !this.#gutter) {
      const textarea = new TextareaRenderable(renderer, {
        initialValue: this.savedText,
        width: "100%",
        height: "100%",
        wrapMode: "none",
        syntaxStyle: style,
        keyBindings: EDITOR_KEY_BINDINGS,
        scrollMargin: 0.1,
      });
      textarea.onContentChange = () => this.#changed();
      textarea.onCursorChange = () => this.#cursorMoved();
      const gutter = new LineNumberRenderable(renderer, {
        target: textarea,
        minWidth: 3,
        paddingRight: 2,
        width: "100%",
        height: "100%",
      });
      gutter.add(textarea);
      this.#textarea = textarea;
      this.#gutter = gutter;
      this.#style = null;
    }
    this.applyTheme(style, colors);
    return this.#gutter;
  }

  /** Theme colors and syntax style; a new style re-applies the highlights with its ids. */
  applyTheme(style: SyntaxStyle, colors: EditColors): void {
    const textarea = this.#textarea;
    const gutter = this.#gutter;
    if (!textarea || !gutter) return;
    textarea.textColor = colors.text;
    textarea.backgroundColor = colors.bg;
    textarea.focusedTextColor = colors.text;
    textarea.focusedBackgroundColor = colors.bg;
    textarea.selectionBg = colors.selectionBg;
    textarea.cursorColor = colors.cursor;
    gutter.fg = colors.lineNumber;
    gutter.bg = colors.bg;
    this.activeLineColor = colors.activeLineBg;
    if (this.#style !== style) {
      this.#style = style;
      textarea.syntaxStyle = style;
      this.#styleIds.clear();
      // Find matches are drawn with two styles of our own on the theme's style table.
      this.#findStyles = {
        match: style.registerStyle("lucy.find.match", { fg: colors.text, bg: colors.findMatchBg }),
        active: style.registerStyle("lucy.find.matchActive", {
          fg: colors.text,
          bg: colors.findMatchActiveBg,
        }),
      };
      // Colors right away when the file opens (or the theme changes); only edits wait for a pause.
      this.highlightNow();
    }
    this.#paintActiveLine();
  }

  activeLineColor: RGBA | null = null;
  showActiveLine = true;

  #paintActiveLine(): void {
    const gutter = this.#gutter;
    const textarea = this.#textarea;
    if (!gutter || !textarea || gutter.isDestroyed || textarea.isDestroyed) return;
    gutter.clearAllLineColors();
    if (this.showActiveLine && this.activeLineColor) {
      gutter.setLineColor(textarea.logicalCursor.row, {
        gutter: this.activeLineColor,
        content: this.activeLineColor,
      });
    }
  }

  #lastCursor = { row: -1, col: -1 };

  /**
   * Reports the cursor when it moved. The buffer's own "cursor-changed" event does not fire
   * for moves made through the view (arrows, clicks), so the surface also calls this after
   * every key and click.
   */
  syncCursor(): void {
    const textarea = this.#textarea;
    if (!textarea || textarea.isDestroyed) return;
    const cursor = textarea.logicalCursor;
    if (cursor.row === this.#lastCursor.row && cursor.col === this.#lastCursor.col) return;
    this.#lastCursor = { row: cursor.row, col: cursor.col };
    this.#paintActiveLine();
    this.onCursor?.(cursor.row, cursor.col);
  }

  #cursorMoved(): void {
    this.syncCursor();
  }

  #changed(): void {
    if (this.#disposed) return;
    this.syncCursor();
    const dirty = this.text() !== this.savedText;
    this.state.set((state) =>
      state.dirty === dirty && state.status !== "saved"
        ? state
        : { ...state, dirty, status: dirty ? (state.status === "failed" ? "failed" : "unsaved") : "saved" },
    );
    this.scheduleHighlight(REHIGHLIGHT_DELAY_MS);
    this.#scheduleAutosave();
  }

  #scheduleAutosave(): void {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
    const { mode, delayMs } = this.options.autosave();
    if (mode !== "afterDelay" || !this.state.get().dirty) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      void this.save({ auto: true });
    }, delayMs);
  }

  /** Focus left the editor (another part, another tab, an overlay): "onFocusChange" saves now. */
  focusLost(): void {
    if (this.options.autosave().mode === "onFocusChange" && this.state.get().dirty)
      void this.save({ auto: true });
  }

  /** The autosave setting changed: re-arm or cancel the timer. */
  settingsChanged(): void {
    this.#scheduleAutosave();
  }

  /**
   * Saves the buffer. Nothing is written when the text equals what is on disk. Returns true when
   * the file on disk now holds the buffer. A changed file on disk is never overwritten: the
   * session enters a conflict instead (for auto save and Ctrl+S alike).
   */
  async save(options: { auto?: boolean; force?: boolean } = {}): Promise<boolean> {
    if (this.#saving) await this.#saving;
    this.#saving = this.#save(options);
    try {
      return await this.#saving;
    } finally {
      this.#saving = null;
    }
  }

  async #save(options: { auto?: boolean; force?: boolean }): Promise<boolean> {
    if (this.#disposed) return false;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
    const state = this.state.get();
    if (state.conflict && !options.force) return false;
    const text = this.text();
    if (text === this.savedText && !options.force) {
      this.state.update({ dirty: false, status: "saved", error: null });
      return true;
    }
    const absolute = joinRelative(this.options.root, this.path);
    if (!options.force) {
      const disk = await observeFile(this.options.root, this.path);
      const unchanged =
        disk !== null &&
        disk !== "unreadable" &&
        disk.size === this.#stamp.size &&
        disk.mtimeMs === this.#stamp.mtimeMs;
      if (!unchanged) {
        this.state.update({ conflict: disk === null ? "deleted" : "changed" });
        return false;
      }
    }
    this.state.update({ status: "saving", error: null });
    try {
      this.#stamp = await writeFileAtomic(absolute, encodeFileText(text, this.#format));
    } catch (error) {
      this.state.update({ status: "failed", error: sanitizeForDisplay(errorMessage(error)) });
      return false;
    }
    this.savedText = text;
    const dirty = this.text() !== this.savedText;
    this.state.update({ dirty, status: dirty ? "unsaved" : "saved", error: null, conflict: null });
    if (dirty) this.#scheduleAutosave();
    return true;
  }

  /**
   * A new version of the document was loaded (watcher, reload, our own save echoing back). A
   * clean buffer follows the disk silently; a dirty one keeps the user's text and flags a
   * conflict when the disk content differs from what was last saved.
   */
  documentChanged(document: ViewerDocument): void {
    if (this.#disposed) return;
    if (document.kind === "unavailable") {
      if (document.reason === "deleted" && this.state.get().dirty) this.state.update({ conflict: "deleted" });
      return;
    }
    if (document.kind !== "text") return;
    const diskText = toBufferText(document.content, document.finalNewline);
    if (diskText === this.savedText) {
      this.#stamp = document.stamp;
      return;
    }
    if (!this.state.get().dirty) {
      this.#loadFromDisk(document);
      return;
    }
    this.state.update({ conflict: "changed" });
  }

  /** Conflict answer: take the disk version (the buffer's edits are dropped). */
  reloadFromDisk(document: ViewerDocument): void {
    if (document.kind !== "text") return;
    this.#loadFromDisk(document);
  }

  /** Conflict answer: keep the buffer; the next save overwrites the disk version knowingly. */
  async keepMine(): Promise<void> {
    const disk = await observeFile(this.options.root, this.path);
    if (disk && disk !== "unreadable") this.#stamp = disk;
    this.state.update({ conflict: null });
    if (this.state.get().dirty) this.#scheduleAutosave();
  }

  /** Drops the edits (close without saving). */
  discard(): void {
    clearTimeout(this.#saveTimer);
    this.#textarea?.setText(this.savedText);
    this.state.update({ dirty: false, status: "saved", error: null, conflict: null });
  }

  #loadFromDisk(document: TextDocument): void {
    this.savedText = toBufferText(document.content, document.finalNewline);
    this.#format = formatOf(document);
    this.#stamp = document.stamp;
    const textarea = this.#textarea;
    if (textarea) {
      const { row, col } = textarea.logicalCursor;
      textarea.setText(this.savedText);
      // Keep the reader where they were, clamped to the new text.
      const lines = this.savedText.split("\n");
      const line = Math.min(row, lines.length - 1);
      textarea.setCursor(line, Math.min(col, (lines[line] ?? "").length));
    }
    this.state.set({ status: "saved", dirty: false, error: null, conflict: null });
    this.highlightNow();
  }

  /** Recomputes syntax colors after a pause (or now), off the typing path. */
  scheduleHighlight(delayMs: number): void {
    clearTimeout(this.#highlightTimer);
    this.#highlightTimer = setTimeout(() => void this.#highlight(), delayMs);
  }

  /** Computes syntax colors now (file opened, reloaded, new theme), cancelling a pending pass. */
  highlightNow(): void {
    clearTimeout(this.#highlightTimer);
    this.#highlightTimer = undefined;
    void this.#highlight();
  }

  async #highlight(): Promise<void> {
    const textarea = this.#textarea;
    const style = this.#style;
    if (!textarea || textarea.isDestroyed || !style || this.#disposed) return;
    this.#highlightAbort?.abort();
    const controller = new AbortController();
    this.#highlightAbort = controller;
    const text = textarea.plainText;
    this.onTextSettled?.(text.split("\n"));
    let ranges: Awaited<ReturnType<SyntaxService["highlight"]>>;
    try {
      ranges = this.options.syntax.exceedsSizeLimit(text)
        ? []
        : await this.options.syntax.highlight(text, this.#languageId, { signal: controller.signal });
    } catch {
      return; // Cancelled by a newer edit.
    }
    // The renderer may have destroyed the buffer meanwhile (app shutdown): nothing to color.
    if (
      controller.signal.aborted ||
      this.#disposed ||
      this.#textarea !== textarea ||
      textarea.isDestroyed ||
      textarea.plainText !== text
    )
      return;
    textarea.removeHighlightsByRef(SYNTAX_REF);
    // Our ranges are UTF-16 offsets; the buffer wants display cells per line (see buffer-cells.ts).
    const cells = new BufferCells(text, textarea.editBuffer.getTabWidth());
    for (const range of ranges) {
      const styleId = this.#styleId(style, range.group);
      if (styleId === null) continue;
      for (const piece of cells.ranges(range.start, range.end)) {
        textarea.addHighlight(piece.line, { start: piece.start, end: piece.end, styleId, hlRef: SYNTAX_REF });
      }
    }
  }

  #styleId(style: SyntaxStyle, group: string): number | null {
    let id = this.#styleIds.get(group);
    if (id === undefined) {
      // OpenTUI falls back to the first dotted segment ("keyword.return" -> "keyword").
      id = style.getStyleId(group) ?? style.getStyleId(group.split(".")[0] as string);
      this.#styleIds.set(group, id);
    }
    return id;
  }

  /** Find matches as highlights, in buffer offsets (UTF-16), the current one emphasized. */
  showFindMatches(matches: readonly { line: number; start: number; end: number }[], current: number): void {
    const textarea = this.#textarea;
    const styles = this.#findStyles;
    if (!textarea || textarea.isDestroyed || !styles) return;
    textarea.removeHighlightsByRef(FIND_REF);
    if (matches.length === 0) return;
    const cells = new BufferCells(textarea.plainText, textarea.editBuffer.getTabWidth());
    matches.forEach((match, index) => {
      if (match.line >= cells.lines.length) return;
      const start = cells.cell(match.line, match.start);
      // A zero-width match (`^`) still gets a one-cell marker.
      const end = Math.max(start + 1, cells.cell(match.line, match.end));
      textarea.addHighlight(match.line, {
        start,
        end,
        styleId: index === current ? styles.active : styles.match,
        priority: 10,
        hlRef: FIND_REF,
      });
    });
  }

  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#saveTimer);
    clearTimeout(this.#highlightTimer);
    this.#highlightAbort?.abort();
    const gutter = this.#gutter;
    this.#gutter = null;
    this.#textarea = null;
    if (gutter && !gutter.isDestroyed) gutter.destroyRecursively();
  }
}

function formatOf(document: TextDocument): TextFormat {
  return {
    bom: document.bom,
    lineEnding: document.lineEnding,
    mixedPrefersCrlf: document.lineEnding === "mixed" && prefersCrlf(document.content),
    finalNewline: document.finalNewline,
  };
}
