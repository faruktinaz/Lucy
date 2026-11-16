/**
 * Measures a box after layout. OpenTUI calls `onSizeChange` with the renderable as `this`
 * once its computed size changes (setters run before layout, so sizes read in render are 0).
 */
import { useCallback, useState } from "react";

export interface Size {
  readonly width: number;
  readonly height: number;
}

export function useMeasure(initial: Size = { width: 0, height: 0 }): {
  size: Size;
  onSizeChange: (this: { width: number; height: number }) => void;
} {
  const [size, setSize] = useState<Size>(initial);
  const onSizeChange = useCallback(function (this: { width: number; height: number }) {
    const width = this.width;
    const height = this.height;
    setSize((previous) =>
      previous.width === width && previous.height === height ? previous : { width, height },
    );
  }, []);
  return { size, onSizeChange };
}
