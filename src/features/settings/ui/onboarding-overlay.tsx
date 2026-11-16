/**
 * The first-run setup card, over the live workbench (no dimming, so the theme step previews
 * the real UI). It walks through the OnboardingModel's steps: theme, icons, keyboard,
 * external editor, Claude Code, summary. Nothing is written until Finish; Skip (or Escape)
 * writes nothing and remembers that setup was offered. "Run Setup" opens it again.
 *
 * Keys: Up/Down choose an option, Enter or Right goes on (Enter on the summary finishes),
 * Left or Backspace goes back, Escape skips. Everything is also clickable.
 */

import { CLAUDE_PROVIDER_ID } from "@/adapters/agents";
import { detectEditors } from "@/adapters/editor";
import type { AppContext } from "@/app/app-context";
import { useStore } from "@/app/react";
import { type Disposable, toDisposable } from "@/core/events";
import { normalizeKey } from "@/core/keybindings";
import type { KeyStroke } from "@/core/keybindings/key-stroke";
import { tildify } from "@/core/paths";
import { Store } from "@/core/store";
import { sanitizeForDisplay, truncateEnd, truncateMiddle } from "@/core/text";
import { icon } from "@/themes/icons";
import { THEME_IDS } from "@/themes/ids";
import { OverlayFrame } from "@/ui/overlays/overlay-frame";
import { Button } from "@/ui/primitives/button";
import { Spinner } from "@/ui/primitives/spinner";
import { attrs } from "@/ui/primitives/text";
import { usePointer } from "@/ui/primitives/use-pointer";
import { useDensity, useTheme } from "@/ui/theme/theme-context";
import {
  type EditorCandidate,
  type EditorChoice,
  ONBOARDING_STEPS,
  OnboardingModel,
  type OnboardingState,
  type OnboardingStep,
} from "../model/onboarding-model";
import type { SettingsServices } from "../services";
import { HintLine } from "./shared";
import { wrapText } from "./text-layout";

const STEP_HEADINGS: Record<OnboardingStep, string> = {
  theme: "Pick a color theme",
  icons: "Check the icons",
  keyboard: "Your keyboard",
  editor: "Choose an editor",
  ai: "Claude Code",
  summary: "Ready to go",
};

const STEP_TITLES: Record<OnboardingStep, string> = {
  theme: "Theme",
  icons: "Icons",
  keyboard: "Keyboard",
  editor: "Editor",
  ai: "Claude Code",
  summary: "Summary",
};

const THEME_NOTES: Record<string, string> = {
  "catppuccin-mocha": "soft pastels",
  "tokyo-night": "cool blues",
  "gruvbox-dark": "warm retro",
  "high-contrast": "maximum legibility",
};

interface OnboardingUi {
  /** Highlighted option on steps with options. */
  readonly option: number;
}

/** Options a step offers (theme ids, the two icon answers, editors). */
function optionCount(state: OnboardingState): number {
  if (state.step === "theme") return state.themes.length;
  if (state.step === "icons") return 2;
  if (state.step === "editor") return 1 + (state.editors.status === "ready" ? state.editors.value.length : 0);
  return 0;
}

function editorValue(state: OnboardingState, index: number): EditorChoice {
  if (index === 0 || state.editors.status !== "ready") return "auto";
  return state.editors.value[index - 1]?.id ?? "auto";
}

/** The highlighted option that matches the current choice of a step. */
function optionForChoice(state: OnboardingState): number {
  if (state.step === "theme")
    return Math.max(
      0,
      state.themes.findIndex((t) => t.id === state.choices.theme),
    );
  if (state.step === "icons") return state.choices.nerdFontRenders === false ? 1 : 0;
  if (
    state.step === "editor" &&
    state.editors.status === "ready" &&
    typeof state.choices.editor === "string"
  ) {
    const index = state.editors.value.findIndex((e) => e.id === state.choices.editor);
    return index >= 0 ? index + 1 : 0;
  }
  return 0;
}

function OptionRow({
  label,
  detail,
  highlighted,
  chosen,
  onPress,
}: {
  label: string;
  detail?: string;
  highlighted: boolean;
  chosen: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const c = theme.colors;
  const pointer = usePointer({ onClick: onPress });
  const bg = highlighted ? c.state.selectedBg : pointer.hovered ? c.state.hover : undefined;
  const fg = highlighted ? c.state.selectedFg : c.fg.default;
  return (
    <box height={1} flexShrink={0} flexDirection="row" backgroundColor={bg} paddingX={1} {...pointer.props}>
      <text selectable={false} wrapMode="none" flexGrow={1} flexShrink={1}>
        <span fg={highlighted ? c.accent.primary : c.fg.subtle}>
          {highlighted ? `${icon("chevronRight", theme.icons)} ` : "  "}
        </span>
        <span fg={fg} attributes={attrs({ bold: highlighted && theme.highContrast })}>
          {label}
        </span>
        {detail ? <span fg={highlighted ? c.fg.muted : c.fg.subtle}>{`  ${detail}`}</span> : null}
      </text>
      {chosen ? (
        <text selectable={false} flexShrink={0} fg={highlighted ? c.state.selectedFg : c.status.success}>
          {icon("check", theme.icons)}
        </text>
      ) : null}
    </box>
  );
}

function Paragraph({
  text,
  width,
  tone = "muted",
}: {
  text: string;
  width: number;
  tone?: "muted" | "default" | "subtle";
}) {
  const theme = useTheme();
  const c = theme.colors;
  const fg = tone === "default" ? c.fg.default : tone === "subtle" ? c.fg.subtle : c.fg.muted;
  return (
    <box flexDirection="column" flexShrink={0}>
      {wrapText(text, width).map((line) => (
        <text key={line} selectable={false} wrapMode="none" fg={fg}>
          {line}
        </text>
      ))}
    </box>
  );
}

function StepBody({
  state,
  ui,
  width,
  onOption,
}: {
  state: OnboardingState;
  ui: OnboardingUi;
  width: number;
  onOption: (index: number) => void;
}) {
  const theme = useTheme();
  const c = theme.colors;
  switch (state.step) {
    case "theme":
      return (
        <>
          <Paragraph
            text="Choose a color theme. The workspace behind this card changes as you move."
            width={width}
          />
          <box height={1} flexShrink={0} />
          {state.themes.map((option, index) => (
            <OptionRow
              key={option.id}
              label={option.name}
              detail={THEME_NOTES[option.id]}
              highlighted={index === ui.option}
              chosen={option.id === state.choices.theme}
              onPress={() => onOption(index)}
            />
          ))}
        </>
      );
    case "icons":
      return (
        <>
          <Paragraph text="Do these look like icons? They need a Nerd Font in your terminal." width={width} />
          <box height={1} flexShrink={0} />
          <box height={1} flexShrink={0} flexDirection="row" justifyContent="center">
            <text selectable={false} fg={c.fg.default}>
              {state.iconSamples.map((sample) => sample.glyph).join("   ")}
            </text>
          </box>
          <box height={1} flexShrink={0} />
          <OptionRow
            label="Yes, they look like icons"
            detail="use Nerd Font icons"
            highlighted={ui.option === 0}
            chosen={state.choices.nerdFontRenders === true}
            onPress={() => onOption(0)}
          />
          <OptionRow
            label="No, I see boxes or question marks"
            detail="use plain symbols"
            highlighted={ui.option === 1}
            chosen={state.choices.nerdFontRenders === false}
            onPress={() => onOption(1)}
          />
        </>
      );
    case "keyboard":
      return (
        <>
          <text
            selectable={false}
            wrapMode="none"
            fg={state.keyboard.kittyKeyboard ? c.status.success : c.status.info}
          >
            {`${icon(state.keyboard.kittyKeyboard ? "check" : "info", theme.icons)} `}
            <span fg={c.fg.default}>
              {state.keyboard.kittyKeyboard ? "Full keyboard support" : "Classic keyboard input"}
            </span>
          </text>
          <box height={1} flexShrink={0} />
          <Paragraph text={state.keyboard.explanation} width={width} />
        </>
      );
    case "editor": {
      const editors: readonly EditorCandidate[] = state.editors.status === "ready" ? state.editors.value : [];
      return (
        <>
          <Paragraph
            text="Lucy shows code itself and opens an external terminal editor to edit files."
            width={width}
          />
          <box height={1} flexShrink={0} />
          <OptionRow
            label="Automatic"
            detail="$VISUAL, $EDITOR, then the first editor found"
            highlighted={ui.option === 0}
            chosen={state.choices.editor === "auto"}
            onPress={() => onOption(0)}
          />
          {editors.map((editor, index) => (
            <OptionRow
              key={editor.id}
              label={editor.label}
              detail={truncateMiddle(tildify(editor.path), Math.max(10, width - editor.label.length - 8))}
              highlighted={ui.option === index + 1}
              chosen={state.choices.editor === editor.id}
              onPress={() => onOption(index + 1)}
            />
          ))}
          {state.editors.status === "loading" ? (
            <box paddingX={1} flexShrink={0}>
              <text selectable={false} fg={c.fg.muted}>
                <Spinner active label="Looking for editors" />
              </text>
            </box>
          ) : null}
          {state.editors.status === "ready" && editors.length === 0 ? (
            <box paddingX={1} flexShrink={0}>
              <text selectable={false} fg={c.fg.subtle}>
                No terminal editor was found on PATH. Automatic uses $EDITOR when it is set.
              </text>
            </box>
          ) : null}
          {state.editors.status === "error" ? (
            <box paddingX={1} flexShrink={0}>
              <text selectable={false} fg={c.status.warning}>
                {`${icon("warning", theme.icons)} Could not look for editors: ${state.editors.error}`}
              </text>
            </box>
          ) : null}
        </>
      );
    }
    case "ai": {
      const ai = state.ai;
      let status: { tone: "success" | "warning" | "muted"; text: string; detail?: string };
      if (ai.status === "loading") status = { tone: "muted", text: "Looking for Claude Code…" };
      else if (ai.status === "error")
        status = { tone: "warning", text: "Could not check for Claude Code", detail: ai.error };
      else if (ai.value.found) {
        status = {
          tone: "success",
          text: `Claude Code${ai.value.version ? ` ${ai.value.version}` : ""}`,
          detail: ai.value.path ? tildify(ai.value.path) : undefined,
        };
      } else {
        status = {
          tone: "warning",
          text: "Claude Code was not found",
          detail:
            ai.value.error ??
            "Install it, or set its path later in Settings. Everything else works without it.",
        };
      }
      const color =
        status.tone === "success"
          ? c.status.success
          : status.tone === "warning"
            ? c.status.warning
            : c.fg.muted;
      return (
        <>
          <text selectable={false} wrapMode="none" fg={color}>
            {ai.status === "loading" ? (
              <Spinner active />
            ) : (
              `${icon(status.tone === "success" ? "check" : "warning", theme.icons)} `
            )}
            <span fg={c.fg.default}>{status.text}</span>
          </text>
          {status.detail ? (
            <Paragraph text={sanitizeForDisplay(status.detail)} width={width - 2} tone="subtle" />
          ) : null}
          <box height={1} flexShrink={0} />
          <Paragraph text={state.aiStatement} width={width} />
        </>
      );
    }
    case "summary": {
      const entries = state.summary.entries;
      return (
        <>
          <Paragraph
            text={
              entries.length === 0
                ? "Nothing to change: the defaults match your choices, so no file is written."
                : `These settings will be saved in ${state.summary.filePath}:`
            }
            width={width}
          />
          <box height={1} flexShrink={0} />
          {entries.map((entry) => (
            <box key={entry.path} height={1} flexShrink={0} flexDirection="row" paddingX={1}>
              <text
                selectable={false}
                wrapMode="none"
                fg={c.fg.default}
                width={Math.min(24, Math.floor(width / 2))}
                flexShrink={0}
              >
                {truncateEnd(entry.title, Math.min(22, Math.floor(width / 2) - 2))}
              </text>
              <text selectable={false} wrapMode="none" fg={c.accent.primary} flexGrow={1} flexShrink={1}>
                {truncateEnd(entry.valueLabel, Math.max(6, width - 26 - entry.configKey.length))}
                <span fg={c.fg.subtle}>{`  ${entry.configKey}`}</span>
              </text>
            </box>
          ))}
          {entries.length > 0 ? <box height={1} flexShrink={0} /> : null}
          <Paragraph
            text="Change any of this later in Settings, or run Setup again from the command palette."
            width={width}
            tone="subtle"
          />
          {state.error ? (
            <text selectable={false} fg={c.status.error} wrapMode="word">
              {`${icon("error", theme.icons)} ${state.error}`}
            </text>
          ) : null}
        </>
      );
    }
  }
}

function Progress({ state, width }: { state: OnboardingState; width: number }) {
  const theme = useTheme();
  const c = theme.colors;
  const separator = ` ${icon("chevronRight", theme.icons)} `;
  const full = ONBOARDING_STEPS.map((s) => STEP_TITLES[s]).join(separator);
  // Narrow cards show only the current step and the count.
  if (full.length > width) {
    return (
      <text selectable={false} wrapMode="none">
        <span fg={c.accent.primary} attributes={attrs({ bold: true })}>
          {STEP_TITLES[state.step]}
        </span>
        <span fg={c.fg.subtle}>{`  ${state.stepIndex + 1} of ${state.stepCount}`}</span>
      </text>
    );
  }
  return (
    <text selectable={false} wrapMode="none">
      {ONBOARDING_STEPS.map((step, index) => (
        <span key={step}>
          {index > 0 ? <span fg={c.fg.subtle}>{separator}</span> : null}
          <span
            fg={
              index === state.stepIndex
                ? c.accent.primary
                : index < state.stepIndex
                  ? c.fg.muted
                  : c.fg.subtle
            }
            attributes={attrs({ bold: index === state.stepIndex })}
          >
            {STEP_TITLES[step]}
          </span>
        </span>
      ))}
    </text>
  );
}

function OnboardingCard({
  model,
  ui,
  width: screenWidth,
  height: screenHeight,
  actions,
}: {
  model: OnboardingModel;
  ui: Store<OnboardingUi>;
  width: number;
  height: number;
  actions: { next: () => void; back: () => void; skip: () => void; option: (index: number) => void };
}) {
  const theme = useTheme();
  const density = useDensity();
  const c = theme.colors;
  const state = useStore(model.store);
  const uiState = useStore(ui);
  const width = Math.min(68, screenWidth - 4);
  const inner = width - 2 - density.overlayPaddingX * 2;
  const left = Math.floor((screenWidth - width) / 2);
  const top = Math.max(1, Math.floor((screenHeight - 22) / 2));
  const finishing = state.status === "finishing";
  const last = state.step === "summary";
  return (
    // A solid backing: without a dimmed backdrop the frame's border cells would show the
    // workbench through them (the theme step keeps the workbench visible around the card).
    <box position="absolute" left={left} top={top} zIndex={66} backgroundColor={c.bg.overlay}>
      <OverlayFrame
        width={width}
        title=" Set up Lucy "
        paddingX={density.overlayPaddingX}
        paddingY={density.overlayPaddingY}
      >
        <Progress state={state} width={inner} />
        <box height={1} flexShrink={0} />
        <text selectable={false} fg={c.fg.default} attributes={attrs({ bold: true })}>
          {STEP_HEADINGS[state.step]}
        </text>
        <StepBody state={state} ui={uiState} width={inner} onOption={actions.option} />
        <box height={1} flexShrink={0} />
        <box flexDirection="row" flexShrink={0} alignItems="center">
          <box flexGrow={1} flexShrink={1}>
            <HintLine
              items={
                inner >= 56
                  ? [
                      ...(optionCount(state) > 0 ? [{ keys: "↑↓", label: "choose" }] : []),
                      { keys: "Esc", label: "skip" },
                    ]
                  : [{ keys: "Esc", label: "skip" }]
              }
            />
          </box>
          <box flexDirection="row" gap={1} flexShrink={0}>
            <Button label="Skip" variant="ghost" onPress={actions.skip} disabled={finishing} />
            <Button
              label="Back"
              variant="ghost"
              onPress={actions.back}
              disabled={!state.canGoBack || finishing}
            />
            <Button
              label={last ? "Finish" : "Next"}
              variant="primary"
              focused
              disabled={finishing || (!last && !state.canGoNext)}
              onPress={actions.next}
            />
          </box>
        </box>
      </OverlayFrame>
    </box>
  );
}

function editorCandidates(env: Record<string, string | undefined>): EditorCandidate[] {
  return detectEditors(env).installed.map((editor) => ({
    id: editor.id,
    label: editor.displayName,
    path: editor.program,
  }));
}

/**
 * Opens the setup card. A second call while it is open does nothing. Resolves when it closes.
 */
export function startOnboarding(ctx: AppContext, services: SettingsServices): Promise<void> {
  if (services.onboarding.get()) return Promise.resolve();
  return new Promise((resolve) => {
    const model = new OnboardingModel({
      config: ctx.config,
      dirs: ctx.dirs,
      kittyKeyboard: services.support().kittyKeyboard,
      platform: ctx.env.platform,
      detectEditors: async () => editorCandidates(services.environment.env),
      ai: {
        detect: async () => {
          const provider = ctx.services.agents.provider(CLAUDE_PROVIDER_ID);
          if (!provider) return { found: false };
          const detection = await provider.detect();
          return {
            found: detection.available,
            path: detection.executable ?? undefined,
            version: detection.version ?? undefined,
            error: detection.problem ?? undefined,
          };
        },
      },
    });
    services.onboarding.set(model);
    const ui = new Store<OnboardingUi>({ option: optionForChoice(model.state) });
    let layer: Disposable | null = null;

    // Each step starts on the option matching the current choice.
    let lastStep = model.state.step;
    let lastEditors = model.state.editors.status;
    const subscription = toDisposable(
      model.store.subscribe(() => {
        const state = model.state;
        if (state.step !== lastStep || state.editors.status !== lastEditors) {
          lastStep = state.step;
          lastEditors = state.editors.status;
          ui.set({ option: optionForChoice(state) });
        }
        if (state.status === "finished" || state.status === "skipped") close(state.status);
      }),
    );

    const close = (outcome: "finished" | "skipped" | "abandoned") => {
      subscription.dispose();
      layer?.dispose();
      layer = null;
      services.onboarding.set(null);
      model.dispose();
      if (outcome === "finished") {
        const written = model.state.summary.entries.length;
        ctx.notifications.success(
          "Lucy is set up",
          written > 0
            ? "Your choices were saved. Change them any time in Settings."
            : "The defaults fit; nothing was written.",
        );
      } else if (outcome === "skipped") {
        ctx.notifications.info("Setup skipped", "Run Setup from the command palette whenever you like.");
      }
      resolve();
    };

    const choose = (index: number) => {
      const state = model.state;
      ui.set({ option: index });
      if (state.step === "theme") {
        const theme = state.themes[index];
        if (theme && THEME_IDS.includes(theme.id)) void model.chooseTheme(theme.id);
      } else if (state.step === "icons") model.answerNerdFont(index === 0);
      else if (state.step === "editor") model.chooseEditor(editorValue(state, index));
    };

    const actions = {
      next: () => {
        if (model.state.step === "summary") void model.finish();
        else {
          // Enter on an option step confirms the highlighted option first.
          if (optionCount(model.state) > 0 && model.state.step !== "theme") choose(ui.get().option);
          model.next();
        }
      },
      back: () => void model.back(),
      skip: () => void model.skip(),
      option: (index: number) => choose(index),
    };

    const handleKey = (stroke: KeyStroke): boolean => {
      if (model.state.status !== "active") return true;
      const key = normalizeKey(stroke.key) ?? stroke.key;
      const count = optionCount(model.state);
      if (key === "up" && count > 0) choose(Math.max(0, ui.get().option - 1));
      else if (key === "down" && count > 0) choose(Math.min(count - 1, ui.get().option + 1));
      else if (key === "enter" || key === "right" || (key === "tab" && !stroke.shift)) actions.next();
      else if (key === "left" || key === "backspace" || (key === "tab" && stroke.shift)) actions.back();
      else if (key === "escape") actions.skip();
      return true;
    };

    layer = ctx.overlays.push({
      id: "onboarding",
      modal: true,
      // No dimming: the theme step previews the real workbench behind the card.
      dim: false,
      handleKey,
      // A click outside the card must not throw the user's choices away.
      dismiss: () => {},
      render: ({ width, height }) => (
        <OnboardingCard model={model} ui={ui} width={width} height={height} actions={actions} />
      ),
    });
    void model.start();
  });
}
