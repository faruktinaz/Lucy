/**
 * A focus zone container: clicking anywhere inside focuses the zone, and descendants learn
 * their zone through context (`useZone`, `useKeyHandler`, `useFocusTarget`).
 */
import type { RGBA } from "@opentui/core";
import type { ReactNode } from "react";
import { useApp, ZoneProvider } from "@/app/react";
import type { FocusZone } from "@/app/workbench/focus";

export interface ZoneBoxProps {
  zone: FocusZone;
  children: ReactNode;
  visible?: boolean;
  width?: number;
  height?: number;
  flexGrow?: number;
  backgroundColor?: RGBA;
}

export function ZoneBox({
  zone,
  children,
  visible = true,
  width,
  height,
  flexGrow,
  backgroundColor,
}: ZoneBoxProps) {
  const app = useApp();
  return (
    <ZoneProvider zone={zone}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: an OpenTUI renderable, not a DOM element. */}
      <box
        visible={visible}
        width={width}
        height={height}
        flexGrow={flexGrow}
        flexShrink={width === undefined && height === undefined ? 1 : 0}
        minWidth={0}
        minHeight={0}
        flexDirection="column"
        backgroundColor={backgroundColor}
        overflow="hidden"
        onMouseDown={(event) => {
          if (event.button === 0 || event.button === 2) app.focus.focus(zone);
        }}
      >
        {children}
      </box>
    </ZoneProvider>
  );
}
