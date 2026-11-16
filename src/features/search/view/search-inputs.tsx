/**
 * The field block of the Search view:
 *
 *   ▸ ⌕ pattern…            Aa ab .*      the chevron shows the glob fields
 *     include  src/**, *.ts               only while the details are open
 *     exclude  *.test.ts
 *     ✗ Invalid regular expression: …     the engine's message, next to the field
 *
 * Every field is the design system's `TextField` on the inset surface; the toggles sit in the
 * same inset strip so the row reads as one control.
 */
import { type RefObject, useEffect, useRef } from "react";
import { useApp } from "@/app/react";
import type { SearchQueryInput } from "@/features/search/model";
import { Icon } from "@/ui/primitives/icon";
import { TextField, type TextFieldHandle } from "@/ui/primitives/text-field";
import { useTheme } from "@/ui/theme/theme-context";
import type { SearchController, SearchFocusTarget } from "../search-controller";
import { DetailsChevron, SearchToggle } from "./search-toggle";

/** Width of the details chevron column; the fields start right after it. */
export const FIELD_INDENT = 2;

function useRegisteredField(
  controller: SearchController,
  target: Exclude<SearchFocusTarget, "results">,
): RefObject<TextFieldHandle | null> {
  const ref = useRef<TextFieldHandle>(null);
  useEffect(() => {
    const registration = controller.registerField(target, {
      focus: () => ref.current?.focus(),
      blur: () => ref.current?.blur(),
    });
    return () => registration.dispose();
  }, [controller, target]);
  return ref;
}

export interface PatternRowProps {
  controller: SearchController;
  query: SearchQueryInput;
  focused: boolean;
  detailsOpen: boolean;
  invalid: boolean;
}

export function PatternRow({ controller, query, focused, detailsOpen, invalid }: PatternRowProps) {
  const app = useApp();
  const theme = useTheme();
  const c = theme.colors;
  const ref = useRegisteredField(controller, "pattern");
  const hint = (text: string, command: string, on?: boolean) => ({
    text: on === undefined ? text : `${text} (${on ? "on" : "off"})`,
    keys: app.keybindingFor(command),
  });
  const caseOn = query.caseMode === "sensitive";
  const hasGlobs = query.include !== "" || query.exclude !== "";
  return (
    <box height={1} flexDirection="row" flexShrink={0}>
      <DetailsChevron
        open={detailsOpen}
        active={!detailsOpen && hasGlobs}
        hint={hint(
          detailsOpen
            ? "Hide files to include and exclude"
            : hasGlobs
              ? "Show files to include and exclude (set)"
              : "Show files to include and exclude",
          "search.toggleDetails",
        )}
        onPress={() => controller.toggleDetails()}
      />
      <box flexGrow={1} flexShrink={1} minWidth={0} flexDirection="row" backgroundColor={c.bg.inset}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: an OpenTUI renderable, not a DOM element. */}
        <box
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          onMouseDown={(event) => {
            if (event.button === 0) controller.setFocus("pattern");
          }}
        >
          <TextField
            ref={ref}
            width="100%"
            icon="search"
            placeholder="Search"
            value={query.pattern}
            focused={focused}
            invalid={invalid}
            onInput={(value) => controller.setPattern(value)}
          />
        </box>
        <SearchToggle
          label="Aa"
          on={caseOn}
          surface={c.bg.inset}
          hint={hint("Match Case", "search.toggleMatchCase", caseOn)}
          onPress={() => controller.toggleMatchCase()}
        />
        <box width={1} flexShrink={0} />
        <SearchToggle
          label="ab"
          underline
          on={query.wholeWord}
          surface={c.bg.inset}
          hint={hint("Match Whole Word", "search.toggleWholeWord", query.wholeWord)}
          onPress={() => controller.toggleWholeWord()}
        />
        <box width={1} flexShrink={0} />
        <SearchToggle
          label=".*"
          on={query.isRegex}
          surface={c.bg.inset}
          hint={hint("Use Regular Expression", "search.toggleRegex", query.isRegex)}
          onPress={() => controller.toggleRegex()}
        />
        <box width={1} flexShrink={0} />
      </box>
    </box>
  );
}

export interface GlobRowProps {
  controller: SearchController;
  target: "include" | "exclude";
  value: string;
  focused: boolean;
}

const GLOB_ROWS = {
  include: { label: "include", placeholder: "src/**, *.ts" },
  exclude: { label: "exclude", placeholder: "*.test.ts, dist" },
} as const;

export function GlobRow({ controller, target, value, focused }: GlobRowProps) {
  const theme = useTheme();
  const c = theme.colors;
  const ref = useRegisteredField(controller, target);
  const spec = GLOB_ROWS[target];
  return (
    <box height={1} flexDirection="row" flexShrink={0} paddingLeft={FIELD_INDENT}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: an OpenTUI renderable, not a DOM element. */}
      <box
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        flexDirection="row"
        backgroundColor={c.bg.inset}
        paddingLeft={1}
        onMouseDown={(event) => {
          if (event.button === 0) controller.setFocus(target);
        }}
      >
        <text flexShrink={0} selectable={false} fg={focused ? c.accent.primary : c.fg.subtle}>
          {spec.label}
        </text>
        <box flexGrow={1} flexShrink={1} minWidth={0}>
          <TextField
            ref={ref}
            width="100%"
            placeholder={spec.placeholder}
            value={value}
            focused={focused}
            onInput={(next) =>
              target === "include" ? controller.setInclude(next) : controller.setExclude(next)
            }
          />
        </box>
      </box>
    </box>
  );
}

/** The engine's message for an invalid pattern, aligned with the field. */
export function InvalidPatternLine({ message }: { message: string }) {
  const theme = useTheme();
  return (
    <box flexShrink={0} paddingLeft={FIELD_INDENT} paddingTop={0}>
      <text fg={theme.colors.status.error} selectable={false} wrapMode="word">
        <Icon name="error" color={theme.colors.status.error} />
        {message}
      </text>
    </box>
  );
}
