/**
 * The compact find bar at the top right of the viewer: query, case / whole word / regex
 * toggles, the match label, previous / next and close. Typing is debounced so a large file
 * stays responsive; Enter and Shift+Enter (and F3 / Shift+F3 through their commands) step
 * through matches, Escape closes and gives the keyboard back to the viewer.
 */
import { useEffect, useRef, useState } from "react";
import { useApp, useKeyHandler, useStore } from "@/app/react";
import type { KeyStroke } from "@/core/keybindings";
import { sanitizeForDisplay, truncateEnd } from "@/core/text";
import { IconButton } from "@/ui/primitives/button";
import { attrs } from "@/ui/primitives/text";
import type { TextFieldHandle } from "@/ui/primitives/text-field";
import { TextField } from "@/ui/primitives/text-field";
import { usePointer } from "@/ui/primitives/use-pointer";
import { useTheme } from "@/ui/theme/theme-context";
import type { FileSession } from "../file-session";
import type { FindOptions } from "../model";

/** Typing pauses this long before the query runs: one search per burst of keys. */
export const FIND_DEBOUNCE_MS = 60;

const TOGGLES: readonly {
  readonly option: keyof FindOptions;
  readonly label: string;
  readonly title: string;
}[] = [
  { option: "caseSensitive", label: "Aa", title: "Match Case" },
  { option: "wholeWord", label: "ab", title: "Match Whole Word" },
  { option: "regex", label: ".*", title: "Use Regular Expression" },
];

/** Width of the label column, so the buttons do not jump while the count changes. */
const LABEL_WIDTH = 13;

function OptionToggle({
  label,
  title,
  on,
  onPress,
}: {
  label: string;
  title: string;
  on: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const c = theme.colors;
  const pointer = usePointer({ onClick: onPress, hint: { text: `${title}: ${on ? "on" : "off"}` } });
  const fg = on ? c.state.selectedFg : pointer.hovered ? c.fg.default : c.fg.subtle;
  const bg = pointer.pressed
    ? c.state.active
    : on
      ? c.state.selectedBg
      : pointer.hovered
        ? c.state.hover
        : undefined;
  return (
    <box height={1} width={4} flexShrink={0} justifyContent="center" backgroundColor={bg} {...pointer.props}>
      <text fg={fg} selectable={false} attributes={attrs({ bold: on, underline: on && theme.highContrast })}>
        {label}
      </text>
    </box>
  );
}

export interface FindBarProps {
  readonly session: FileSession;
  /** Width available in the viewer. */
  readonly width: number;
}

export function FindBar({ session, width }: FindBarProps) {
  const app = useApp();
  const theme = useTheme();
  const c = theme.colors;
  const find = useStore(session.find.store);
  const ui = useStore(session.ui);
  const field = useRef<TextFieldHandle>(null);
  const [initial] = useState(() => find.query);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [fieldFocused, setFieldFocused] = useState(false);

  // The field's icon turns accent while it has focus; the router tracks that as `inputFocus`.
  useEffect(() => {
    const sync = () => setFieldFocused(app.contextKeys.get("inputFocus") === true);
    sync();
    const subscription = app.contextKeys.onDidChange((event) => {
      if (event.keys.includes("inputFocus")) sync();
    });
    return () => subscription.dispose();
  }, [app]);

  // Ctrl+F (again) focuses the field.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the request counter is the trigger.
  useEffect(() => {
    field.current?.focus();
  }, [ui.findFocusRequest]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const runQuery = (value: string) => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const viewer = session.tab.viewer.get();
    session.find.setQuery(value, { line: viewer.activeLine, column: session.ui.get().column });
  };

  const onInput = (value: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => runQuery(value), FIND_DEBOUNCE_MS);
  };

  /** Applies a query still waiting for its debounce, so Enter always acts on what is typed. */
  const flush = () => {
    if (timer.current === undefined) return;
    runQuery(field.current?.value ?? find.query);
  };

  const close = () => {
    flush();
    session.closeFind();
    app.focus.focus("editor");
  };

  useKeyHandler(
    (key: KeyStroke) => {
      const inField = app.contextKeys.get("inputFocus") === true;
      if (key.key === "escape") {
        close();
        return true;
      }
      if (inField && (key.key === "enter" || key.key === "return")) {
        flush();
        void app.run(key.shift ? "editor.findPrevious" : "editor.findNext");
        return true;
      }
      return false;
    },
    { whileInputFocused: true },
  );

  const toggle = (option: keyof FindOptions) => {
    flush();
    session.find.toggleOption(option);
  };

  const barWidth = Math.max(30, Math.min(62, width - 2));
  const invalid = find.status === "invalid";
  const noResults = find.query !== "" && find.status === "done" && find.matches.length === 0;
  const label = truncateEnd(find.label, LABEL_WIDTH - 1);
  const labelTone = invalid || noResults ? c.status.warning : c.fg.muted;
  const message = find.error ? truncateEnd(sanitizeForDisplay(find.error), barWidth - 4) : null;
  const navDisabled = find.matches.length === 0;

  // Its own band at the top of the viewer (like VS Code's extra space above the editor), so the
  // bar never covers the line holding the current match.
  return (
    <box
      flexDirection="column"
      alignItems="flex-end"
      flexShrink={0}
      paddingRight={1}
      backgroundColor={c.editor.bg}
    >
      <box height={1} width={barWidth} flexDirection="row" backgroundColor={c.bg.raised} paddingLeft={1}>
        <box flexGrow={1} flexShrink={1} minWidth={10}>
          <TextField
            ref={field}
            icon="search"
            placeholder="Find"
            value={initial}
            focused={fieldFocused}
            invalid={invalid}
            onInput={onInput}
            onSubmit={() => {
              flush();
              void app.run("editor.findNext");
            }}
          />
        </box>
        {TOGGLES.map((toggleDef) => (
          <OptionToggle
            key={toggleDef.option}
            label={toggleDef.label}
            title={toggleDef.title}
            on={find.options[toggleDef.option]}
            onPress={() => toggle(toggleDef.option)}
          />
        ))}
        <box width={LABEL_WIDTH} flexShrink={0} paddingLeft={1}>
          <text fg={labelTone} selectable={false} wrapMode="none">
            {label}
          </text>
        </box>
        <IconButton
          icon="arrowUp"
          disabled={navDisabled}
          surface={c.bg.raised}
          hint={{ text: "Previous Match", keys: app.keybindingFor("editor.findPrevious") }}
          onPress={() => void app.run("editor.findPrevious")}
        />
        <IconButton
          icon="arrowDown"
          disabled={navDisabled}
          surface={c.bg.raised}
          hint={{ text: "Next Match", keys: app.keybindingFor("editor.findNext") }}
          onPress={() => void app.run("editor.findNext")}
        />
        <IconButton
          icon="close"
          surface={c.bg.raised}
          hint={{ text: "Close", keys: "escape" }}
          onPress={close}
        />
      </box>
      {message ? (
        <box height={1} width={barWidth} backgroundColor={c.bg.raised} paddingX={2}>
          <text fg={c.status.warning} selectable={false} wrapMode="none">
            {message}
          </text>
        </box>
      ) : null}
    </box>
  );
}
