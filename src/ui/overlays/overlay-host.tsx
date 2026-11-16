/**
 * Renders every floating layer above the workbench: the dimmed backdrop of modal overlays
 * (clicking it closes the top overlay), the quick pick, dialogs, the context menu and toasts.
 * Mounted once at the root so no panel's clipping can cut an overlay.
 */
import { Fragment } from "react";
import { useApp, useStore } from "@/app/react";
import { useTheme } from "../theme/theme-context";
import { withAlpha } from "../theme/ui-theme";
import { DialogOverlay } from "./dialog";
import { MenuOverlay } from "./menu";
import { QuickPickOverlay } from "./quick-pick";
import { ToastStack } from "./toasts";

export function OverlayHost({
  width,
  height,
  quickPickTop,
  toastBottom,
}: {
  width: number;
  height: number;
  /** Row of the quick pick's top border (just below the command bar). */
  quickPickTop: number;
  /** Rows between the screen bottom and the toast stack. */
  toastBottom: number;
}) {
  const app = useApp();
  const theme = useTheme();
  const layers = useStore(app.overlays.store);
  const dimmed = layers.some((layer) => layer.id === "dialog" || layer.id === "quickPick" || layer.dim);
  const catcher = layers.length > 0;
  return (
    <>
      <ToastStack width={width} bottom={toastBottom} />
      {catcher ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: an OpenTUI renderable, not a DOM element.
        <box
          position="absolute"
          left={0}
          top={0}
          width={width}
          height={height}
          zIndex={40}
          backgroundColor={dimmed ? withAlpha(theme.colors.bg.inset, 0.55) : undefined}
          onMouseDown={(event) => {
            event.stopPropagation();
            app.overlays.dismissTop();
          }}
        />
      ) : null}
      <QuickPickOverlay width={width} height={height} top={quickPickTop} />
      {layers.map((layer) =>
        layer.render ? <Fragment key={layer.id}>{layer.render({ width, height })}</Fragment> : null,
      )}
      <DialogOverlay width={width} height={height} />
      <MenuOverlay width={width} height={height} />
    </>
  );
}
