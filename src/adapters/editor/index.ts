/**
 * External terminal editor: detection, the `editor.external` setting, per-editor cursor
 * syntax, and the suspend → edit → resume flow. Import from `@/adapters/editor`.
 */
export { buildOpenCommand } from "./build-open-command";
export {
  type DetectedEditor,
  describeEnvEditor,
  detectEditors,
  type EditorDetection,
  type EnvEditorInfo,
  findProgram,
} from "./detect-editors";
export {
  type CursorSyntax,
  KNOWN_EDITORS,
  type KnownEditor,
  type KnownEditorId,
  knownEditorById,
  knownEditorForProgram,
} from "./known-editors";
export {
  type ExternalEditorResult,
  type OpenInExternalEditorOptions,
  openInExternalEditor,
} from "./open-in-external-editor";
export { EDITOR_PLACEHOLDER, type EditorResolution, resolveEditor } from "./resolve-editor";
export { type SplitCommandResult, splitCommandLine } from "./split-command";
export type { EditorEnv, OpenTarget, ResolvedEditor, TerminalController } from "./types";
