import { useApp, useStore } from "@/app/react";
import type { SettingPath, SettingValue } from "@/core/config";

/** A setting's current value; the component re-renders when it changes. */
export function useSetting<P extends SettingPath>(path: P): SettingValue<P> {
  const app = useApp();
  return useStore(app.config.store, () => app.config.get(path));
}
