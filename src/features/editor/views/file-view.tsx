/**
 * The editor view for `file` tabs: loads the tab's session, then shows the code surface, the
 * Markdown preview or an information card, with the find bar floating at the top right.
 */
import { type ReactNode, useEffect } from "react";
import { useApp, useStore } from "@/app/react";
import type { EditorViewProps } from "@/app/workbench/views";
import { Store } from "@/core/store";
import { Icon } from "@/ui/primitives/icon";
import { useMeasure } from "@/ui/primitives/measure";
import { Spinner } from "@/ui/primitives/spinner";
import { useTheme } from "@/ui/theme/theme-context";
import { readOnlyReason } from "../edit-session";
import type { FileSession } from "../file-session";
import type { FileSessions } from "../file-sessions";
import { type DocumentNotice, showsMarkdownPreview } from "../model";
import { CodeSurface } from "./code-surface";
import { DocumentCard } from "./document-card";
import { EditSurface } from "./edit-surface";
import { FindBar } from "./find-bar";
import { MarkdownPreview } from "./markdown-preview";

export interface FileViewDeps {
  readonly sessions: FileSessions;
  /** The resolved external editor's name ("micro"), for the card buttons. */
  readonly editorName: () => string | null;
}

const IDLE_STATE = new Store(0);

function NoticeBar({ notices }: { notices: readonly DocumentNotice[] }) {
  const theme = useTheme();
  const c = theme.colors;
  if (notices.length === 0) return null;
  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={c.editor.bg} paddingX={2}>
      {notices.map((notice) => (
        <text key={notice.kind} fg={c.fg.subtle} selectable={false} wrapMode="none">
          <Icon name="info" tone="subtle" />
          {notice.message}
        </text>
      ))}
    </box>
  );
}

function Loading() {
  const theme = useTheme();
  return (
    <box flexGrow={1} backgroundColor={theme.colors.editor.bg} paddingX={2} paddingTop={1}>
      <text selectable={false}>
        <Spinner label="Opening file" />
      </text>
    </box>
  );
}

function SessionView({
  session,
  focused,
  deps,
}: {
  session: FileSession;
  focused: boolean;
  deps: FileViewDeps;
}) {
  const app = useApp();
  const theme = useTheme();
  const state = useStore(session.tab.state);
  const viewer = useStore(session.tab.viewer);
  const findOpen = useStore(session.ui, (ui) => ui.findOpen);
  const { size, onSizeChange } = useMeasure();

  useEffect(() => {
    void session.ensureLoaded();
  }, [session]);

  const document = state.document;
  const edit = session.edit;
  // A dirty buffer whose file was deleted stays open, so the edits can be saved again.
  const keepEditing = edit !== null && document?.kind === "unavailable" && edit.state.get().dirty;
  let body: ReactNode;
  let notices: readonly DocumentNotice[] = [];
  if (!document) body = <Loading />;
  else if (document.kind === "text" || keepEditing) {
    if (document.kind === "text") notices = document.notices;
    const reason = document.kind === "text" && !edit ? readOnlyReason(document) : null;
    if (reason) notices = [...notices, { kind: "outside-workspace", message: reason }];
    if (document.kind === "text" && showsMarkdownPreview(viewer, document)) {
      body = <MarkdownPreview document={document} content={edit?.text()} focused={focused} />;
    } else if (edit) {
      body = <EditSurface session={session} edit={edit} focused={focused} />;
    } else if (document.kind === "text") {
      body = <CodeSurface session={session} document={document} focused={focused} keysEnabled />;
    }
  } else {
    body = (
      <DocumentCard
        document={document}
        root={app.workspace.root}
        editorName={deps.editorName()}
        width={size.width}
        height={size.height}
      />
    );
  }
  const showFind = findOpen && document?.kind === "text" && !showsMarkdownPreview(viewer, document);
  // Re-render when the buffer's save state changes (conflict bar, the deleted-but-dirty case).
  useStore<unknown>(edit?.state ?? IDLE_STATE);
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      backgroundColor={theme.colors.editor.bg}
      onSizeChange={onSizeChange}
    >
      <NoticeBar notices={notices} />
      {showFind ? <FindBar session={session} width={size.width} /> : null}
      <box flexDirection="column" flexGrow={1} minHeight={0}>
        {body}
      </box>
    </box>
  );
}

/** Creates the `file` editor view bound to the feature's sessions. */
export function createFileView(deps: FileViewDeps) {
  // biome-ignore lint/correctness/noComponentHookFactories: one stable component per activation.
  return function FileView({ tab, focused }: EditorViewProps) {
    // Sessions are recreated when a setting that needs a fresh load changes.
    useStore(deps.sessions.generation);
    const session = deps.sessions.forTab(tab);

    if (!session) return null;
    return <SessionView session={session} focused={focused} deps={deps} />;
  };
}
