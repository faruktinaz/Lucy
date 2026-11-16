/** Shared types of the external editor adapter. */
import type { KnownEditorId } from "./known-editors";

export type EditorEnv = Readonly<Record<string, string | undefined>>;

export interface ResolvedEditor {
  /** Known editor (decides the cursor syntax), or `null` for any other program. */
  readonly id: KnownEditorId | null;
  /** For messages: "Helix", "micro", or the program's base name. */
  readonly displayName: string;
  /** Absolute path of the executable. */
  readonly program: string;
  /** Arguments placed before the file and cursor arguments (from `$EDITOR` or a custom command). */
  readonly args: readonly string[];
  /**
   * A custom command's arguments with `{file}`, `{line}` and `{column}` placeholders, or `null`.
   * When set, it replaces the per-editor cursor syntax entirely.
   */
  readonly template: readonly string[] | null;
  /** Where the choice came from, for the settings UI ("from $EDITOR"). */
  readonly source: "setting" | "visual" | "editor" | "detected";
}

export interface OpenTarget {
  /** Path handed to the editor; `openInExternalEditor` passes an absolute real path. */
  readonly file: string;
  /** 1-based line. */
  readonly line?: number;
  /** 1-based column in characters (Unicode code points), as micro, Helix, Vim and nano count. */
  readonly column?: number;
}

/** The renderer's suspend/resume, injected by the UI. */
export interface TerminalController {
  suspend(): Promise<void>;
  resume(): Promise<void>;
}
