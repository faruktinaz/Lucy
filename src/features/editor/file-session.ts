/**
 * Everything one file tab owns while it is open: the document and viewer state (`ViewerTab`),
 * in-file find (`FindModel`), and the small amount of UI state the view needs across remounts
 * (only the active tab's view is mounted, so this must outlive it).
 */
import type { ViewerLimits } from "@/adapters/filesystem";
import { type Disposable, DisposableStore, toDisposable } from "@/core/events";
import { Store } from "@/core/store";
import { EditSession, type EditSessionOptions, readOnlyReason } from "./edit-session";
import {
  documentLines,
  FindModel,
  type SyntaxFacts,
  type TextDocument,
  type ViewerDocument,
  type ViewerState,
  ViewerTab,
} from "./model";

/** A position to show: 0-based line, plus a UTF-16 offset or a 1-based character column. */
export interface PendingReveal {
  readonly line: number;
  readonly offset?: number;
  readonly character?: number;
}

export interface SessionUiState {
  readonly findOpen: boolean;
  /** Increases when the find field should take focus (Ctrl+F while it is already open). */
  readonly findFocusRequest: number;
  /** 0-based UTF-16 column on the active line (go to line:column, find, a click). */
  readonly column: number;
  /** A reveal waiting for the document to load. */
  readonly pendingReveal: PendingReveal | null;
  /**
   * Increases each time a reveal moved the active line; the view centers the line when it sees
   * a value it has not handled (also after mounting, for reveals made while another tab showed).
   */
  readonly revealRequest: number;
}

export interface FileSessionOptions {
  readonly root: string;
  readonly path: string;
  readonly syntax: SyntaxFacts;
  readonly maxFileSizeMb: number;
  readonly limits?: Partial<ViewerLimits>;
  readonly viewer: ViewerState;
  /** Editing support; without it every file is shown read-only. */
  readonly editing?: Omit<EditSessionOptions, "root" | "path" | "document">;
}

const EMPTY_LINES: readonly string[] = Object.freeze([""]);

/** UTF-16 offset of a 1-based character (code point) column, clamped to the line end. */
function offsetOfCharacter(text: string, character: number | undefined): number {
  if (character === undefined || character <= 1) return 0;
  let offset = 0;
  for (let i = 1; i < character && offset < text.length; i++) {
    const code = text.charCodeAt(offset);
    offset += code >= 0xd800 && code <= 0xdbff && offset + 1 < text.length ? 2 : 1;
  }
  return offset;
}

export class FileSession implements Disposable {
  readonly path: string;
  readonly tab: ViewerTab;
  readonly find = new FindModel();
  readonly ui = new Store<SessionUiState>({
    findOpen: false,
    findFocusRequest: 0,
    column: 0,
    pendingReveal: null,
    revealRequest: 0,
  });
  readonly #store = new DisposableStore();
  #loading: Promise<ViewerDocument> | null = null;
  /** The last `revealRequest` the view centered on screen. */
  centeredRequest = 0;
  /** In-place editing, once the file loaded as an editable text document. */
  edit: EditSession | null = null;
  /** Lines of the edited buffer as of its last pause (find, go to line and the status bar use them). */
  #editLines: readonly string[] | null = null;

  constructor(options: FileSessionOptions) {
    this.path = options.path;
    this.tab = new ViewerTab({
      root: options.root,
      path: options.path,
      syntax: options.syntax,
      maxFileSizeMb: options.maxFileSizeMb,
      limits: options.limits,
      viewer: options.viewer,
    });
    // Find follows the document: a reload re-runs the query and keeps the current match nearby.
    let shown: ViewerDocument | null = null;
    const syncFind = () => {
      const document = this.tab.document;
      if (document === shown) return;
      shown = document;
      if (this.edit && document) this.edit.documentChanged(document);
      else if (options.editing && document?.kind === "text" && readOnlyReason(document) === null) {
        this.#startEditing(document, options);
      }
      if (!this.edit)
        this.find.setDocument(document?.kind === "text" ? documentLines(document) : EMPTY_LINES);
      this.#applyPending();
    };
    this.#store.add(toDisposable(this.tab.state.subscribe(syncFind)));
    // The current match is where the reader is: typing a query or stepping through matches
    // moves the active line to it (and the view scrolls it into the middle when off screen).
    let revealed: unknown = null;
    this.#store.add(
      toDisposable(
        this.find.store.subscribe(() => {
          const match = this.find.currentMatch;
          if (!match || match === revealed || !this.ui.get().findOpen) return;
          revealed = match;
          this.revealOffset(match.line, match.start);
        }),
      ),
    );
    this.#store.add(this.find);
    this.#store.add(this.tab);
  }

  get document(): ViewerDocument | null {
    return this.tab.document;
  }

  #startEditing(document: TextDocument, options: FileSessionOptions): void {
    if (!options.editing) return;
    const edit = new EditSession({ ...options.editing, root: options.root, path: options.path, document });
    this.edit = edit;
    this.#editLines = documentLines(document);
    this.find.setDocument(this.#editLines);
    edit.onTextSettled = (lines) => {
      this.#editLines = lines;
      this.find.setDocument(lines);
    };
    edit.onCursor = (line, column) => {
      this.tab.viewer.set((state) => (state.activeLine === line ? state : { ...state, activeLine: line }));
      this.ui.update({ column });
    };
    this.#store.add(edit);
  }

  /** Viewer lines of a text document (one empty line otherwise). */
  lines(): readonly string[] {
    if (this.edit && this.#editLines) return this.#editLines;
    const document = this.tab.document;
    return document?.kind === "text" ? documentLines(document) : EMPTY_LINES;
  }

  /** Loads the file the first time it is shown; later calls return the same promise. */
  ensureLoaded(): Promise<ViewerDocument> {
    this.#loading ??= this.tab.load();
    return this.#loading;
  }

  reload(): Promise<ViewerDocument> {
    this.#loading = this.tab.load();
    return this.#loading;
  }

  /** Shows a 1-based line and character column (search results, Quick Open `file:42`, `:`). */
  reveal(line: number, column?: number): void {
    this.#request({ line: Math.max(0, Math.floor(line) - 1), character: column });
  }

  /** Shows a 0-based line and UTF-16 offset (find matches). */
  revealOffset(line: number, offset: number): void {
    this.#request({ line, offset });
  }

  #request(reveal: PendingReveal): void {
    this.ui.update({ pendingReveal: reveal });
    this.#applyPending();
  }

  /** Moves the active line and column once the document is there to clamp against. */
  #applyPending(): void {
    const reveal = this.ui.get().pendingReveal;
    const document = this.tab.document;
    if (!reveal || document === null) return;
    if (document.kind !== "text") {
      this.ui.update({ pendingReveal: null });
      return;
    }
    const lines = documentLines(document);
    const line = Math.max(0, Math.min(lines.length - 1, reveal.line));
    const text = lines[line] ?? "";
    const offset =
      reveal.offset !== undefined
        ? Math.min(text.length, reveal.offset)
        : offsetOfCharacter(text, reveal.character);
    this.tab.viewer.set((state) => (state.activeLine === line ? state : { ...state, activeLine: line }));
    this.ui.set((state) => ({
      ...state,
      pendingReveal: null,
      column: offset,
      revealRequest: state.revealRequest + 1,
    }));
  }

  openFind(): void {
    this.ui.set((state) => ({ ...state, findOpen: true, findFocusRequest: state.findFocusRequest + 1 }));
  }

  closeFind(): void {
    this.ui.update({ findOpen: false });
  }

  dispose(): void {
    this.#store.dispose();
  }
}
