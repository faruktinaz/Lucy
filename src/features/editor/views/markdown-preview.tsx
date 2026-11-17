/**
 * The rendered Markdown preview (OpenTUI's `<markdown>` styled from the theme's `markup.*`
 * groups), scrolled natively. The source and the preview keep separate positions: the source
 * keeps the viewer state, the preview starts at the top.
 */
import type { ScrollBoxRenderable } from "@opentui/core";
import { useMemo, useRef } from "react";
import { useApp, useKeyHandler } from "@/app/react";
import type { KeyStroke } from "@/core/keybindings";
import { useTheme } from "@/ui/theme/theme-context";
import { buildDisplayContent } from "../display-text";
import { documentLines, type TextDocument } from "../model";
import { useSetting } from "./use-setting";

export interface MarkdownPreviewProps {
  readonly document: TextDocument;
  /** The edited buffer's text, when it differs from the document on disk. */
  readonly content?: string;
  readonly focused: boolean;
}

export function MarkdownPreview({ document, content: edited, focused }: MarkdownPreviewProps) {
  const app = useApp();
  const theme = useTheme();
  const c = theme.colors;
  const tabWidth = useSetting("editor.tabWidth");
  const scroll = useRef<ScrollBoxRenderable>(null);
  const lines = edited === undefined ? documentLines(document) : edited.split("\n");
  // Same display safety as the source view: control characters become visible pictures.
  const content = useMemo(() => buildDisplayContent(lines, tabWidth), [lines, tabWidth]);

  useKeyHandler(
    (key: KeyStroke) => {
      const box = scroll.current;
      if (!box || key.ctrl || key.alt || key.super) return false;
      const page = Math.max(1, box.viewport.height - 1);
      switch (key.key) {
        case "up":
        case "k":
          box.scrollBy(-1);
          return true;
        case "down":
        case "j":
          box.scrollBy(1);
          return true;
        case "pageup":
          box.scrollBy(-page);
          return true;
        case "pagedown":
        case "space":
          box.scrollBy(page);
          return true;
        case "home":
          box.scrollTo(0);
          return true;
        case "end":
          box.scrollTo(box.scrollHeight);
          return true;
        default:
          return false;
      }
    },
    { enabled: focused },
  );

  const syntaxStyle = theme.syntaxStyle;
  if (!syntaxStyle) return null;
  return (
    <scrollbox
      ref={scroll}
      flexGrow={1}
      minHeight={0}
      backgroundColor={c.editor.bg}
      scrollY
      verticalScrollbarOptions={{
        trackOptions: { foregroundColor: c.scrollbar.thumb, backgroundColor: c.editor.bg },
      }}
    >
      <box paddingX={2} paddingTop={1} paddingBottom={1} flexDirection="column">
        <markdown
          content={content}
          syntaxStyle={syntaxStyle}
          treeSitterClient={app.services.syntax.client}
          fg={c.fg.default}
          bg={c.editor.bg}
          conceal
        />
      </box>
    </scrollbox>
  );
}
