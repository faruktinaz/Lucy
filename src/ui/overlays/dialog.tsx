/**
 * Confirm / prompt / alert dialogs, centered on a dimmed backdrop. The safe action has focus
 * when a confirm opens; Tab and the arrow keys move between buttons; Enter activates;
 * Escape cancels (all handled by `DialogService`).
 */
import { useApp, useStore } from "@/app/react";
import { Button } from "../primitives/button";
import { Icon } from "../primitives/icon";
import { attrs } from "../primitives/text";
import { useDensity, useTheme } from "../theme/theme-context";
import { SIZE } from "../tokens/spacing";
import { OverlayFrame } from "./overlay-frame";

export function DialogOverlay({
  width: screenWidth,
  height: screenHeight,
}: {
  width: number;
  height: number;
}) {
  const app = useApp();
  const theme = useTheme();
  const density = useDensity();
  const request = useStore(app.dialogs.store);
  if (!request) return null;
  const c = theme.colors;
  const width = Math.min(SIZE.dialogWidth, screenWidth - 4);
  const left = Math.floor((screenWidth - width) / 2);
  const top = Math.max(1, Math.floor(screenHeight * 0.28));
  return (
    <box position="absolute" left={left} top={top} zIndex={70}>
      <OverlayFrame width={width} paddingX={density.overlayPaddingX} paddingY={density.overlayPaddingY}>
        <text fg={c.fg.default} attributes={attrs({ bold: true })} selectable={false} wrapMode="word">
          {request.danger ? <Icon name="warning" color={c.status.error} /> : null}
          {request.title}
        </text>
        {request.message ? (
          <text fg={c.fg.muted} selectable={false} wrapMode="word" marginTop={1}>
            {request.message}
          </text>
        ) : null}
        {request.kind === "prompt" ? (
          <box flexDirection="column" marginTop={1} flexShrink={0}>
            <box height={1} backgroundColor={c.bg.inset} paddingX={1} flexShrink={0}>
              <input
                flexGrow={1}
                focused={request.focusIndex === -1}
                value={request.value}
                placeholder={request.placeholder}
                backgroundColor={c.bg.inset}
                focusedBackgroundColor={c.bg.inset}
                textColor={c.fg.default}
                focusedTextColor={c.fg.default}
                placeholderColor={c.fg.subtle}
                cursorColor={c.accent.primary}
                onInput={(value: string) => app.dialogs.setValue(value)}
              />
            </box>
            {request.error ? (
              <text fg={c.status.error} selectable={false} wrapMode="word">
                {request.error}
              </text>
            ) : null}
          </box>
        ) : null}
        <box flexDirection="row" justifyContent="flex-end" marginTop={1} gap={1} flexShrink={0}>
          {request.buttons.map((button, index) => (
            <Button
              key={button.id}
              label={button.label}
              variant={button.kind}
              focused={request.focusIndex === index}
              onPress={() => app.dialogs.activate(button.id)}
            />
          ))}
        </box>
      </OverlayFrame>
    </box>
  );
}
