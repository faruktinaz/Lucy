/**
 * Calm information cards for everything that is not shown as text: binary files (with a
 * preview for images when the terminal can draw one), files over the size limit, and the
 * unavailable states (not found, deleted, permission denied, not a regular file). Every button
 * runs a real command, with its keybinding next to it.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { useEffect, useState } from "react";
import { useApp, useOptionalApp } from "@/app/react";
import { sanitizeForDisplay, truncateMiddle } from "@/core/text";
import type { IconName } from "@/themes/icons";
import { FileIcon, Icon } from "@/ui/primitives/icon";
import { KeyHint } from "@/ui/primitives/key-hint";
import { attrs } from "@/ui/primitives/text";
import { usePointer } from "@/ui/primitives/use-pointer";
import { useDensity, useTheme } from "@/ui/theme/theme-context";
import type { BinaryDocument, DocumentAction, TooLargeDocument, UnavailableDocument } from "../model";

/** Images above this size are described, not decoded. */
const IMAGE_PREVIEW_MAX_BYTES = 16 * 1024 * 1024;
/** Rows the card needs below an image (title, description, facts, actions, gaps): the image gets the rest. */
const CARD_TEXT_ROWS = 18;
/** Width of the fact labels ("Dimensions" plus a gap). */
const FACT_LABEL_WIDTH = 12;

interface CardActionSpec {
  readonly label: string;
  readonly command: string;
}

function CardAction({ action }: { action: CardActionSpec }) {
  const theme = useTheme();
  const app = useOptionalApp();
  const pointer = usePointer({ onClick: () => void app?.run(action.command) });
  const c = theme.colors;
  const fg = pointer.hovered ? c.fg.default : c.accent.primary;
  return (
    <box
      height={1}
      flexShrink={0}
      flexDirection="row"
      alignSelf="flex-start"
      paddingX={1}
      backgroundColor={pointer.hovered ? c.state.hover : undefined}
      {...pointer.props}
    >
      <text
        fg={fg}
        selectable={false}
        attributes={attrs({ underline: pointer.hovered && theme.highContrast })}
      >
        {action.label}
      </text>
      <text fg={c.fg.subtle} selectable={false}>
        {"  "}
        <KeyHint command={action.command} />
      </text>
    </box>
  );
}

/** Only actions whose command exists are offered: nothing visible may do nothing. */
function actionSpecs(
  actions: readonly DocumentAction[],
  available: (command: string) => boolean,
  editorName: string | null,
): CardActionSpec[] {
  const specs: CardActionSpec[] = [];
  for (const action of actions) {
    switch (action) {
      case "edit-in-terminal-editor":
        specs.push({
          label: editorName ? `Edit in ${editorName}` : "Open in External Editor",
          command: "editor.openInExternalEditor",
        });
        break;
      case "open-externally":
        specs.push({ label: "Open with Default App", command: "editor.openWithDefaultApp" });
        break;
      case "reveal-in-explorer":
        specs.push({ label: "Reveal in Explorer", command: "explorer.revealActiveFile" });
        break;
      case "retry":
        specs.push({ label: "Try Again", command: "editor.reload" });
        break;
      case "close":
        specs.push({ label: "Close Tab", command: "editor.closeTab" });
        break;
    }
  }
  specs.push({ label: "Copy Path", command: "editor.copyPath" });
  return specs.filter((spec) => available(spec.command));
}

function Facts({ rows }: { rows: readonly (readonly [string, string])[] }) {
  const theme = useTheme();
  const c = theme.colors;
  return (
    <box flexDirection="column" marginTop={1} flexShrink={0}>
      {rows.map(([label, value]) => (
        <text key={label} selectable={false} wrapMode="none">
          <span fg={c.fg.subtle}>{label.padEnd(FACT_LABEL_WIDTH)}</span>
          <span fg={c.fg.default}>{value}</span>
        </text>
      ))}
    </box>
  );
}

/** An image drawn from the file's own bytes (never a URL); nothing when it cannot be drawn. */
function ImagePreview({
  root,
  path,
  size,
  width,
  height,
}: {
  root: string;
  path: string;
  size: number;
  width: number;
  height: number;
}) {
  const theme = useTheme();
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (size > IMAGE_PREVIEW_MAX_BYTES) return;
    let cancelled = false;
    readFile(join(root, ...path.split("/"))).then(
      (data) => {
        if (!cancelled) setBytes(new Uint8Array(data));
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [root, path, size]);
  if (!bytes || failed || width < 8 || height < 4) return null;
  return (
    <box width={width} height={height} flexShrink={0} marginTop={1} backgroundColor={theme.colors.editor.bg}>
      <image source={bytes} fit="fit" width="100%" height="100%" onError={() => setFailed(true)} />
    </box>
  );
}

/**
 * The preview box in cells, shaped like the image so it lines up with the card's left edge. A
 * terminal cell is about twice as tall as it is wide, so one row holds two pixel rows' worth.
 */
function previewBox(
  image: { pixelWidth: number; pixelHeight: number },
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const aspect = image.pixelWidth / Math.max(1, image.pixelHeight);
  let height = Math.max(0, maxHeight);
  let width = Math.round(height * 2 * aspect);
  if (width > maxWidth) {
    width = Math.max(0, maxWidth);
    height = Math.round(width / (2 * aspect));
  }
  return { width, height };
}

export interface DocumentCardProps {
  readonly document: BinaryDocument | TooLargeDocument | UnavailableDocument;
  readonly root: string;
  readonly editorName: string | null;
  readonly width: number;
  readonly height: number;
}

export function DocumentCard({ document, root, editorName, width, height }: DocumentCardProps) {
  const app = useApp();
  const theme = useTheme();
  const density = useDensity();
  const c = theme.colors;
  const available = (command: string) => app.commands.get(command) !== undefined;
  const actions = actionSpecs(document.actions, available, editorName);
  const path = truncateMiddle(sanitizeForDisplay(document.path), Math.max(12, width - 6 - FACT_LABEL_WIDTH));

  let title: string;
  let icon: IconName | null = null;
  let iconColor = c.fg.subtle;
  let description: string;
  let facts: (readonly [string, string])[] = [];
  let image: { size: number; pixelWidth: number; pixelHeight: number } | null = null;
  switch (document.kind) {
    case "binary":
      title = document.name;
      description = document.image
        ? "Open the image with the default app to see it at full size."
        : "Binary files are not shown in the viewer.";
      facts = [
        ["Type", document.typeLabel],
        ["Size", document.sizeLabel],
      ];
      if (document.dimensionsLabel) facts.push(["Dimensions", document.dimensionsLabel]);
      facts.push(["Path", path]);
      if (document.image)
        image = { size: document.size, pixelWidth: document.image.width, pixelHeight: document.image.height };
      break;
    case "too-large":
      title = document.name;
      description = `This file is larger than ${document.limitLabel}, the limit for the viewer (editor.max_file_size_mb).`;
      facts = [
        ["Size", document.sizeLabel],
        ["Limit", document.limitLabel],
        ["Path", path],
      ];
      break;
    default:
      title = document.title;
      icon = document.reason === "deleted" || document.reason === "not-found" ? "info" : "warning";
      iconColor = icon === "warning" ? c.status.warning : c.fg.subtle;
      description = document.message;
      facts = [["Path", path]];
  }
  const notices = document.kind === "unavailable" ? [] : document.notices;

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      backgroundColor={c.editor.bg}
      paddingX={2}
      paddingTop={density.emptyStateTop}
    >
      {image ? (
        <ImagePreview
          root={root}
          path={document.path}
          size={image.size}
          {...previewBox(image, Math.min(64, width - 4), Math.min(16, Math.max(0, height - CARD_TEXT_ROWS)))}
        />
      ) : null}
      <text
        fg={c.fg.default}
        attributes={attrs({ bold: true })}
        selectable={false}
        wrapMode="word"
        marginTop={image ? 1 : 0}
        flexShrink={0}
      >
        {icon ? <Icon name={icon} color={iconColor} /> : <FileIcon name={document.path} />}
        {title}
      </text>
      <text
        fg={c.fg.muted}
        selectable={false}
        wrapMode="word"
        marginTop={density.sectionGap > 0 ? 1 : 0}
        flexShrink={0}
      >
        {description}
      </text>
      {notices.map((notice) => (
        <text key={notice.kind} fg={c.fg.subtle} selectable={false} wrapMode="word" flexShrink={0}>
          {notice.message}
        </text>
      ))}
      <Facts rows={facts} />
      {actions.length > 0 ? (
        <box flexDirection="column" marginTop={1} marginLeft={-1} flexShrink={0}>
          {actions.map((action) => (
            <CardAction key={action.command} action={action} />
          ))}
        </box>
      ) : null}
    </box>
  );
}
