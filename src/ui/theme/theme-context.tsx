/**
 * React access to the resolved theme. The workbench root provides the live theme from the
 * `ThemeService`; the component gallery and tests can provide any `UiTheme`.
 */
import { createContext, type ReactNode, useContext, useMemo, useSyncExternalStore } from "react";
import type { Readable } from "@/app/workbench/readable";
import { type DensityMetrics, densityMetrics } from "../tokens/spacing";
import type { UiTheme } from "./ui-theme";

const ThemeContext = createContext<UiTheme | null>(null);

export function ThemeProvider({ theme, children }: { theme: UiTheme; children: ReactNode }) {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

/** Provides the theme from a store and re-renders the tree when it changes. */
export function LiveThemeProvider({ source, children }: { source: Readable<UiTheme>; children: ReactNode }) {
  const theme = useSyncExternalStore(source.subscribe, source.get, source.get);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): UiTheme {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("useTheme() must be used inside <ThemeProvider>");
  return theme;
}

/** Spacing for the active density setting. */
export function useDensity(): DensityMetrics {
  const theme = useTheme();
  return useMemo(() => densityMetrics(theme.density), [theme.density]);
}
