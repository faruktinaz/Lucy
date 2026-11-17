/**
 * Honest placeholders for features that are not built yet. Each says plainly that the
 * feature is not available, and offers only actions that really work (Quick Open, the
 * palette). Feature stubs create them with these factories, so stubs need no JSX.
 */
import { useStore } from "@/app/react";
import type { Readable } from "@/app/workbench/readable";
import type { EditorViewProps, ViewComponent, ViewProps } from "@/app/workbench/views";
import { sanitizeForDisplay } from "@/core/text";
import type { IconName } from "@/themes/icons";
import { EmptyState, type StateAction } from "../primitives/states";
import { useDensity, useTheme } from "../theme/theme-context";

export interface PlaceholderOptions {
  title: string;
  description: string;
  actions?: readonly StateAction[];
  icon?: IconName;
  /** Live facts shown under the description (real data, e.g. the Git branch). */
  details?: Readable<readonly string[]>;
}

const NONE: readonly string[] = [];
const NO_DETAILS: Readable<readonly string[]> = { get: () => NONE, subscribe: () => () => {} };

function LiveDetails({ source }: { source: Readable<readonly string[]> }) {
  return <DetailLines lines={useStore(source)} />;
}

function DetailLines({ lines }: { lines: readonly string[] }) {
  const theme = useTheme();
  const density = useDensity();
  if (lines.length === 0) return null;
  return (
    <box flexDirection="column" paddingX={density.rowPaddingX + 1} marginTop={1} flexShrink={0}>
      {lines.map((line) => (
        <text key={line} fg={theme.colors.fg.subtle} selectable={false} wrapMode="word">
          {sanitizeForDisplay(line)}
        </text>
      ))}
    </box>
  );
}

function PlaceholderBody({ options }: { options: PlaceholderOptions }) {
  return (
    <box flexDirection="column" flexGrow={1}>
      <EmptyState title={options.title} description={options.description} actions={options.actions} />
      <LiveDetails source={options.details ?? NO_DETAILS} />
    </box>
  );
}

/** A sidebar, auxiliary or bottom-panel view that says the feature is not available yet. */
export function placeholderView(options: PlaceholderOptions): ViewComponent<ViewProps> {
  return () => <PlaceholderBody options={options} />;
}

interface PlaceholderEditorOptions {
  description: string;
  actions?: readonly StateAction[];
  /** Extra lines for a tab (its path, a config file location). */
  details?: (props: EditorViewProps) => readonly string[];
}

function PlaceholderEditorBody({
  options,
  props,
}: {
  options: PlaceholderEditorOptions;
  props: EditorViewProps;
}) {
  const theme = useTheme();
  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.colors.bg.base}>
      <EmptyState
        title={props.tab.title}
        description={options.description}
        actions={options.actions ?? [{ label: "Close tab", command: "editor.closeTab" }]}
      />
      <DetailLines lines={options.details?.(props) ?? NONE} />
    </box>
  );
}

/** An editor view for a tab kind whose feature is not built yet. */
export function placeholderEditor(options: PlaceholderEditorOptions): ViewComponent<EditorViewProps> {
  return (props) => <PlaceholderEditorBody options={options} props={props} />;
}
