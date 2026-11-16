/**
 * The read-only code surface: OpenTUI's `<line-number>` around `<code>`, plus a paint hook that
 * draws find matches and the active line number on top.
 *
 * Why a paint hook for find matches: `<code>` re-highlights the whole file whenever its
 * `onHighlight`/`onChunks` hooks or style change (about 105 ms per query on 5k lines, see
 * OPENTUI_NOTES §8), and text renderables do not run `renderAfter` themselves. A 1x1 sibling box
 * with a `renderAfter` hook runs after the text is painted on every frame and redraws only the
 * visible matches: their text in `fg.default` on the match background (the pairing the themes
 * are contrast-checked for). Paint hooks cannot read the frame, and alpha blending replaces the
 * glyph color, so the match text is drawn again rather than tinted. The cost is proportional to
 * the visible rows, not to the file size.
 */
import type {
  BoxRenderable,
  CodeRenderable,
  LineNumberRenderable,
  MouseEvent,
  OptimizedBuffer,
  RGBA,
} from "@opentui/core";
import { useEffect, useMemo, useRef } from "react";
import { useApp, useKeyHandler, useStore } from "@/app/react";
import type { KeyStroke } from "@/core/keybindings";
import { sanitizeLineForDisplay } from "@/core/text";
import { attrs } from "@/ui/primitives/text";
import { useTheme } from "@/ui/theme/theme-context";
import { buildDisplayContent, cellColumn, offsetAtCell, sliceCells } from "../display-text";
import type { FileSession } from "../file-session";
import {
  clampScrollTop,
  documentLines,
  type FindMatch,
  lineMatchRange,
  moveActiveLine,
  scrollToReveal,
  type TextDocument,
  type ViewerMove,
} from "../model";
import { useSetting } from "./use-setting";

/** Cells moved by Left/Right while not wrapping. */
const HORIZONTAL_STEP = 4;
/** Columns kept visible to the right of a revealed match. */
const HORIZONTAL_CONTEXT = 8;

export interface CodeSurfaceProps {
  readonly session: FileSession;
  readonly document: TextDocument;
  readonly focused: boolean;
  /** Keys belong to the find field while it has focus. */
  readonly keysEnabled: boolean;
}

interface PaintState {
  lines: readonly string[];
  tabWidth: number;
  wrap: boolean;
  matches: readonly FindMatch[];
  current: number;
  showMatches: boolean;
  activeLine: number;
  showNumbers: boolean;
  highlightActive: boolean;
  colors: {
    match: RGBA;
    matchActive: RGBA;
    number: RGBA;
    numberActive: RGBA;
    activeBg: RGBA;
    bg: RGBA;
    text: RGBA;
  };
  /** High Contrast: the current match is also bold and underlined (never color alone). */
  currentAttributes: number;
}

/** Visual rows (with wrapping) of a source line: first and last index, or null. */
function visualRows(code: CodeRenderable, line: number): { first: number; last: number } | null {
  const sources = code.lineInfo.lineSources;
  let low = 0;
  let high = sources.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((sources[mid] as number) < line) low = mid + 1;
    else high = mid;
  }
  if (low >= sources.length || sources[low] !== line) return null;
  let last = low;
  while (last + 1 < sources.length && sources[last + 1] === line) last++;
  return { first: low, last };
}

/** Redraws the display text of cells `[from, to)` of one row on a match background. */
function paintSpan(
  buffer: OptimizedBuffer,
  code: CodeRenderable,
  row: number,
  display: string,
  from: number,
  to: number,
  shift: number,
  fg: RGBA,
  bg: RGBA,
  attributes: number,
): void {
  // Cells are in line coordinates; `shift` maps them to the visible window.
  const visibleFrom = Math.max(from, shift);
  const visibleTo = Math.min(to, shift + code.width);
  if (visibleTo <= visibleFrom) return;
  const { text, start } = sliceCells(display, visibleFrom, visibleTo);
  // A zero-width match (`^`, `$`) or one past the line end still gets a one-cell marker.
  const shown = text === "" ? " " : text;
  buffer.drawText(shown, code.x + start - shift, code.y + row, fg, bg, attributes);
}

function paintOverlay(
  buffer: OptimizedBuffer,
  code: CodeRenderable | null,
  gutter: LineNumberRenderable | null,
  state: PaintState,
): void {
  if (!code || code.isDestroyed) return;
  const { colors } = state;
  const height = code.height;
  const top = code.scrollY;

  if (state.showMatches && state.matches.length > 0) {
    if (!state.wrap) {
      for (let row = 0; row < height; row++) {
        const line = top + row;
        if (line >= state.lines.length) break;
        const [from, to] = lineMatchRange(state.matches, line);
        if (from === to) continue;
        const text = state.lines[line] as string;
        const display = sanitizeLineForDisplay(text, { tabWidth: state.tabWidth });
        for (let i = from; i < to; i++) {
          const match = state.matches[i] as FindMatch;
          const a = cellColumn(text, match.start, state.tabWidth);
          const b = Math.max(a + 1, cellColumn(text, match.end, state.tabWidth));
          const current = i === state.current;
          paintSpan(
            buffer,
            code,
            row,
            display,
            a,
            b,
            code.scrollX,
            colors.text,
            current ? colors.matchActive : colors.match,
            current ? state.currentAttributes : 0,
          );
        }
      }
    } else {
      const info = code.lineInfo;
      for (let row = 0; row < height; row++) {
        const visual = top + row;
        if (visual >= info.lineSources.length) break;
        const line = info.lineSources[visual] as number;
        const [from, to] = lineMatchRange(state.matches, line);
        if (from === to) continue;
        const text = state.lines[line] ?? "";
        const display = sanitizeLineForDisplay(text, { tabWidth: state.tabWidth });
        const rowStart = info.lineStartCols[visual] ?? 0;
        const rowEnd = Math.max(rowStart + 1, rowStart + (info.lineWidthCols[visual] ?? 0));
        for (let i = from; i < to; i++) {
          const match = state.matches[i] as FindMatch;
          const a = cellColumn(text, match.start, state.tabWidth);
          const b = Math.max(a + 1, cellColumn(text, match.end, state.tabWidth));
          if (b <= rowStart || a >= rowEnd) continue;
          const current = i === state.current;
          paintSpan(
            buffer,
            code,
            row,
            display,
            Math.max(a, rowStart),
            Math.min(b, rowEnd),
            rowStart,
            colors.text,
            current ? colors.matchActive : colors.match,
            current ? state.currentAttributes : 0,
          );
        }
      }
    }
  }

  // The active line's number in the brighter token: the gutter itself has one color for all.
  if (state.showNumbers && gutter && !gutter.isDestroyed) {
    let row = state.activeLine - top;
    if (state.wrap) {
      const first = code.getLineSources(top, height).indexOf(state.activeLine);
      row = first;
    }
    if (row >= 0 && row < height) {
      const label = String(state.activeLine + 1);
      const right = code.x - gutter.getGutterLayout().paddingRight;
      const x = right - label.length;
      if (x >= gutter.x) {
        buffer.drawText(
          label,
          x,
          code.y + row,
          colors.numberActive,
          state.highlightActive ? colors.activeBg : colors.bg,
        );
      }
    }
  }
}

export function CodeSurface({ session, document, focused, keysEnabled }: CodeSurfaceProps) {
  const app = useApp();
  const theme = useTheme();
  const c = theme.colors;
  const viewer = useStore(session.tab.viewer);
  const ui = useStore(session.ui);
  const find = useStore(session.find.store);
  const tabWidth = useSetting("editor.tabWidth");
  const showNumbers = useSetting("editor.lineNumbers");
  const highlightActive = useSetting("editor.highlightActiveLine");
  const codeRef = useRef<CodeRenderable>(null);
  const gutterRef = useRef<LineNumberRenderable>(null);
  const painterRef = useRef<BoxRenderable>(null);
  const heightRef = useRef(0);
  /**
   * The last reveal, centered at this height from this scroll position. The first layout can
   * report a provisional height; until the user moves, a new height re-centers from scratch.
   */
  const centered = useRef<{ height: number; fromScrollTop: number; moved: boolean } | null>(null);
  const lines = documentLines(document);
  const content = useMemo(() => buildDisplayContent(lines, tabWidth), [lines, tabWidth]);
  const highlight = document.highlight;
  const client = highlight.enabled ? app.services.syntax.client : undefined;
  const wrap = viewer.wrap;

  const paint = useRef<PaintState>(null as unknown as PaintState);
  paint.current = {
    lines,
    tabWidth,
    wrap,
    matches: find.matches,
    current: find.current,
    showMatches: ui.findOpen,
    activeLine: viewer.activeLine,
    showNumbers,
    highlightActive,
    colors: {
      match: c.editor.findMatchBg,
      matchActive: c.editor.findMatchActiveBg,
      number: c.editor.lineNumber,
      numberActive: c.editor.lineNumberActive,
      activeBg: c.editor.activeLineBg,
      bg: c.editor.bg,
      text: c.fg.default,
    },
    currentAttributes: theme.highContrast ? attrs({ bold: true, underline: true }) : 0,
  };

  // Active line background, gutter included (setLineColor fills every wrapped row of the line).
  // New content resets the gutter's colors, so `content` is a trigger too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: content is a re-apply trigger.
  useEffect(() => {
    const gutter = gutterRef.current;
    if (!gutter) return;
    gutter.clearAllLineColors();
    if (highlightActive)
      gutter.setLineColor(viewer.activeLine, {
        gutter: c.editor.activeLineBg,
        content: c.editor.activeLineBg,
      });
  }, [viewer.activeLine, highlightActive, c.editor.activeLineBg, content]);

  // The model owns the scroll position; the renderable follows it (also after new content).
  // biome-ignore lint/correctness/useExhaustiveDependencies: content is a re-apply trigger.
  useEffect(() => {
    const code = codeRef.current;
    if (!code) return;
    if (code.scrollY !== viewer.scrollTop) code.scrollY = viewer.scrollTop;
    const left = wrap ? 0 : viewer.scrollLeft;
    if (code.scrollX !== left) code.scrollX = left;
    painterRef.current?.requestRender();
  }, [viewer.scrollTop, viewer.scrollLeft, wrap, content]);

  // Matches, the current match and the active line are painted by the hook: ask for a frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are the repaint triggers.
  useEffect(() => {
    painterRef.current?.requestRender();
  }, [find.matches, find.current, ui.findOpen, viewer.activeLine, theme.revision]);

  /** Keeps the active line on screen after a keyboard move, wrap-aware. */
  const revealActive = (align: "nearest" | "center") => {
    const code = codeRef.current;
    const height = Math.max(1, heightRef.current);
    const state = session.tab.viewer.get();
    if (!code) return;
    let scrollTop: number;
    if (!state.wrap) {
      scrollTop = scrollToReveal(
        state.scrollTop,
        state.activeLine,
        { lineCount: document.lineCount, viewportHeight: height },
        align,
      );
    } else {
      const rows = visualRows(code, state.activeLine);
      if (!rows) return;
      const total = code.lineInfo.lineSources.length;
      const max = Math.max(0, total - height);
      if (align === "center" && (rows.first < state.scrollTop || rows.last >= state.scrollTop + height)) {
        scrollTop = rows.first - Math.floor((height - 1) / 2);
      } else if (rows.first < state.scrollTop) scrollTop = rows.first;
      else if (rows.last >= state.scrollTop + height)
        scrollTop = Math.min(rows.first, rows.last - height + 1);
      else scrollTop = state.scrollTop;
      scrollTop = Math.max(0, Math.min(max, scrollTop));
    }
    let scrollLeft = state.scrollLeft;
    // Before the first layout the width is unknown: horizontal reveal waits for a real width.
    if (!state.wrap && code.width > HORIZONTAL_CONTEXT * 2) {
      const text = lines[state.activeLine] ?? "";
      const cell = cellColumn(text, session.ui.get().column, tabWidth);
      const width = code.width;
      if (cell < scrollLeft) scrollLeft = Math.max(0, cell - HORIZONTAL_CONTEXT);
      else if (cell > scrollLeft + width - 2) scrollLeft = Math.max(0, cell - width + HORIZONTAL_CONTEXT);
    }
    if (scrollTop !== state.scrollTop || scrollLeft !== state.scrollLeft) {
      session.tab.viewer.set({ ...state, scrollTop, scrollLeft });
    }
  };

  // Reveal requests (go to line, Quick Open `file:42`, search results, find): center once
  // the viewport is measured, also for requests made while another tab was showing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revealActive reads live state.
  useEffect(() => {
    if (ui.revealRequest === session.centeredRequest || heightRef.current === 0) return;
    session.centeredRequest = ui.revealRequest;
    centerReveal();
  }, [ui.revealRequest, session, content]);

  const centerReveal = (fromScrollTop = session.tab.viewer.get().scrollTop) => {
    revealActive("center");
    centered.current = { height: heightRef.current, fromScrollTop, moved: false };
  };

  const userMoved = () => {
    if (centered.current) centered.current.moved = true;
  };

  const move = (to: ViewerMove) => {
    userMoved();
    const state = session.tab.viewer.get();
    const height = Math.max(1, heightRef.current);
    if (!state.wrap) {
      session.tab.viewer.set(
        moveActiveLine(state, to, { lineCount: document.lineCount, viewportHeight: height }),
      );
    } else {
      // Wrapped rows: move by source lines, then scroll by visual rows.
      const moved = moveActiveLine(state, to, { lineCount: document.lineCount, viewportHeight: height });
      if (moved.activeLine !== state.activeLine)
        session.tab.viewer.set({ ...state, activeLine: moved.activeLine });
      revealActive(to.kind === "line" ? "center" : "nearest");
    }
  };

  const scrollRows = (delta: number) => {
    userMoved();
    const code = codeRef.current;
    const state = session.tab.viewer.get();
    const total = state.wrap && code ? code.lineInfo.lineSources.length : document.lineCount;
    const scrollTop = clampScrollTop(state.scrollTop + delta, total, Math.max(1, heightRef.current));
    if (scrollTop !== state.scrollTop) session.tab.viewer.set({ ...state, scrollTop });
  };

  const scrollColumns = (delta: number) => {
    const state = session.tab.viewer.get();
    if (state.wrap) return;
    const code = codeRef.current;
    const max = code ? code.maxScrollX : Number.MAX_SAFE_INTEGER;
    const scrollLeft = Math.max(0, Math.min(max, state.scrollLeft + delta));
    if (scrollLeft !== state.scrollLeft) session.tab.viewer.set({ ...state, scrollLeft });
  };

  useKeyHandler(
    (key: KeyStroke) => {
      if (key.ctrl || key.alt || key.super) {
        if (key.ctrl && (key.key === "home" || key.key === "end")) {
          move({ kind: key.key === "home" ? "start" : "end" });
          return true;
        }
        return false;
      }
      switch (key.key) {
        case "up":
        case "k":
          move({ kind: "lines", delta: -1 });
          return true;
        case "down":
        case "j":
          move({ kind: "lines", delta: 1 });
          return true;
        case "pageup":
          move({ kind: "pages", delta: -1 });
          return true;
        case "pagedown":
        case "space":
          move({ kind: "pages", delta: 1 });
          return true;
        case "home":
          move({ kind: "start" });
          return true;
        case "end":
          move({ kind: "end" });
          return true;
        case "left":
        case "h":
          scrollColumns(-HORIZONTAL_STEP);
          return true;
        case "right":
        case "l":
          scrollColumns(HORIZONTAL_STEP);
          return true;
        case "/":
          session.openFind();
          return true;
        case "escape":
          if (!session.ui.get().findOpen) return false;
          session.closeFind();
          return true;
        default:
          return false;
      }
    },
    { enabled: focused && keysEnabled },
  );

  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return;
    userMoved();
    const code = codeRef.current;
    if (!code) return;
    const row = event.y - code.y;
    if (row < 0 || row >= code.height) return;
    const visual = code.scrollY + row;
    let line: number;
    let cell: number;
    if (wrap) {
      const info = code.lineInfo;
      const index = Math.min(visual, info.lineSources.length - 1);
      line = info.lineSources[index] ?? 0;
      cell = Math.max(0, event.x - code.x) + (info.lineStartCols[index] ?? 0);
    } else {
      line = Math.min(visual, document.lineCount - 1);
      cell = Math.max(0, event.x - code.x) + code.scrollX;
    }
    const offset = event.x < code.x ? 0 : offsetAtCell(lines[line] ?? "", cell, tabWidth);
    session.ui.update({ column: offset });
    const state = session.tab.viewer.get();
    if (state.activeLine !== line) session.tab.viewer.set({ ...state, activeLine: line });
  };

  const onMouseScroll = (event: MouseEvent) => {
    const direction = event.scroll?.direction;
    const delta = event.scroll?.delta ?? 1;
    // The wheel scrolls without moving the active line, as in VS Code.
    if (direction === "up") scrollRows(-delta);
    else if (direction === "down") scrollRows(delta);
    else if (direction === "left") scrollColumns(-delta * HORIZONTAL_STEP);
    else if (direction === "right") scrollColumns(delta * HORIZONTAL_STEP);
    // `<code>` scrolls itself as well; the model value wins on the next effect run.
    queueMicrotask(() => {
      const code = codeRef.current;
      const state = session.tab.viewer.get();
      if (code && code.scrollY !== state.scrollTop) code.scrollY = state.scrollTop;
      if (code && !state.wrap && code.scrollX !== state.scrollLeft) code.scrollX = state.scrollLeft;
    });
  };

  const syntaxStyle = theme.syntaxStyle;
  if (!syntaxStyle) return null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: an OpenTUI renderable, not a DOM element.
    <box
      flexGrow={1}
      minHeight={0}
      backgroundColor={c.editor.bg}
      onMouseDown={onMouseDown}
      onMouseScroll={onMouseScroll}
      onSizeChange={function (this: BoxRenderable) {
        heightRef.current = this.height;
        session.tab.setViewportHeight(this.height);
        const last = centered.current;
        if (session.ui.get().revealRequest !== session.centeredRequest) {
          session.centeredRequest = session.ui.get().revealRequest;
          centerReveal();
        } else if (last && !last.moved && last.height !== this.height) {
          session.tab.viewer.set((state) => ({ ...state, scrollTop: last.fromScrollTop }));
          centerReveal(last.fromScrollTop);
        }
      }}
    >
      <line-number
        ref={gutterRef}
        fg={c.editor.lineNumber}
        bg={c.editor.bg}
        minWidth={3}
        paddingRight={2}
        showLineNumbers={showNumbers}
        width="100%"
        height="100%"
      >
        <code
          ref={codeRef}
          content={content}
          filetype={highlight.enabled ? highlight.filetype : undefined}
          syntaxStyle={syntaxStyle}
          treeSitterClient={client}
          fg={c.fg.default}
          bg={c.editor.bg}
          wrapMode={wrap ? "word" : "none"}
          // The source view shows the file as it is: `<code>` hides Markdown markers by default.
          conceal={false}
          selectionBg={c.editor.selectionBg}
          width="100%"
          height="100%"
        />
      </line-number>
      <box
        ref={painterRef}
        position="absolute"
        left={0}
        top={0}
        width={1}
        height={1}
        zIndex={1}
        renderAfter={function (this: BoxRenderable, buffer: OptimizedBuffer) {
          paintOverlay(buffer, codeRef.current, gutterRef.current, paint.current);
        }}
      />
    </box>
  );
}
