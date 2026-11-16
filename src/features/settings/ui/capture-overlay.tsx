/**
 * The shortcut capture card. While it is open it takes every key (it is a modal overlay, the
 * first layer of the key router), so Ctrl+P, Ctrl+K or even Ctrl+C are recorded instead of
 * running. Escape cancels, Enter accepts a one-step shortcut, a second key makes a two-step
 * sequence. The review shows the label, what the terminal can deliver, conflicts and, for
 * reserved keys, why they cannot be used, before anything is saved.
 */
import type { AppContext } from "@/app/app-context";
import { useStore } from "@/app/react";
import type { Disposable } from "@/core/events";
import { normalizeKey } from "@/core/keybindings";
import type { KeyStroke } from "@/core/keybindings/key-stroke";
import { Store } from "@/core/store";
import { icon } from "@/themes/icons";
import { OverlayFrame } from "@/ui/overlays/overlay-frame";
import { Button } from "@/ui/primitives/button";
import { attrs } from "@/ui/primitives/text";
import { useDensity, useTheme } from "@/ui/theme/theme-context";
import { SIZE } from "@/ui/tokens/spacing";
import type { CaptureState, KeybindingsViewModel } from "../model/keybindings-view-model";
import { HintLine, KeyChip } from "./shared";
import { wrapText } from "./text-layout";

type ReviewButton = "retry" | "cancel" | "save" | "replace";

interface CaptureUi {
  /** Focused button index in the review. */
  readonly button: number;
}

function reviewButtons(capture: CaptureState): ReviewButton[] {
  if (capture.phase !== "review") return [];
  if (capture.refusal) return ["retry", "cancel"];
  if (capture.conflicts.some((c) => c.kind === "same")) return ["cancel", "save", "replace"];
  return ["retry", "cancel", "save"];
}

const BUTTON_LABEL: Record<ReviewButton, string> = {
  retry: "Try Again",
  cancel: "Cancel",
  save: "Save",
  replace: "Replace",
};

function defaultButton(capture: CaptureState): number {
  const buttons = reviewButtons(capture);
  const preferred: ReviewButton = buttons.includes("replace")
    ? "replace"
    : buttons.includes("save")
      ? "save"
      : "retry";
  return Math.max(0, buttons.indexOf(preferred));
}

function CaptureCard({
  vm,
  ui,
  width: screenWidth,
  height: screenHeight,
  onButton,
}: {
  vm: KeybindingsViewModel;
  ui: Store<CaptureUi>;
  width: number;
  height: number;
  onButton: (button: ReviewButton) => void;
}) {
  const theme = useTheme();
  const density = useDensity();
  const c = theme.colors;
  const capture = useStore(vm.store, (state) => state.capture);
  const { button } = useStore(ui);
  if (capture.phase === "idle") return null;
  const width = Math.min(SIZE.dialogWidth + 4, screenWidth - 4);
  const inner = width - 2 - density.overlayPaddingX * 2;
  const left = Math.floor((screenWidth - width) / 2);
  const top = Math.max(1, Math.floor(screenHeight * 0.24));
  const title = capture.replacing ? "Change Shortcut" : "Add Shortcut";
  const lines = (text: string) => wrapText(text, inner);

  const keyLine =
    capture.phase === "capturing" ? (
      capture.steps.length === 0 ? (
        <text selectable={false} fg={c.fg.subtle}>
          <span bg={c.bg.inset} fg={c.fg.subtle}>
            {"  Waiting for keys…  "}
          </span>
        </text>
      ) : (
        <text selectable={false}>
          <KeyChip label={capture.label} />
          <span fg={c.fg.subtle}>{"  …"}</span>
        </text>
      )
    ) : (
      <text selectable={false}>
        <KeyChip label={capture.label} />
      </text>
    );

  const messages: { key: string; tone: "error" | "warning" | "muted"; text: string }[] = [];
  if (capture.phase === "review") {
    if (capture.refusal) messages.push({ key: "refusal", tone: "error", text: capture.refusal });
    for (const conflict of capture.conflicts) {
      messages.push({
        key: `conflict-${conflict.command}`,
        tone: "warning",
        text:
          conflict.kind === "same"
            ? `${conflict.label} already runs "${conflict.title}". Replace takes it away from that command; Save keeps both and yours wins.`
            : `${conflict.label} starts or completes the shortcut of "${conflict.title}", so one of them waits for a second key.`,
      });
    }
    if (capture.warning && !capture.refusal)
      messages.push({ key: "warning", tone: "warning", text: capture.warning });
    if (messages.length === 0)
      messages.push({
        key: "ok",
        tone: "muted",
        text: "No conflicts. This shortcut works in this terminal.",
      });
  }

  const buttons = reviewButtons(capture);
  return (
    // A solid backing, so the row under the frame's border never shows through it.
    <box position="absolute" left={left} top={top} zIndex={65} backgroundColor={c.bg.overlay}>
      <OverlayFrame
        width={width}
        title={` ${title} `}
        paddingX={density.overlayPaddingX}
        paddingY={density.overlayPaddingY}
      >
        <text selectable={false} fg={c.fg.default} attributes={attrs({ bold: true })} wrapMode="none">
          {capture.title}
        </text>
        <text selectable={false} fg={c.fg.muted} wrapMode="word">
          {capture.phase === "capturing"
            ? "Press the desired key combination."
            : "Review the shortcut before saving it."}
        </text>
        <box height={1} flexShrink={0} />
        <box height={1} flexShrink={0} flexDirection="row" justifyContent="center">
          {keyLine}
        </box>
        <box height={1} flexShrink={0} />
        {capture.phase === "capturing" ? (
          <box flexDirection="column" flexShrink={0}>
            {lines(capture.hint).map((line) => (
              <text key={line} selectable={false} fg={c.fg.subtle} wrapMode="none">
                {line}
              </text>
            ))}
            <box height={1} flexShrink={0} />
            <HintLine
              items={[
                ...(capture.steps.length > 0 ? [{ keys: "Enter", label: "use it" }] : []),
                { keys: "Esc", label: "cancel" },
              ]}
            />
          </box>
        ) : (
          <box flexDirection="column" flexShrink={0}>
            {messages.flatMap((message) =>
              // Two cells narrower: warnings and errors start with an icon.
              wrapText(message.text, message.tone === "muted" ? inner : inner - 2).map((line, index) => (
                <text
                  key={`${message.key}-${line}`}
                  selectable={false}
                  wrapMode="none"
                  fg={
                    message.tone === "error"
                      ? c.status.error
                      : message.tone === "warning"
                        ? c.status.warning
                        : c.fg.muted
                  }
                >
                  {index === 0 && message.tone !== "muted"
                    ? `${icon(message.tone === "error" ? "error" : "warning", theme.icons)} ${line}`
                    : message.tone !== "muted"
                      ? `  ${line}`
                      : line}
                </text>
              )),
            )}
            <box height={1} flexShrink={0} />
            <box flexDirection="row" justifyContent="flex-end" gap={1} flexShrink={0}>
              {buttons.map((id, index) => (
                <Button
                  key={id}
                  label={BUTTON_LABEL[id]}
                  variant={id === "replace" || id === "save" ? "primary" : "ghost"}
                  focused={index === button}
                  onPress={() => onButton(id)}
                />
              ))}
            </box>
          </box>
        )}
      </OverlayFrame>
    </box>
  );
}

/**
 * Opens the capture card for `command` (adding a shortcut, or replacing `replace`). Resolves
 * when the card closes, with whether a shortcut was saved.
 */
export function openCaptureOverlay(
  ctx: AppContext,
  vm: KeybindingsViewModel,
  command: string,
  replace?: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const ui = new Store<CaptureUi>({ button: 0 });
    let layer: Disposable | null = null;
    let saved = false;
    let busy = false;

    const close = () => {
      subscription();
      layer?.dispose();
      layer = null;
      resolve(saved);
    };
    const restart = () => {
      vm.beginCapture(command, { replace });
      ui.set({ button: 0 });
    };
    const press = async (button: ReviewButton) => {
      if (busy) return;
      if (button === "cancel") {
        vm.cancel();
        return;
      }
      if (button === "retry") {
        restart();
        return;
      }
      busy = true;
      try {
        saved = await vm.confirm({ replaceConflicts: button === "replace" });
      } finally {
        busy = false;
      }
    };
    let lastPhase = vm.state.capture.phase;
    const subscription = vm.store.subscribe(() => {
      const capture = vm.state.capture;
      if (capture.phase === "idle") {
        close();
        return;
      }
      if (capture.phase === "review" && lastPhase !== "review") ui.set({ button: defaultButton(capture) });
      lastPhase = capture.phase;
    });

    const handleKey = (stroke: KeyStroke): boolean => {
      const capture = vm.state.capture;
      if (capture.phase === "capturing") {
        vm.captureStroke(stroke);
        return true;
      }
      if (capture.phase !== "review") return true;
      const key = normalizeKey(stroke.key) ?? stroke.key;
      const buttons = reviewButtons(capture);
      const plain = !stroke.ctrl && !stroke.alt && !stroke.super;
      if (key === "escape") vm.cancel();
      else if (key === "enter" && plain) {
        const button = buttons[ui.get().button];
        if (button) void press(button);
      } else if (key === "tab" || key === "right") {
        const delta = key === "tab" && stroke.shift ? -1 : 1;
        ui.set({ button: (ui.get().button + delta + buttons.length) % buttons.length });
      } else if (key === "left") {
        ui.set({ button: (ui.get().button - 1 + buttons.length) % buttons.length });
      } else if (key === "backspace" && plain) restart();
      return true;
    };

    vm.beginCapture(command, { replace });
    layer = ctx.overlays.push({
      id: "keybindingCapture",
      modal: true,
      dim: true,
      handleKey,
      dismiss: () => vm.cancel(),
      render: ({ width, height }) => (
        <CaptureCard
          vm={vm}
          ui={ui}
          width={width}
          height={height}
          onButton={(button) => void press(button)}
        />
      ),
    });
  });
}
