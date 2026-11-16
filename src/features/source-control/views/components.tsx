/**
 * Binds the views to the feature's controller, so `index.ts` (plain TypeScript) can register
 * them as `ViewComponent`s.
 */
import type { EditorViewProps, ViewComponent, ViewProps } from "@/app/workbench/views";
import type { ScmController } from "../controller";
import { DiffEditorView } from "./diff-view";
import { ScmView } from "./scm-view";

export function scmViewComponent(controller: ScmController): ViewComponent<ViewProps> {
  return (props) => <ScmView {...props} controller={controller} />;
}

export function diffViewComponent(controller: ScmController): ViewComponent<EditorViewProps> {
  return (props) => <DiffEditorView {...props} controller={controller} />;
}
